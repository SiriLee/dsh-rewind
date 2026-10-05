/**
 * @vitest-environment jsdom
 */

/**
 * Turn-rail reconciliation probes.
 *
 * The host's `turnOutline` projection is a pure `turn/start` fold that ignores
 * `surfaceOp` and exposes no removal API, so a rewind leaves rail marks behind
 * while the transcript correctly drops the same Turns. These probes pin the
 * client-side reconciliation: which Turns count as withdrawn, how a Turn maps
 * onto its mark's array index, and that both hide passes degrade instead of
 * throwing when the DOM does not line up.
 */
import { beforeEach, describe, expect, it } from 'vitest'
import {
  hideWithdrawnTurnMarks,
  outlineTurnsOf,
  railIndexResolverOf,
  withdrawnTurnsOf,
} from '../src/client/turn-rail.ts'
import type { ChatConversationViewNode, HiddenChat } from '../src/client/hidden.ts'

/** A chat snapshot holding one Turn-scoped `turn-tail` node per Turn number. */
function chatOfTurns(turns: readonly number[]): HiddenChat {
  const nodes = new Map<string, ChatConversationViewNode>()
  for (const turn of turns) {
    nodes.set(`t${turn}`, { key: `t${turn}`, kind: 'turn-tail', anchorSeq: turn, data: { turn } })
  }
  return {
    order: [...nodes.keys()],
    nodes: { get: key => nodes.get(key) },
  }
}

describe('withdrawnTurnsOf', () => {
  it('reports only the Turns whose rows were withdrawn', () => {
    expect([...withdrawnTurnsOf(chatOfTurns([1, 2, 3]), new Set([2]))]).toEqual([2])
  })

  it('reports every Turn a single rewind swept', () => {
    // The rewind cut [2, 9] across two Turns; both lost their rows, so both
    // lose their rail marks.
    expect([...withdrawnTurnsOf(chatOfTurns([1, 2, 3]), new Set([2, 3]))]).toEqual([2, 3])
  })

  it('degrades to an empty set without a chat snapshot', () => {
    expect(withdrawnTurnsOf(undefined, new Set([2])).size).toBe(0)
  })

  it('degrades to an empty set when nothing was withdrawn', () => {
    expect(withdrawnTurnsOf(chatOfTurns([1, 2]), new Set()).size).toBe(0)
  })

  it('ignores non-Turn-scoped nodes, which carry no Turn number', () => {
    const nodes = new Map<string, ChatConversationViewNode>([
      ['u', { key: 'u', kind: 'user', anchorSeq: 2, data: { seq: 2, content: [] } }],
    ])
    const chat: HiddenChat = { order: ['u'], nodes: { get: key => nodes.get(key) } }
    expect(withdrawnTurnsOf(chat, new Set([2])).size).toBe(0)
  })
})

describe('outlineTurnsOf', () => {
  it('reads turns from the projection wire shape, ascending', () => {
    expect(outlineTurnsOf({ entries: [{ turn: 3 }, { turn: 1 }, { turn: 2 }] })).toEqual([1, 2, 3])
  })

  it('de-duplicates repeated turns', () => {
    expect(outlineTurnsOf([{ turn: 1 }, { turn: 1 }, { turn: 2 }])).toEqual([1, 2])
  })

  it('degrades to an empty list for a value that is not the projection shape', () => {
    expect(outlineTurnsOf(undefined)).toEqual([])
    expect(outlineTurnsOf('nonsense')).toEqual([])
    expect(outlineTurnsOf({ entries: [{ turn: 'x' }, {}, null] })).toEqual([])
  })

  it('ignores a nested turn deeper than the depth limit', () => {
    const deep = { a: { b: { c: { d: { e: [{ turn: 9 }] } } } } }
    expect(outlineTurnsOf(deep)).toEqual([])
  })
})

describe('railIndexResolverOf', () => {
  it("maps a Turn to its rank in the ascending array — its mark's data-index", () => {
    const indexOf = railIndexResolverOf({ entries: [{ turn: 1 }, { turn: 2 }, { turn: 3 }] })
    expect([indexOf(1), indexOf(2), indexOf(3)]).toEqual([0, 1, 2])
  })

  it('returns undefined for a Turn absent from the projection', () => {
    const indexOf = railIndexResolverOf({ entries: [{ turn: 1 }] })
    expect(indexOf(7)).toBeUndefined()
  })

  it('returns undefined for every Turn when the projection is absent', () => {
    const indexOf = railIndexResolverOf(undefined)
    expect(indexOf(1)).toBeUndefined()
  })
})

describe('hideWithdrawnTurnMarks', () => {
  beforeEach(() => { document.body.innerHTML = '' })

  /** Fill the document with one footer per Turn and rail marks at these indexes. */
  function domOf(footers: readonly number[], marks: readonly number[]): void {
    for (const turn of footers) {
      const footer = document.createElement('div')
      footer.setAttribute('data-turn-tail', String(turn))
      document.body.appendChild(footer)
    }
    for (const index of marks) {
      const mark = document.createElement('button')
      mark.setAttribute('data-index', String(index))
      document.body.appendChild(mark)
    }
  }

  it('hides the footer and the rail mark of a withdrawn Turn', () => {
    domOf([1, 2, 3], [0, 1, 2])
    const marked: string[] = []
    hideWithdrawnTurnMarks(new Set([3]), railIndexResolverOf({ entries: [{ turn: 1 }, { turn: 2 }, { turn: 3 }] }), document, element => { marked.push(element.tagName) })

    const footers = [...document.querySelectorAll<HTMLElement>('[data-turn-tail]')]
    expect(footers.map(row => row.style.display)).toEqual(['', '', 'none'])
    const marks = [...document.querySelectorAll<HTMLElement>('[data-index]')]
    expect(marks.map(row => row.style.display)).toEqual(['', '', 'none'])
    expect(marked).toContain('DIV')
    expect(marked).toContain('BUTTON')
  })

  it('hides footers alone when the projection carries no index mapping', () => {
    domOf([1, 2], [0, 1])
    hideWithdrawnTurnMarks(new Set([2]), () => undefined, document, () => {})

    expect([...document.querySelectorAll<HTMLElement>('[data-turn-tail]')].map(row => row.style.display)).toEqual(['', 'none'])
    // No mapping means no mark may be hidden — hiding an unverified index
    // would take down an unrelated Turn's mark.
    expect([...document.querySelectorAll<HTMLElement>('[data-index]')].map(row => row.style.display)).toEqual(['', ''])
  })

  it('marks a hidden row with the observation attribute by default', () => {
    domOf([1], [])
    hideWithdrawnTurnMarks(new Set([1]), () => undefined, document)
    const footer = document.querySelector<HTMLElement>('[data-turn-tail]')!
    expect(footer.getAttribute('data-dsh-rewind-hidden')).toBe('true')
  })

  it('does not re-mark an already hidden row', () => {
    domOf([1], [])
    let marks = 0
    hideWithdrawnTurnMarks(new Set([1]), () => undefined, document, () => { marks++ })
    hideWithdrawnTurnMarks(new Set([1]), () => undefined, document, () => { marks++ })
    expect(marks).toBe(1)
  })

  it('is a no-op when no Turn was withdrawn', () => {
    domOf([1], [0])
    hideWithdrawnTurnMarks(new Set(), railIndexResolverOf({ entries: [{ turn: 1 }] }), document)
    expect([...document.querySelectorAll<HTMLElement>('[data-turn-tail]')][0]!.style.display).toBe('')
  })

  it('degrades to a no-op when the harness attributes are gone', () => {
    // An empty document: no footer, no mark. Nothing to hide, nothing thrown.
    expect(() => hideWithdrawnTurnMarks(new Set([1]), () => 0, document)).not.toThrow()
  })

  it('hides both the transcript footer and the rail mark of a swept Turn', () => {
    // The reported bug, end to end: a rewind withdrawing Turn 2's rows. The
    // transcript hid the footer, but the rail kept its mark.
    domOf([1, 2, 3], [0, 1, 2])
    const chat = chatOfTurns([1, 2, 3])
    const outline = { entries: [{ turn: 1 }, { turn: 2 }, { turn: 3 }] }

    hideWithdrawnTurnMarks(withdrawnTurnsOf(chat, new Set([2])), railIndexResolverOf(outline), document)

    expect([...document.querySelectorAll<HTMLElement>('[data-turn-tail]')].map(row => row.style.display)).toEqual(['', 'none', ''])
    expect([...document.querySelectorAll<HTMLElement>('[data-index]')].map(row => row.style.display)).toEqual(['', 'none', ''])
  })

  it('leaves a Turn before the rewind target alone', () => {
    domOf([1, 2, 3], [0, 1, 2])
    hideWithdrawnTurnMarks(withdrawnTurnsOf(chatOfTurns([1, 2, 3]), new Set([2, 3])), railIndexResolverOf({ entries: [{ turn: 1 }, { turn: 2 }, { turn: 3 }] }), document)

    expect([...document.querySelectorAll<HTMLElement>('[data-index]')].map(row => row.style.display)).toEqual(['', 'none', 'none'])
  })
})
