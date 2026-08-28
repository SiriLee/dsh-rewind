/**
 * Unit tests for the snapshot-cleanup policy module (src/snapshot-cleanup.ts):
 * config validation/load/save, the command parser, and the 24h throttle. The
 * config file is exercised against a real file under a temporary directory.
 */
import { mkdtemp, mkdir, readFile, writeFile, rm, utimes } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { SnapshotStore } from '../src/snapshot.ts'
import {
  CLEANUP_CONFIG_ENV,
  DEFAULT_CLEANUP_CONFIG,
  DEFAULT_MAX_AGE_DAYS,
  loadLastSweepAt,
  parseCleanupCommand,
  parseCleanupConfig,
  loadCleanupConfig,
  resolveCleanupConfigPath,
  resolveCleanupStatePath,
  runAutoCleanupCheck,
  saveCleanupConfig,
  saveLastSweepAt,
  shouldRunAutoSweep,
  type CleanupConfig,
} from '../src/snapshot-cleanup.ts'

let cfg: string
let state: string
let dir: string

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'dsh-rewind-cfg-'))
  cfg = join(dir, 'snapshot-cleanup.json')
  state = join(dir, 'snapshot-cleanup-last-sweep.json')
})

afterEach(async () => {
  vi.unstubAllEnvs()
  await rm(dir, { recursive: true, force: true })
})

describe('parseCleanupConfig', () => {
  it('rejects a non-object root', () => {
    expect(parseCleanupConfig(null).ok).toBe(false)
    expect(parseCleanupConfig('x').ok).toBe(false)
    expect(parseCleanupConfig([1]).ok).toBe(false)
  })

  it('defaults a missing file object to the off policy', () => {
    const r = parseCleanupConfig({})
    expect(r).toEqual({ ok: true, config: { enabled: false, maxAgeDays: DEFAULT_MAX_AGE_DAYS } })
  })

  it('keeps provided fields and tolerates unknown keys', () => {
    const r = parseCleanupConfig({ enabled: true, maxAgeDays: 5, extra: 'ignored' })
    expect(r).toEqual({ ok: true, config: { enabled: true, maxAgeDays: 5 } })
  })

  it('rejects a non-boolean enabled', () => {
    expect(parseCleanupConfig({ enabled: 'yes' }).ok).toBe(false)
  })

  it('rejects a non-positive or non-integer maxAgeDays', () => {
    expect(parseCleanupConfig({ maxAgeDays: 0 }).ok).toBe(false)
    expect(parseCleanupConfig({ maxAgeDays: -1 }).ok).toBe(false)
    expect(parseCleanupConfig({ maxAgeDays: 1.5 }).ok).toBe(false)
    expect(parseCleanupConfig({ maxAgeDays: '30' }).ok).toBe(false)
    expect(parseCleanupConfig({ maxAgeDays: Number.NaN }).ok).toBe(false)
  })
})

describe('loadCleanupConfig', () => {
  it('reads a missing file as the safe default (off)', async () => {
    const r = await loadCleanupConfig(cfg)
    expect(r).toEqual({ ok: true, config: { ...DEFAULT_CLEANUP_CONFIG }, fromFile: false })
  })

  it('reads a valid file and reports fromFile', async () => {
    await writeFile(cfg, JSON.stringify({ enabled: true, maxAgeDays: 7 }), 'utf8')
    const r = await loadCleanupConfig(cfg)
    expect(r).toEqual({ ok: true, config: { enabled: true, maxAgeDays: 7 }, fromFile: true })
  })

  it('reports ok:false for invalid JSON', async () => {
    await writeFile(cfg, '{nope', 'utf8')
    const r = await loadCleanupConfig(cfg)
    expect(r.ok).toBe(false)
  })

  it('reports ok:false for structurally invalid values', async () => {
    await writeFile(cfg, JSON.stringify({ enabled: true, maxAgeDays: 0 }), 'utf8')
    const r = await loadCleanupConfig(cfg)
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error).toContain('maxAgeDays')
  })

  it('reports ok:false for an unreadable path', async () => {
    const r = await loadCleanupConfig(dir) // a directory: readFile fails with EISDIR
    expect(r.ok).toBe(false)
  })
})

describe('saveCleanupConfig', () => {
  it('writes a readable config and leaves no temp sibling', async () => {
    await saveCleanupConfig(cfg, { enabled: true, maxAgeDays: 12 })
    const onDisk = JSON.parse(await readFile(cfg, 'utf8')) as CleanupConfig
    expect(onDisk).toEqual({ enabled: true, maxAgeDays: 12 })
    await expect(loadCleanupConfig(cfg)).resolves.toEqual({ ok: true, config: { enabled: true, maxAgeDays: 12 }, fromFile: true })
    await expect(readFile(`${cfg}.tmp`, 'utf8')).rejects.toThrow()
  })

  it('rejects an invalid config without writing anything', async () => {
    await expect(saveCleanupConfig(cfg, { enabled: true, maxAgeDays: 0 })).rejects.toThrow(RangeError)
    expect(await loadCleanupConfig(cfg)).toEqual({ ok: true, config: { ...DEFAULT_CLEANUP_CONFIG }, fromFile: false })
  })
})

describe('resolveCleanupConfigPath', () => {
  it('defaults to ~/.dsh/snapshot-cleanup.json', () => {
    expect(resolveCleanupConfigPath()).toBe(join(homedir(), '.dsh', 'snapshot-cleanup.json'))
  })

  it('honors the env override', () => {
    vi.stubEnv(CLEANUP_CONFIG_ENV, '/tmp/custom-cleanup.json')
    expect(resolveCleanupConfigPath()).toBe('/tmp/custom-cleanup.json')
  })
})

describe('parseCleanupCommand', () => {
  it('treats empty input as status', () => {
    expect(parseCleanupCommand('')).toEqual({ action: 'status' })
    expect(parseCleanupCommand('   ')).toEqual({ action: 'status' })
  })

  it('parses the simple sub-commands', () => {
    expect(parseCleanupCommand('status')).toEqual({ action: 'status' })
    expect(parseCleanupCommand('on')).toEqual({ action: 'on' })
    expect(parseCleanupCommand('off')).toEqual({ action: 'off' })
    expect(parseCleanupCommand('run')).toEqual({ action: 'run' })
    expect(parseCleanupCommand('run --apply')).toEqual({ action: 'run-apply' })
  })

  it('parses max-age with a validated positive integer', () => {
    expect(parseCleanupCommand('max-age 12')).toEqual({ action: 'max-age', value: 12 })
  })

  it('rejects a bad max-age', () => {
    expect(parseCleanupCommand('max-age')).toMatchObject({ error: expect.any(String) })
    expect(parseCleanupCommand('max-age 0')).toMatchObject({ error: expect.any(String) })
    expect(parseCleanupCommand('max-age abc')).toMatchObject({ error: expect.any(String) })
    expect(parseCleanupCommand('max-age -3')).toMatchObject({ error: expect.any(String) })
  })

  it('rejects unknown sub-commands and malformed forms', () => {
    expect(parseCleanupCommand('bogus')).toMatchObject({ error: expect.any(String) })
    expect(parseCleanupCommand('on extra')).toMatchObject({ error: expect.any(String) })
    expect(parseCleanupCommand('run --x')).toMatchObject({ error: expect.any(String) })
  })
})

describe('shouldRunAutoSweep', () => {
  const now = 1_700_000_000_000
  const day = 86_400_000

  it('always sweeps when never run (lastAt 0)', () => {
    expect(shouldRunAutoSweep(0, now)).toBe(true)
  })

  it('is a no-op within 24h and fires at / past 24h', () => {
    expect(shouldRunAutoSweep(now - (day - 1), now)).toBe(false)
    expect(shouldRunAutoSweep(now - day, now)).toBe(true)
    expect(shouldRunAutoSweep(now - 2 * day, now)).toBe(true)
  })
})

describe('last-sweep state (persisted across restart)', () => {
  it('round-trips a saved timestamp', async () => {
    const t = 1_700_000_111_222
    await saveLastSweepAt(state, t)
    await expect(loadLastSweepAt(state)).resolves.toBe(t)
  })

  it('reads a missing file as 0 (never swept)', async () => {
    await expect(loadLastSweepAt(state)).resolves.toBe(0)
  })

  it('reads a corrupt / non-number file as 0 (fail-safe)', async () => {
    await writeFile(state, '{broken', 'utf8')
    await expect(loadLastSweepAt(state)).resolves.toBe(0)
    await writeFile(state, JSON.stringify({ lastSweepAt: 'nope' }), 'utf8')
    await expect(loadLastSweepAt(state)).resolves.toBe(0)
  })

  it('saves atomically and creates the parent dir', async () => {
    const nested = join(dir, 'deep', 'state.json')
    await saveLastSweepAt(nested, 5)
    await expect(loadLastSweepAt(nested)).resolves.toBe(5)
    await expect(readFile(`${nested}.tmp`, 'utf8')).rejects.toThrow()
  })

  it('anchors the 24h window from the persisted value (survives a restart)', async () => {
    const t0 = 1_700_000_000_000
    // A fresh "process" reads the persisted old time and is due.
    await saveLastSweepAt(state, t0 - 10 * 86_400_000)
    await expect(shouldRunAutoSweep(await loadLastSweepAt(state), t0)).toBe(true)
    // A fresh "process" reads a recent time and is throttled.
    await saveLastSweepAt(state, t0 - 86_400_000 + 1)
    await expect(shouldRunAutoSweep(await loadLastSweepAt(state), t0)).toBe(false)
  })
})

describe('resolveCleanupStatePath', () => {
  it('derives from the config path dir with the state filename', () => {
    vi.stubEnv(CLEANUP_CONFIG_ENV, join(dir, 'my-config.json'))
    expect(resolveCleanupStatePath()).toBe(join(dir, 'snapshot-cleanup-last-sweep.json'))
  })
})

describe('runAutoCleanupCheck', () => {
  const day = 86_400_000
  const now = () => Date.now()
  const snapRoot = () => join(dir, 'snapshots')
  const deps = () => ({
    pruner: new SnapshotStore(snapRoot()),
    configPath: cfg,
    statePath: state,
    log: (_s: string): void => {},
  })

  async function seedStale(sessionId: string, mtimeMs: number): Promise<void> {
    const anchor = join(snapRoot(), sessionId, '1')
    await mkdir(anchor, { recursive: true })
    const file = join(anchor, 'x.json')
    await writeFile(file, '{}', 'utf8')
    const t = new Date(mtimeMs)
    await utimes(file, t, t)
    await utimes(anchor, t, t)
    await utimes(join(snapRoot(), sessionId), t, t)
  }

  const staleExists = async (sessionId: string): Promise<boolean> =>
    new SnapshotStore(snapRoot()).exists(join(snapRoot(), sessionId))

  it('sweeps and re-anchors the window when enabled and due', async () => {
    await seedStale('old', now() - 40 * day)
    await writeFile(cfg, JSON.stringify({ enabled: true, maxAgeDays: 30 }), 'utf8')
    await saveLastSweepAt(state, now() - 40 * day)
    await runAutoCleanupCheck(deps(), 'active')
    await expect(staleExists('old')).resolves.toBe(false)
    await expect(loadLastSweepAt(state)).resolves.toBeGreaterThan(now() - day)
  })

  it('does nothing when throttled (recent window)', async () => {
    await seedStale('old', now() - 40 * day)
    await writeFile(cfg, JSON.stringify({ enabled: true, maxAgeDays: 30 }), 'utf8')
    const recent = now() - 60_000
    await saveLastSweepAt(state, recent)
    await runAutoCleanupCheck(deps(), 'active')
    await expect(staleExists('old')).resolves.toBe(true) // untouched
    await expect(loadLastSweepAt(state)).resolves.toBe(recent) // unchanged
  })

  it('never sweeps when disabled (and never reads the window)', async () => {
    await seedStale('old', now() - 40 * day)
    await writeFile(cfg, JSON.stringify({ enabled: false, maxAgeDays: 30 }), 'utf8')
    await runAutoCleanupCheck(deps(), 'active')
    await expect(staleExists('old')).resolves.toBe(true)
  })

  it('fail-closes on a corrupt config and logs', async () => {
    await seedStale('old', now() - 40 * day)
    await writeFile(cfg, '{broken', 'utf8')
    const log = vi.fn()
    await runAutoCleanupCheck({ ...deps(), log }, 'active')
    expect(log).toHaveBeenCalled()
    await expect(staleExists('old')).resolves.toBe(true) // nothing deleted
  })

  it('treats a missing config as the safe default (disabled)', async () => {
    await seedStale('old', now() - 40 * day)
    await runAutoCleanupCheck(deps(), 'active')
    await expect(staleExists('old')).resolves.toBe(true)
  })

  it('never prunes the active session even when due', async () => {
    await seedStale('active', now() - 40 * day)
    await writeFile(cfg, JSON.stringify({ enabled: true, maxAgeDays: 30 }), 'utf8')
    await saveLastSweepAt(state, now() - 40 * day)
    await runAutoCleanupCheck(deps(), 'active')
    await expect(staleExists('active')).resolves.toBe(true) // skipped via keepActiveId
  })
})
