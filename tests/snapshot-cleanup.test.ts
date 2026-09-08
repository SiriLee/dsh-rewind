/**
 * Unit tests for the snapshot-cleanup policy module (src/snapshot-cleanup.ts):
 * config validation, the settings-backed store, the command parser, and the 24h
 * throttle. The last-sweep state file is exercised against a real file under a
 * temporary directory.
 */
import { mkdtemp, mkdir, readFile, writeFile, rm, utimes } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { SnapshotStore } from '../src/snapshot.ts'
import {
  CLEANUP_SETTINGS_NAMESPACE,
  CleanupConfigSchema,
  DEFAULT_CLEANUP_CONFIG,
  DEFAULT_MAX_AGE_DAYS,
  loadLastSweepAt,
  parseCleanupCommand,
  parseCleanupConfig,
  resolveCleanupStatePath,
  runAutoCleanupCheck,
  saveLastSweepAt,
  settingsCleanupStore,
  shouldRunAutoSweep,
  type CleanupConfig,
  type CleanupSettingsScope,
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

describe('parseCleanupCommand', () => {
  it('treats empty input as status', () => {
    expect(parseCleanupCommand('')).toEqual({ action: 'status' })
    expect(parseCleanupCommand('   ')).toEqual({ action: 'status' })
  })

  it('parses the simple sub-commands', () => {
    expect(parseCleanupCommand('status')).toEqual({ action: 'status' })
    expect(parseCleanupCommand('on')).toEqual({ action: 'on' })
    expect(parseCleanupCommand('off')).toEqual({ action: 'off' })
  })

  it('parses run (age rules) as dry by default and executes with --apply', () => {
    expect(parseCleanupCommand('run')).toEqual({ action: 'run', target: 'rules', apply: false })
    expect(parseCleanupCommand('run --apply')).toEqual({ action: 'run', target: 'rules', apply: true })
  })

  it('parses run --current (the current session clear), dry or --apply', () => {
    expect(parseCleanupCommand('run --current')).toEqual({ action: 'run', target: 'current', apply: false })
    expect(parseCleanupCommand('run --current --apply')).toEqual({ action: 'run', target: 'current', apply: true })
    // --apply is a position-independent flag.
    expect(parseCleanupCommand('run --apply --current')).toEqual({ action: 'run', target: 'current', apply: true })
    expect(parseCleanupCommand('run --current --current')).toEqual({ action: 'run', target: 'current', apply: false })
  })

  it('rejects the removed run-apply abbreviation', () => {
    expect(parseCleanupCommand('run-apply')).toMatchObject({ error: expect.any(String) })
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
    expect(parseCleanupCommand('run --current --bogus')).toMatchObject({ error: expect.any(String) })
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
  it('resolves the last-sweep state path under the harness home', () => {
    expect(resolveCleanupStatePath()).toBe(join(homedir(), '.dsh', 'snapshot-cleanup-last-sweep.json'))
  })
})

describe('runAutoCleanupCheck', () => {
  const day = 86_400_000
  const now = () => Date.now()
  const snapRoot = () => join(dir, 'snapshots')
  const deps = (policy: { ok: true; config: CleanupConfig } | { ok: false; error: string }) => ({
    pruner: new SnapshotStore(snapRoot()),
    readConfig: async () => policy,
    statePath: state,
    log: (_s: string): void => {},
  })
  const enabled = (): { ok: true; config: CleanupConfig } => ({ ok: true, config: { enabled: true, maxAgeDays: 30 } })

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
    await saveLastSweepAt(state, now() - 40 * day)
    await runAutoCleanupCheck(deps(enabled()), 'active')
    await expect(staleExists('old')).resolves.toBe(false)
    await expect(loadLastSweepAt(state)).resolves.toBeGreaterThan(now() - day)
  })

  it('does nothing when throttled (recent window)', async () => {
    await seedStale('old', now() - 40 * day)
    const recent = now() - 60_000
    await saveLastSweepAt(state, recent)
    await runAutoCleanupCheck(deps(enabled()), 'active')
    await expect(staleExists('old')).resolves.toBe(true) // untouched
    await expect(loadLastSweepAt(state)).resolves.toBe(recent) // unchanged
  })

  it('never sweeps when disabled (and never reads the window)', async () => {
    await seedStale('old', now() - 40 * day)
    await runAutoCleanupCheck(deps({ ok: true, config: { enabled: false, maxAgeDays: 30 } }), 'active')
    await expect(staleExists('old')).resolves.toBe(true)
  })

  it('fail-closes on a corrupt config and logs', async () => {
    await seedStale('old', now() - 40 * day)
    const log = vi.fn()
    await runAutoCleanupCheck({ ...deps({ ok: false, error: 'config file is not valid JSON' }), log }, 'active')
    expect(log).toHaveBeenCalled()
    await expect(staleExists('old')).resolves.toBe(true) // nothing deleted
  })

  it('treats a missing config as the safe default (disabled)', async () => {
    await seedStale('old', now() - 40 * day)
    await runAutoCleanupCheck(deps({ ok: true, config: { ...DEFAULT_CLEANUP_CONFIG } }), 'active')
    await expect(staleExists('old')).resolves.toBe(true)
  })

  it('never prunes the active session even when due', async () => {
    await seedStale('active', now() - 40 * day)
    await saveLastSweepAt(state, now() - 40 * day)
    await runAutoCleanupCheck(deps(enabled()), 'active')
    await expect(staleExists('active')).resolves.toBe(true) // skipped via keepActiveId
  })
})

describe('CleanupConfig schema + settingsCleanupStore', () => {
  // schemastery's TS call type requires the full config shape; `.default()` makes
  // absent fields fall back at runtime, so tests drive the schema through a
  // widened call helper that still exercises the runtime defaults/rejections.
  const at = (v: Record<string, unknown>): CleanupConfig => CleanupConfigSchema(v as unknown as CleanupConfig)

  it('resolves the default (off) policy when nothing is set', () => {
    expect(at({})).toEqual({ enabled: false, maxAgeDays: DEFAULT_MAX_AGE_DAYS })
  })

  it('keeps provided values', () => {
    expect(at({ enabled: true, maxAgeDays: 7 })).toEqual({ enabled: true, maxAgeDays: 7 })
  })

  it('rejects a non-positive or non-integer maxAgeDays', () => {
    expect(() => at({ enabled: false, maxAgeDays: 0 })).toThrow()
    expect(() => at({ enabled: false, maxAgeDays: -1 })).toThrow()
    expect(() => at({ enabled: false, maxAgeDays: 2.5 })).toThrow()
    expect(() => at({ enabled: false, maxAgeDays: NaN })).toThrow()
  })

  it('rejects a non-enum enabled', () => {
    expect(() => at({ enabled: 'yes' })).toThrow()
  })

  it('store load() reads the scope and save() validates then updates', async () => {
    const scope: CleanupSettingsScope = {
      get: (): CleanupConfig => ({ enabled: true, maxAgeDays: 9 }),
      update: vi.fn(async () => undefined),
    }
    const store = settingsCleanupStore(scope)
    expect(store.load()).toEqual({ enabled: true, maxAgeDays: 9 })
    await store.save({ enabled: false, maxAgeDays: 12 })
    expect(scope.update).toHaveBeenCalledWith({ enabled: false, maxAgeDays: 12 })
    await expect(store.save({ enabled: false, maxAgeDays: 0 })).rejects.toThrow()
    expect(scope.update).toHaveBeenCalledTimes(1) // invalid value never touched scope
  })

  it('namespace is lowercase-hyphenated (settings grammar, no dots)', () => {
    expect(CLEANUP_SETTINGS_NAMESPACE).toMatch(/^[a-z][a-z0-9-]*$/)
    expect(CLEANUP_SETTINGS_NAMESPACE).not.toContain('.')
  })
})
