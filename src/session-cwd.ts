/**
 * Session-cwd resolution for snapshot tracking reads: relative paths resolve
 * against the calling agent's session workspace (`exec.agent.session.header.cwd`),
 * returned verbatim — no canonicalization — or `undefined` when the session has
 * none (the filesystem backend then applies its own default base).
 *
 * @module dsh-rewind/session-cwd
 */

import type { ToolExecution } from '@deepseek-ai/dsh-tools'

/**
 * The session workspace cwd to resolve a requested path against.
 * @param cwd - the session's `header.cwd`, if any.
 * @returns the cwd unchanged, or undefined when there is none.
 */
export function sessionCwd(cwd: string | undefined): string | undefined {
  return cwd
}

/**
 * Session cwd for one tool execution.
 * @param exec - the tool-execution context; only its optional `agent` is read.
 * @returns the calling agent's session cwd, or undefined for a non-agent caller.
 */
export function execSessionCwd(exec: ToolExecution): string | undefined {
  return sessionCwd(exec.agent?.session.header.cwd)
}
