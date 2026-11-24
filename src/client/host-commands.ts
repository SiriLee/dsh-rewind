/**
 * Session-keyed cache of Host command names: a contribution is allowed only
 * for a catalog that was read successfully and does not own its name.
 *
 * @module dsh-rewind/client/host-commands
 */

/** Read one Session's Host command names; undefined when unavailable. */
export type FetchHostCommandNames = (sessionId: string) => Promise<readonly string[] | undefined>

/** Unknown, failed and invalidated Sessions stay dormant. */
export class HostCommandNames {
  private readonly known = new Map<string, ReadonlySet<string>>()
  private readonly inflight = new Map<string, number>()
  private sequence = 0

  constructor(private readonly fetch: FetchHostCommandNames) {}

  /** True only when the catalog is known and free of `name`; unknown warms and answers false. */
  allows(sessionId: string, name: string): boolean {
    const names = this.known.get(sessionId)
    if (names === undefined) {
      this.warm(sessionId)
      return false
    }
    return !names.has(name)
  }

  /** Read one Session's catalog unless it is known or a read is in flight. */
  warm(sessionId: string): void {
    if (this.known.has(sessionId) || this.inflight.has(sessionId)) return
    const token = ++this.sequence
    this.inflight.set(sessionId, token)
    void this.fetch(sessionId)
      .then((names) => {
        if (this.inflight.get(sessionId) !== token || names === undefined) return
        this.known.set(sessionId, new Set(names))
      }, () => {})
      .finally(() => {
        if (this.inflight.get(sessionId) === token) this.inflight.delete(sessionId)
      })
  }

  /** Drop every cached catalog. */
  invalidateAll(): void {
    this.known.clear()
    this.inflight.clear()
  }

  /** Drop one Session's catalog. */
  invalidate(sessionId: string): void {
    this.known.delete(sessionId)
    this.inflight.delete(sessionId)
  }
}
