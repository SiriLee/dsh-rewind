/**
 * Unit tests for the change ledger (src/ledger.ts) against a fake fs backend.
 */
import { Context } from '@deepseek-ai/cordis'
import { FileSystem, FsTargetKey, FsVersion } from '@deepseek-ai/dsh-fs'
import type { FsEditOutcome, FsInfo, FsTarget, FsWriteOutcome } from '@deepseek-ai/dsh-fs'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { RewindLedger, MAX_LEDGER_ENTRIES } from '../src/ledger.ts'

/** Minimal in-memory FileSystem double implementing only what restore uses. */
class FakeFs extends FileSystem {
  files = new Map<string, string>()

  override async resolve(path: string, opts?: { cwd?: string }): Promise<FsTarget> {
    const displayPath = opts?.cwd !== undefined && !path.startsWith('/') ? join(opts.cwd, path) : path
    return { targetKey: FsTargetKey(displayPath), displayPath }
  }

  override processPath(target: FsTarget): string {
    return target.displayPath
  }

  override fileUrl(target: FsTarget): string {
    return `file://${target.displayPath}`
  }

  override contains(parent: FsTarget, child: FsTarget): boolean {
    return child.displayPath.startsWith(parent.displayPath)
  }

  override async stat(target: FsTarget): Promise<FsInfo | undefined> {
    const content = this.files.get(target.displayPath)
    return content === undefined
      ? undefined
      : { version: FsVersion('v'), type: 'file', size: content.length }
  }

  override async lstat(): Promise<undefined> {
    return undefined
  }

  override async readText(target: FsTarget): Promise<string> {
    const content = this.files.get(target.displayPath)
    if (content === undefined) {
      throw Object.assign(new Error(`no such file: ${target.displayPath}`), { code: 'ENOENT' })
    }
    return content
  }

  override async streamText(target: FsTarget): Promise<AsyncIterable<string>> {
    const read = (): Promise<string> => this.readText(target)
    return {
      async *[Symbol.asyncIterator]() {
        yield await read()
      },
    }
  }

  override async readBytes(): Promise<Uint8Array> {
    return new Uint8Array()
  }

  override async listDir(): Promise<[]> {
    return []
  }

  override async writeText(target: FsTarget, content: string): Promise<FsWriteOutcome> {
    this.files.set(target.displayPath, content)
    return { operation: 'update', version: FsVersion('v'), before: null, after: content }
  }

  override async editText(): Promise<FsEditOutcome> {
    throw new Error('not used')
  }
}

function entry(
  toolName: 'write' | 'edit' | 'str_replace_editor',
  anchorSeq: number,
  path: string,
  before: string | undefined,
  after: string,
) {
  return { toolName, anchorSeq, path, before, after }
}

describe('RewindLedger', () => {
  it('records and lists entries anchored at or after a target, newest first', () => {
    const ledger = new RewindLedger()
    ledger.record(entry('write', 0, '/a.txt', undefined, 'new'))
    ledger.record(entry('edit', 2, '/a.txt', 'new', 'edited'))
    ledger.record(entry('write', 4, '/b.txt', 'old', 'changed'))

    // Rewinding to seq 2 reverts the target turn's own changes too (>=).
    expect(ledger.changesAfter(2).map(e => e.path)).toEqual(['/b.txt', '/a.txt'])
    expect(ledger.changesAfter(4).map(e => e.path)).toEqual(['/b.txt'])
    expect(ledger.changesAfter(6)).toEqual([])
  })

  it('summarizes unique file impacts (create -> delete, edit -> restore)', () => {
    const ledger = new RewindLedger()
    ledger.record(entry('write', 0, '/created.txt', undefined, 'content'))
    ledger.record(entry('edit', 0, '/created.txt', 'content', 'content2'))
    ledger.record(entry('edit', 2, '/edited.txt', 'before', 'after'))

    expect(ledger.impactsAfter(0)).toEqual([
      { path: '/created.txt', action: 'delete' },
      { path: '/edited.txt', action: 'restore' },
    ])
  })

  it('restores edits and deletes created files in reverse order', async () => {
    const fs = new FakeFs(new Context())
    fs.files.set('/a.txt', 'final')       // existed before, edited twice
    fs.files.set('/b.txt', 'created')     // created by a later turn
    const ledger = new RewindLedger()
    ledger.record(entry('edit', 0, '/a.txt', 'original', 'first'))
    ledger.record(entry('edit', 2, '/a.txt', 'first', 'final'))
    ledger.record(entry('write', 4, '/b.txt', undefined, 'created'))

    const deleted: string[] = []
    const outcome = await ledger.restoreAfter(fs, async path => { deleted.push(path) }, 0)

    expect(outcome.restored).toEqual(['/a.txt'])
    expect(outcome.deleted).toEqual(['/b.txt'])
    expect(outcome.failed).toEqual([])
    expect(fs.files.get('/a.txt')).toBe('original')
    expect(deleted).toEqual(['/b.txt'])
  })

  it('continues past per-file failures and reports them', async () => {
    const fs = new FakeFs(new Context())
    fs.files.set('/good.txt', 'changed')
    fs.files.set('/bad.txt', 'changed')
    const ledger = new RewindLedger()
    ledger.record(entry('write', 2, '/good.txt', 'before', 'changed'))
    ledger.record(entry('write', 2, '/bad.txt', 'before', 'changed'))

    const spy = vi.spyOn(fs, 'writeText').mockImplementation(async (target) => {
      if (target.displayPath === '/bad.txt') throw new Error('disk full')
      return { operation: 'update', version: FsVersion('v'), before: null, after: '' }
    })
    const outcome = await ledger.restoreAfter(fs, async () => {}, 1)

    expect(outcome.restored).toEqual(['/good.txt'])
    expect(outcome.failed).toEqual([{ path: '/bad.txt', message: 'disk full' }])
    spy.mockRestore()
  })

  it('restores relative paths against the session cwd', async () => {
    const fs = new FakeFs(new Context())
    fs.files.set('/workspace/rel.txt', 'new content')
    const ledger = new RewindLedger()
    ledger.record(entry('write', 2, 'rel.txt', 'original', 'new content'))

    const outcome = await ledger.restoreAfter(fs, async () => {}, 0, { cwd: '/workspace' })

    expect(outcome.restored).toEqual(['rel.txt'])
    expect(fs.files.get('/workspace/rel.txt')).toBe('original')
    expect(fs.files.has('rel.txt')).toBe(false) // never resolved at the process cwd
  })

  it('caps the per-session entry list, dropping the oldest entries first', () => {
    const ledger = new RewindLedger()
    for (let i = 0; i < MAX_LEDGER_ENTRIES + 50; i += 1) {
      ledger.record(entry('write', i, `/f${i}.txt`, undefined, 'x'))
    }
    expect(ledger.changesAfter(0)).toHaveLength(MAX_LEDGER_ENTRIES)
    // The 50 oldest entries were evicted: the earliest surviving anchor is 50.
    expect(ledger.changesAfter(0).at(-1)!.anchorSeq).toBe(50)
  })

  it('records the marker-tool writes as regular entries too', () => {
    const ledger = new RewindLedger()
    ledger.record(entry('str_replace_editor', 0, '/x.ts', 'a', 'b'))
    expect(ledger.changesAfter(0)[0]!.toolName).toBe('str_replace_editor')
  })
})
