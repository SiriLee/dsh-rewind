/**
 * Session-cwd resolution for snapshot tracking reads, mirroring the fs tools'
 * own rule (`@deepseek-ai/dsh-tool-fs/session-cwd.ts`): relative paths
 * resolve against the calling agent's session workspace
 * (`exec.agent.session.header.cwd`), not the server's launch dir.
 *
 * Pure functions: the session cwd is returned verbatim. The fs tools no longer
 * canonicalize a parent-traversing cwd (alpha line), so neither does the
 * plugin — snapshot tracking must resolve to the same base the tool wrote to.
 *
 * @module dsh-rewind/session-cwd
 */

import type { ToolExecution } from '@deepseek-ai/dsh-tools'

/**
 * The session workspace cwd to resolve a requested path against, or undefined
 * when no session cwd applies (the filesystem backend then uses its own
 * default base).
 * @param cwd - the session's `header.cwd`, if any.
 * @returns the cwd unchanged.
 */
export function sessionCwd(cwd: string | undefined): string | undefined {
  return cwd
}

/**
 * Session cwd for one tool execution (same rule as the fs tools).
 * @param exec - the tool-execution context; only its optional `agent` is read.
 * @returns the calling agent's session cwd, or undefined for a non-agent caller.
 */
export function execSessionCwd(exec: ToolExecution): string | undefined {
  return sessionCwd(exec.agent?.session.header.cwd)
}
