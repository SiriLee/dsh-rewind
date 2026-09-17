/**
 * Test stand-in for `@deepseek-ai/dsh-client-ui-primitives`.
 *
 * The published bundle of the real package imports the heavyweight libraries
 * the Web shell supplies at runtime (`shiki/core`, `@shikijs/*`, `anser`, …),
 * which a plugin checkout does not install — so any test that loads the client
 * entry (which reaches this package through the settings form) would fail to
 * resolve them. `vitest.config.ts` aliases the specifier here for the whole
 * suite; the plugin's own code still typechecks against the REAL package's
 * declarations, and this stub mirrors only the contract the plugin renders
 * against.
 *
 * Extend the stub when the plugin starts using more of the primitives
 * (a missing export fails loudly at test time, not silently).
 *
 * @module tests/support/ui-primitives-stub
 */
import { createElement, type ReactNode } from 'react'

/** The real `Switch` contract: a controlled `role="switch"` button with a label. */
export function Switch({ checked, onChange, label, disabled = false, title, className }: {
  readonly checked: boolean
  readonly onChange: (next: boolean) => void
  readonly label: string
  readonly disabled?: boolean
  readonly title?: string | undefined
  readonly className?: string | undefined
}): ReactNode {
  return createElement('button', {
    type: 'button',
    role: 'switch',
    'aria-checked': checked,
    'aria-label': label,
    title,
    disabled,
    className,
    onClick: () => { onChange(!checked) },
  }, createElement('span'))
}

/** The real `Tag` contract: a read-only capsule that renders its children. */
export function Tag({ children }: {
  readonly tone?: 'outline' | 'solid' | 'neutral' | 'quiet' | 'success' | 'info' | 'warning' | 'danger'
  readonly className?: string | undefined
  readonly children?: ReactNode
}): ReactNode {
  return createElement('span', null, children)
}
