/**
 * Command-face takeover probes: the commands leave the catalog on takeover, a
 * permission restores them, and every refusal resolves to null.
 */
import { describe, expect, it } from 'vitest'
import type { CommandContribution } from '@deepseek-ai/dsh-client-ui-commands/client'
import { createCommandFace, type CommandFace, type CommandTakeoverPermission } from '../src/client/command-takeover.ts'
import type { UiOwner } from '../src/client/claim.ts'

/** One minimal client contribution; the face only reads its name. */
function contribution(name: string): CommandContribution {
  return {
    name,
    available: () => true,
    ui: { kind: 'action', run: () => {} },
  }
}

/** Take the face over, asserting a permission was granted. */
async function granted(face: CommandFace): Promise<CommandTakeoverPermission> {
  const permission = await face.service.commands.takeover()
  expect(permission).not.toBeNull()
  return permission!
}

/** A face over a registry that behaves like `commandUi.register`. */
function makeFace(options: { readonly owner?: UiOwner; readonly refuse?: string; readonly failDispose?: string } = {}) {
  const registered = new Map<string, CommandContribution>()
  const dismissed: string[] = []
  const face: CommandFace = createCommandFace({
    contributions: [contribution('rewind'), contribution('undo')],
    register: (entry) => {
      if (entry.name === options.refuse) throw new Error(`duplicate contribution for /${entry.name}`)
      if (registered.has(entry.name)) throw new Error(`duplicate contribution for /${entry.name}`)
      registered.set(entry.name, entry)
      return () => {
        if (entry.name === options.failDispose) throw new Error('dispose failed')
        registered.delete(entry.name)
      }
    },
    dismiss: name => { dismissed.push(name) },
    readOwner: () => options.owner ?? 'auto',
  })
  return { face, registered, dismissed, names: (): string[] => [...registered.keys()] }
}

describe('command-face takeover', () => {
  it('registers both engine commands by default', () => {
    const { names } = makeFace()
    expect(names().sort()).toEqual(['rewind', 'undo'])
  })

  it('withdraws every engine command and supports hide-only', async () => {
    const { face, names, dismissed } = makeFace()
    const permission = await granted(face)
    expect(names()).toEqual([])
    expect([...dismissed].sort()).toEqual(['rewind', 'undo'])
    permission.dispose()
  })

  it('returns null for a second takeover while one is held', async () => {
    const { face } = makeFace()
    await granted(face)
    expect(await face.service.commands.takeover()).toBeNull()
  })

  it('returns null under uiOwner self and leaves the commands in place', async () => {
    const { face, names } = makeFace({ owner: 'self' })
    expect(await face.service.commands.takeover()).toBeNull()
    expect(names()).toEqual(['rewind', 'undo'])
  })

  it('returns null after the client half unloads', async () => {
    const { face } = makeFace()
    face.dispose()
    expect(await face.service.commands.takeover()).toBeNull()
  })

  it('returns null and restores the face when a command cannot be withdrawn', async () => {
    const { face, names } = makeFace({ failDispose: 'rewind' })
    expect(await face.service.commands.takeover()).toBeNull()
    // The successfully withdrawn command is restored; the failed one stays.
    expect(names().sort()).toEqual(['rewind', 'undo'])
  })

  it('gives native ownership precedence over an active claimant', async () => {
    let owner: UiOwner = 'auto'
    const registered = new Map<string, CommandContribution>()
    const face = createCommandFace({
      contributions: [contribution('rewind'), contribution('undo')],
      register: (entry) => {
        registered.set(entry.name, entry)
        return () => { registered.delete(entry.name) }
      },
      dismiss: () => {},
      readOwner: () => owner,
    })
    await granted(face)
    owner = 'self'
    expect(await face.service.commands.takeover()).toBeNull()
  })

  it('restores the engine commands on permission.dispose and is idempotent', async () => {
    const { face, names } = makeFace()
    const permission = await granted(face)
    permission.dispose()
    expect(names().sort()).toEqual(['rewind', 'undo'])
    permission.dispose()
    expect(names().sort()).toEqual(['rewind', 'undo'])
  })

  it('skips a name another plugin owns when it restores', async () => {
    const { face, registered, names } = makeFace()
    const permission = await granted(face)
    const taken = contribution('rewind')
    registered.set('rewind', taken)
    permission.dispose()
    expect(registered.get('rewind')).toBe(taken)
    expect(names().sort()).toEqual(['rewind', 'undo'])
  })

  it('costs only one name when the registry refuses an engine command', async () => {
    const { face, names, dismissed } = makeFace({ refuse: 'rewind' })
    expect(names()).toEqual(['undo'])
    const permission = await granted(face)
    expect(dismissed).toEqual(['undo'])
    permission.dispose()
    expect(names()).toEqual(['undo'])
  })

  it('removes the commands with the client half and invalidates a held permission', async () => {
    const { face, names } = makeFace()
    const permission = await granted(face)
    face.dispose()
    expect(names()).toEqual([])
    permission.dispose()
    expect(names()).toEqual([])
  })

  it('removes the commands on unload without a takeover', () => {
    const { face, names } = makeFace()
    face.dispose()
    expect(names()).toEqual([])
  })
})
