/**
 * Compatibility invariants I1–I4 probes (test-driven investigation).
 *
 * Each probe runs the plugin's real append shapes through a REAL DSH
 * consumer and asserts a compatibility invariant. A failing probe is a
 * discovered incompatibility, not a mock artifact.
 *
 *   I1  the log stays replayable — token-meter `measure()` and
 *       `Session.create` (the resume-preflight replay) both accept a log
 *       that carries rewind markers and compaction checkpoints;
 *   I2  the surface stays consistent — no duplicate nodes, every surface
 *       node exists in the log, rewound targets never return, and derived
 *       model messages do not throw;
 *   I3  step/turn structure stays legal — client "turn-tail ordering" and
 *       "one start Match per step" both hold, every `step/end` and every
 *       `assistant/message` is paired with its `step/start`, and a rewind
 *       marker never creates a phantom turn;
 *   I4  every fold service consumes the marker log safely — session-stats
 *       projection, session-title fold, and goal fold never throw, and
 *       their outputs are predictable.
 */
import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { GoalId } from '@deepseek-ai/dsh-goal'
import { foldGoal } from '@deepseek-ai/dsh-goal'
import { foldSessionTitle } from '@deepseek-ai/dsh-session-title'
import { Session, SessionId } from '@deepseek-ai/dsh-session'
import { SessionProjectionRegistry } from '@deepseek-ai/dsh-session-projection'
import { apply as applySessionStats } from '@deepseek-ai/dsh-session-stats'
import { TokenMeter } from '@deepseek-ai/dsh-token-meter'
import { applyRewind, assistantMessage, assertTurnTailOrdering, buildTurnedSession, textMessage } from './helpers.ts'
import { runScenario, SCENARIOS } from './scenarios.ts'

/** I1: token-meter replay and resume-preflight (`Session.create`) accept the log. */
function assertReplayable(session: Session): void {
  expect(() => new TokenMeter(new Context()).measure(session)).not.toThrow()
  expect(() => Session.create(session.id, session.events)).not.toThrow()
}

/** I1: compaction bookkeeping events always close (start…end pairs). */
function assertCompactionBalanced(session: Session): void {
  let starts = 0
  let ends = 0
  for (const event of session.events) {
    if (event.type === 'compaction/start') starts += 1
    else if (event.type === 'compaction/end') ends += 1
  }
  expect(starts).toBe(ends)
}

/** I2: the surface is a legal projection of the log. */
function assertSurfaceConsistent(session: Session, rewoundTargets: readonly number[]): void {
  const nodes = session.surface.nodes
  expect(new Set(nodes).size).toBe(nodes.length) // no duplicates
  for (const seq of nodes) {
    expect(session.events.some(event => event.seq === seq)).toBe(true) // every node exists
  }
  for (const target of rewoundTargets) {
    expect(nodes).not.toContain(target) // a rewound target never returns to the surface
  }
  expect(() => session.deriveMessages()).not.toThrow() // model-history derivation stays legal
}

/** I3: step/turn structure invariants over the whole log. */
function assertStepTurnStructure(session: Session): void {
  assertTurnTailOrdering(session.events)
  const stepStarts = new Set<string>()
  for (const event of session.events) {
    if (event.type === 'step/start') {
      stepStarts.add(`${event.data.turn}:${event.data.step}`)
    }
  }
  for (const event of session.events) {
    if (event.type === 'step/end') {
      expect(stepStarts.has(`${event.data.turn}:${event.data.step}`)).toBe(true)
    }
    if (event.type === 'assistant/message') {
      expect(stepStarts.has(`${event.data.turn}:${event.data.step}`)).toBe(true)
    }
  }
}

describe('I1 log replayability (probe: token-meter + resume preflight)', () => {
  for (const [name, ops] of Object.entries(SCENARIOS)) {
    it(`scenario "${name}" keeps the log replayable end to end`, () => {
      const { session, log } = runScenario(ops, name)
      const rejected = log.filter(line => line.startsWith('rejected'))
      expect(rejected).toEqual([]) // every scenario step is legal by construction
      assertReplayable(session)
      assertCompactionBalanced(session)
    })
  }

  it('a rewind log replays after interleaved compactions and real turns (stress)', () => {
    const { session } = runScenario(SCENARIOS['long-mixed']!, 'stress')
    assertReplayable(session)
    assertCompactionBalanced(session)
  })
})

describe('I2 surface consistency (probe: deriveMessages + node legality)', () => {
  for (const [name, ops] of Object.entries(SCENARIOS)) {
    it(`scenario "${name}" keeps a consistent surface`, () => {
      const { session, log } = runScenario(ops, name)
      const rewoundTargets = log
        .filter(line => line.startsWith('ok rewind'))
        .map(line => Number(line.split('@')[1]))
      assertSurfaceConsistent(session, rewoundTargets)
    })
  }

  it('the marker is the surface tail right after a rewind', () => {
    const session = buildTurnedSession()
    const target = session.surface.nodes.find(seq =>
      session.events.find(e => e.seq === seq)?.type === 'user/message')
    applyRewind(session, target!)
    const last = session.surface.nodes.at(-1)!
    const lastEvent = session.events.find(e => e.seq === last)!
    expect(lastEvent.type).toBe('assistant/message')
    const message = (lastEvent.data as { message?: { content?: unknown[] } }).message
    expect(message?.content).toEqual([])
  })
})

describe('I3 step/turn structure (probe: client ordering + step pairing)', () => {
  for (const [name, ops] of Object.entries(SCENARIOS)) {
    it(`scenario "${name}" keeps step/turn structure legal`, () => {
      const { session } = runScenario(ops, name)
      assertStepTurnStructure(session)
    })
  }
})

describe('I4 fold-service safety (probe: stats / title / goal)', () => {
  it('session-stats folds a rewound log without throwing and without a phantom turn', () => {
    const session = buildTurnedSession() // turns 1 and 2, both closed
    const ctx = new Context()
    new SessionProjectionRegistry(ctx)
    applySessionStats(ctx)
    const registry = ctx.sessionProjections

    // Fold the baseline log through a fresh registry cell (as a resume would).
    const baseline = registry.snapshot(Session.create(session.id, session.events)).values.sessionStats!
    expect(baseline.turns).toBe(2)
    expect(baseline.steps).toBe(2)

    const target = session.surface.nodes.find(seq =>
      session.events.find(e => e.seq === seq)?.type === 'user/message')!
    applyRewind(session, target)

    // Rebuild the session from the rewound log and fold again: the ghost
    // step frame adds exactly one closed step; the reused turn number must
    // NOT create a phantom turn. llmMs stays non-negative and near zero for
    // the empty marker.
    const after = registry.snapshot(Session.create(session.id, session.events)).values.sessionStats!
    expect(after.turns).toBe(2)
    expect(after.steps).toBe(3)
    expect(after.llmMs).toBeGreaterThanOrEqual(0)
  })

  it('session-title fold is unaffected by a rewind marker', () => {
    const session = buildTurnedSession()
    session.append('session/title', {
      title: 'stable title',
      messageSeqs: [2],
      source: { kind: 'fallback' },
    })
    const before = foldSessionTitle(session.events)
    expect(before?.title).toBe('stable title')

    const target = session.surface.nodes.find(seq =>
      session.events.find(e => e.seq === seq)?.type === 'user/message')!
    applyRewind(session, target)

    const after = foldSessionTitle(session.events)
    expect(after?.title).toBe('stable title')
    expect(after?.eventSeq).toBe(before?.eventSeq)
  })

  it('title fold over a marker-only tail returns undefined without throwing', () => {
    const session = buildTurnedSession()
    const target = session.surface.nodes.find(seq =>
      session.events.find(e => e.seq === seq)?.type === 'user/message')!
    applyRewind(session, target)
    expect(foldSessionTitle(session.events)).toBeUndefined()
  })

  it('goal fold survives a rewind marker without disturbing the admitted rounds', () => {
    const session = Session.create(SessionId('goal-fold'))
    session.append('goal/change', {
      kind: 'goal/change',
      version: 1,
      operation: 'create',
      goal: { id: GoalId('g-1'), revision: 1, objective: 'probe', phase: 'active', maxGoalRounds: 3 },
      roundsStarted: 0,
      createdAt: 1,
      updatedAt: 1,
    })
    const before = foldGoal(session.events)
    expect(before.goal?.id).toBe(GoalId('g-1'))

    // One real conversation turn, then a rewind that shadows part of it.
    session.append('turn/start', { turn: 1 })
    session.append('step/start', { turn: 1, step: 1 })
    session.append('user/message', textMessage('question'), { surfaceOp: 'append' })
    session.append('assistant/message', {
      turn: 1,
      step: 1,
      message: assistantMessage('answer'),
    }, { surfaceOp: 'append' })
    session.append('step/end', { turn: 1, step: 1 })
    session.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
    applyRewind(session, session.surface.nodes[0]!)

    expect(() => foldGoal(session.events)).not.toThrow()
    const after = foldGoal(session.events)
    expect(after.goal?.id).toBe(GoalId('g-1'))
    expect(after.roundsStarted).toBe(before.roundsStarted)
  })
})
