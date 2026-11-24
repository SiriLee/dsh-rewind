/**
 * Host ownership of the engine's command names.
 *
 * A client contribution may not share a name with a Host command. This state
 * starts optimistic (no Host owner) and is replaced only by a completed read of
 * the Session's Host catalog; a failed or superseded read keeps the previous
 * snapshot.
 *
 * @module dsh-rewind/client/command-conflicts
 */
import { REWIND, UNDO, type RewindCommand } from './command-names.ts'

/** Read one Session's Host command names; undefined when unavailable. */
export type ReadHostCommands = (sessionId: string) => Promise<readonly string[] | undefined>

/** Latest known Host ownership of the engine's command names. */
export class CommandConflicts {
  private owns: Record<RewindCommand, boolean> = { [REWIND]: false, [UNDO]: false }
  private generation = 0

  /** @param read - one Session's Host catalog read. */
  constructor(private readonly read: ReadHostCommands) {}

  /** Whether the name is free; optimistic until a read completes. */
  allows(name: RewindCommand): boolean {
    return !this.owns[name]
  }

  /**
   * Replace the snapshot with one Session's catalog.
   * A stale read or a failed read leaves the previous snapshot in place.
   * @param sessionId - Session whose catalog applies.
   */
  async check(sessionId: string): Promise<void> {
    const generation = ++this.generation
    const names = await this.read(sessionId).catch(() => undefined)
    if (generation !== this.generation || names === undefined) return
    this.owns = { [REWIND]: names.includes(REWIND), [UNDO]: names.includes(UNDO) }
  }
}
