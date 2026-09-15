/**
 * Unit tests for the session-cwd resolution (src/session-cwd.ts), the same
 * rule the fs tools apply when resolving relative paths. The alpha line
 * returns `header.cwd` verbatim: no parent-traversal canonicalization.
 */
import { basename, join } from 'node:path'
import { tmpdir } from 'node:os'
import { describe, expect, it } from 'vitest'
import { Session, SessionId, SESSION_FORMAT_VERSION } from '@deepseek-ai/dsh-session'
import type { ToolExecution } from '@deepseek-ai/dsh-tools'
import { execSessionCwd, sessionCwd } from '../src/session-cwd.ts'

const BASE = join(tmpdir(), 'dsh-rewind-session-cwd-test')
/** A `..`-bearing alias of BASE; the rule returns it verbatim. */
const ALIAS = `${BASE}/../${basename(BASE)}`

describe('sessionCwd', () => {
  it('returns undefined without a session cwd (backend default applies)', () => {
    expect(sessionCwd(undefined)).toBeUndefined()
  })

  it('returns the cwd unchanged', () => {
    expect(sessionCwd(BASE)).toBe(BASE)
  })

  it('does not canonicalize a cwd containing parent traversal', () => {
    expect(sessionCwd(ALIAS)).toBe(ALIAS)
  })
})

describe('execSessionCwd', () => {
  it('reads the cwd from the calling agent session header', () => {
    const session = Session.create(SessionId('cwd-test'), undefined, {
      version: SESSION_FORMAT_VERSION,
      id: SessionId('cwd-test'),
      createdAt: Date.now(),
      cwd: BASE,
      isSeeded: false,
    })
    const exec = { agent: { id: session.id, session }, name: 'write' } as unknown as ToolExecution
    expect(execSessionCwd(exec)).toBe(BASE)
  })

  it('returns a parent-traversing cwd verbatim', () => {
    const session = Session.create(SessionId('cwd-alias'), undefined, {
      version: SESSION_FORMAT_VERSION,
      id: SessionId('cwd-alias'),
      createdAt: Date.now(),
      cwd: ALIAS,
      isSeeded: false,
    })
    const exec = { agent: { id: session.id, session }, name: 'write' } as unknown as ToolExecution
    expect(execSessionCwd(exec)).toBe(ALIAS)
  })

  it('returns undefined for agent-less executions', () => {
    const exec = { name: 'write' } as unknown as ToolExecution
    expect(execSessionCwd(exec)).toBeUndefined()
  })
})
