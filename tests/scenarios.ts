/**
 * Scenario generator for the compatibility probe suites.
 *
 * A scenario is a deterministic sequence of operations that a user could
 * perform against a real harness session (turns, tool turns, rewinds,
 * compactions). The generator executes each op against a REAL dsh-session
 * using the plugin's exact append shapes (`appendTurn`, `applyRewind`,
 * `simulateCompaction` from `helpers.ts`), then lets the probe suites assert
 * the compatibility invariants (replayability, surface consistency, step/turn
 * structure, fold safety) over the resulting log.
 *
 * Running a scenario IS the investigation: every op exercises a real DSH
 * consumer path, and a probe failure surfaces a compatibility gap.
 */
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import { Context } from '@deepseek-ai/cordis'
import { Session, SessionId } from '@deepseek-ai/dsh-session'
import { TokenMeter } from '@deepseek-ai/dsh-token-meter'
import { appendToolTurn, appendTurn, applyRewind, newMeter, simulateCompaction } from './helpers.ts'

export type ScenarioOp =
  /** One complete conversation turn (auto turn number). */
  | { kind: 'turn' }
  /** One complete turn with a balanced tool-call/result pair. */
  | { kind: 'toolTurn' }
  /** Rewind to the N-th most recent human user message still on the surface (1 = latest). */
  | { kind: 'rewind'; index: number }
  /**
   * Compact a surface range by position: `from` is the 0-based surface index
   * of the first node, `to` the last (or -1 for the surface tail). The range
   * must be tool-pair balanced; an unbalanced or empty range is recorded as
   * `rejected` in the log (the generator never crashes on a refused op).
   */
  | { kind: 'compact'; from: number; to: number }
  /** Probe: the log must stay replayable (token-meter + Session.create resume). */
  | { kind: 'probe' }

export interface ScenarioResult {
  /** The session after all ops ran. */
  readonly session: Session
  /** Per-op outcome lines: `ok <op>` or `rejected <op>: <reason>`. */
  readonly log: readonly string[]
  /** Seq of the last `user/message` with a human source still on the surface. */
  readonly lastHumanUserSeq: number | null
}

/** Turn numbering follows the harness: next real turn is last turn/start + 1. */
function nextTurn(session: Session): number {
  let lastStarted = 0
  for (const event of session.snapshotEvents()) {
    if (event.type === 'turn/start' && event.data.turn > lastStarted) lastStarted = event.data.turn
  }
  return lastStarted + 1
}

/** Seq of the newest human `user/message` currently on the surface, if any. */
function latestHumanUserSeq(session: Session): number | null {
  const surface = new Set(session.surface.nodes)
  for (let i = session.snapshotEvents().length - 1; i >= 0; i--) {
    const event = session.snapshotEvents()[i]!
    if (event.type === 'user/message' && event.data.source.kind === 'user' && surface.has(event.seq)) {
      return event.seq
    }
  }
  return null
}

let callCounter = 0

/**
 * Execute one op sequence against a fresh real session and return the log.
 * Every op is executed with the plugin's own planning/append functions, so a
 * `rejected` outcome is the plugin's decision, never the generator's guess.
 */
export function runScenario(ops: readonly ScenarioOp[], name = 'scenario'): ScenarioResult {
  const session = Session.create(SessionId(`compat-${name}`))
  const log: string[] = []
  for (const op of ops) {
    try {
      switch (op.kind) {
        case 'turn':
          appendTurn(session, nextTurn(session))
          log.push('ok turn')
          break
        case 'toolTurn':
          callCounter += 1
          appendToolTurn(session, nextTurn(session), ToolCallId(`call-${callCounter}`))
          log.push('ok toolTurn')
          break
        case 'rewind': {
          const target = latestHumanUserSeq(session)
          if (target === null) {
            log.push(`rejected rewind#${op.index}: no human user message on surface`)
            break
          }
          applyRewind(session, target)
          log.push(`ok rewind#${op.index}@${target}`)
          break
        }
        case 'compact': {
          const nodes = session.surface.nodes
          const fromIdx = op.from
          const toIdx = op.to === -1 ? nodes.length - 1 : op.to
          if (fromIdx < 0 || toIdx >= nodes.length || toIdx < fromIdx) {
            log.push(`rejected compact[${op.from},${op.to}]: range outside surface (${nodes.length} nodes)`)
            break
          }
          simulateCompaction(session, nodes[fromIdx]!, nodes[toIdx]!)
          log.push(`ok compact[${op.from},${op.to}]`)
          break
        }
        case 'probe': {
          newMeter().measure(session)
          Session.create(session.id, session.snapshotEvents())
          log.push('ok probe')
          break
        }
      }
    } catch (error) {
      log.push(`rejected ${op.kind}: ${(error as Error).message}`)
    }
  }
  return {
    session,
    log,
    lastHumanUserSeq: latestHumanUserSeq(session),
  }
}

/* ------------------------------------------------------------------ */
/* Named scenarios: every step must be legal (all `ok`, no `rejected`). */
/* ------------------------------------------------------------------ */

/** Baseline: two turns, one rewind to the first question. */
export const SINGLE_REWIND: ScenarioOp[] = [
  { kind: 'turn' },
  { kind: 'turn' },
  { kind: 'probe' },
  { kind: 'rewind', index: 1 },
  { kind: 'probe' },
]

/** A tool turn precedes the rewind; the withdrawn pair leaves the surface. */
export const REWIND_AFTER_TOOL_TURN: ScenarioOp[] = [
  { kind: 'toolTurn' },
  { kind: 'turn' },
  { kind: 'probe' },
  { kind: 'rewind', index: 1 },
  { kind: 'probe' },
]

/** Rewind, continue with a real turn, rewind again, continue again. */
export const MULTI_REWIND_INTERLEAVED: ScenarioOp[] = [
  { kind: 'turn' },
  { kind: 'turn' },
  { kind: 'rewind', index: 1 },
  { kind: 'turn' },
  { kind: 'rewind', index: 1 },
  { kind: 'turn' },
  { kind: 'probe' },
]

/** Rewind then compact the whole current surface. */
export const REWIND_THEN_COMPACT: ScenarioOp[] = [
  { kind: 'turn' },
  { kind: 'turn' },
  { kind: 'turn' },
  { kind: 'rewind', index: 1 },
  { kind: 'compact', from: 0, to: -1 },
  { kind: 'probe' },
]

/** Compact a prefix ending at a tool result (balanced pair), then rewind. */
export const COMPACT_THEN_REWIND: ScenarioOp[] = [
  { kind: 'turn' },
  { kind: 'toolTurn' },
  { kind: 'turn' },
  { kind: 'compact', from: 0, to: 4 },
  { kind: 'rewind', index: 1 },
  { kind: 'probe' },
]

/**
 * Long deterministic mixed walk: tool turns, rewinds, interleaved real turns,
 * a partial compaction (balanced prefix that keeps a human user on the
 * surface), and probes sprinkled through. Every step is legal by
 * construction (each compact range is tool-pair balanced; each rewind targets
 * the newest human user still on the surface).
 */
export const LONG_MIXED: ScenarioOp[] = [
  { kind: 'turn' },
  { kind: 'toolTurn' },
  { kind: 'probe' },
  { kind: 'rewind', index: 1 },
  { kind: 'turn' },
  { kind: 'probe' },
  { kind: 'toolTurn' },
  { kind: 'rewind', index: 2 },
  { kind: 'turn' },
  { kind: 'compact', from: 0, to: 3 },
  { kind: 'probe' },
  { kind: 'rewind', index: 1 },
  { kind: 'turn' },
  { kind: 'probe' },
]

export const SCENARIOS: Record<string, ScenarioOp[]> = {
  'single-rewind': SINGLE_REWIND,
  'rewind-after-tool-turn': REWIND_AFTER_TOOL_TURN,
  'multi-rewind-interleaved': MULTI_REWIND_INTERLEAVED,
  'rewind-then-compact': REWIND_THEN_COMPACT,
  'compact-then-rewind': COMPACT_THEN_REWIND,
  'long-mixed': LONG_MIXED,
}
