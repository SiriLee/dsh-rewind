/**
 * The official user/steering row shape the A2 mount takes over, shared by the
 * mount probes and the client-lifecycle wiring test: a `memo` component (like
 * the real `UserMessageNodeView`) returning a bubble element whose `actions`
 * prop builds the actions row, and an actions row that takes `extraActions`
 * (the official `MessageIconActions` prop the action is injected through).
 *
 * @module tests/support/chat-row
 */
import { createElement, memo, type ReactNode } from 'react'

/** The row element's actions-row constructor. */
export type ActionsConstructor = (text: string) => ReactNode

/** The official actions row: Copy, then whatever extra actions were injected. */
export function ActionsRow({ extraActions }: { extraActions?: ReactNode }): ReactNode {
  return createElement('div', { 'data-actions': '' },
    createElement('button', { type: 'button', 'data-copy': '' }, 'copy'),
    extraActions,
  )
}

/** The official row bubble: holds the actions-row constructor. */
export function Bubble({ text, actions }: { text: string; actions: ActionsConstructor }): ReactNode {
  return createElement('div', { 'data-row': '' },
    createElement('span', { 'data-bubble': '' }, 'message body'),
    actions(text),
  )
}

/** The text the fake row reports to its actions-row constructor. */
export const ROW_TEXT = 'the message text'

/** The official renderer shape: `memo(fn)` returning the row element. */
export const officialRow = memo(function OfficialUserRow(): ReactNode {
  return createElement(Bubble, { text: ROW_TEXT, actions: () => createElement(ActionsRow, {}) })
})

/** The props the real keyed slot composes for a user/steering row. */
export const ROW_PROPS: Record<string, unknown> = {
  sessionId: 's1',
  node: { kind: 'user', data: { seq: 7, time: 1_700_000_000_000 } },
}
