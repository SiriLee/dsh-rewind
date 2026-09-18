/**
 * Test stand-in for `@deepseek-ai/dsh-client-ui-primitives`, aliased in
 * `vitest.config.ts`: the published bundle imports shell-supplied heavyweights
 * (`shiki/core`, `anser`, …) that a plugin checkout does not install. The
 * plugin's own code still typechecks against the real declarations, so add an
 * export here when it starts using more of the package.
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
