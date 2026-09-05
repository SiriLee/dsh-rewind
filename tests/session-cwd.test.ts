/**
 * Unit tests for the session-cwd resolution (src/session-cwd.ts), the same
 * rule the fs tools apply when resolving relative paths.
 */
import { mkdirSync, realpathSync } from 'node:fs'
import { basename, join } from 'node:path'
import { tmpdir } from 'node:os'
import { describe, expect, it } from 'vitest'
import { Session, SessionId } from '@deepseek-ai/dsh-session'
import type { ToolExecution } from '@deepseek-ai/dsh-tools'
import { execSessionCwd, sessionCwd } from '../src/session-cwd.ts'

/** A real existing directory (canonicalPath realpaths it) with a `..` alias. */
const BASE = join(tmpdir(), 'dsh-rewind-session-cwd-test')
const ALIAS = `${BASE}/../${basename(BASE)}`
mkdirSync(BASE, { recursive: true })

describe('sessionCwd', () => {
  it('returns undefined without a session cwd (backend default applies)', () => {
    expect(sessionCwd(undefined, 'a.ts')).toBeUndefined()
  })

  it('returns the cwd unchanged for ordinary relative paths', () => {
    expect(sessionCwd(BASE, 'src/a.ts')).toBe(BASE)
  })

  it('canonicalizes the cwd when the requested path traverses parents', () => {
    const result = sessionCwd(BASE, '../outside/a.ts')
    expect(result).toBe(realpathSync(BASE))
  })

  it('canonicalizes a cwd that itself contains parent traversal', () => {
    expect(sessionCwd(ALIAS, 'a.ts')).toBe(realpathSync.native(ALIAS))
  })

  it('keeps absolute requested paths untouched (cwd irrelevant)', () => {
    expect(sessionCwd(BASE, '/etc/hosts')).toBe(BASE)
  })
})

describe('execSessionCwd', () => {
  it('reads the cwd from the calling agent session header', () => {
    const session = Session.create(SessionId('cwd-test'), undefined, {
      version: 0,
      id: SessionId('cwd-test'),
      createdAt: Date.now(),
      cwd: BASE,
      isSeeded: false,
    })
    const exec = { agent: { id: session.id, session }, name: 'write' } as unknown as ToolExecution
    expect(execSessionCwd(exec, 'rel.ts')).toBe(BASE)
  })

  it('returns undefined for agent-less executions', () => {
    const exec = { name: 'write' } as unknown as ToolExecution
    expect(execSessionCwd(exec, 'rel.ts')).toBeUndefined()
  })
})
