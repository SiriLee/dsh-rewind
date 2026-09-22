/**
 * Test stand-in for `@deepseek-ai/dsh-client-ui-primitives`, aliased in
 * `vitest.config.ts`: the published bundle imports shell-supplied heavyweights
 * (`shiki/core`, `anser`, …) that a plugin checkout does not install. The
 * plugin's own code still typechecks against the real declarations, so add an
 * export here when it starts using more of the package.
 *
 * The settings-form members mirror the published bundle's staging contract
 * (`SettingsFormModel` + the shared field controls); `Switch` and `Tag` mirror
 * the real controls.
 *
 * @module tests/support/ui-primitives-stub
 */
import { createElement, useState, type ReactNode } from 'react'

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

/** One field's staged draft state. */
export interface SettingsFieldState {
  readonly text: string
  readonly overridden: boolean
  readonly invalid: boolean
}

/** The form-level state every card shares. */
export interface SettingsFormShell {
  readonly available: boolean
  readonly writable: boolean
  readonly dirty: boolean
  readonly invalid: boolean
  readonly saving: boolean
  readonly failed: boolean
}

/** The form actions a card's slot entry injects. */
export interface SettingsFormActions {
  readonly edit: (field: string, text: string) => void
  readonly resetField: (field: string) => void
  readonly save: () => void
  readonly discard: () => void
}

/** The form frame's copy. */
export interface SettingsFormLabels {
  readonly unavailable: string
  readonly readOnly: string
  readonly saveFailed: string
  readonly save: string
  readonly saving: string
}

/** The shared per-entry form a card stages over. */
export interface SettingsFormScope<T> {
  getSnapshot(): {
    readonly status: 'loading' | 'ready' | 'unavailable'
    readonly value: T | undefined
    readonly base: unknown
    readonly user: unknown
    readonly writable: boolean
    readonly revision: number | undefined
  }
  subscribe(listener: () => void): () => void
  mutate(
    ops: readonly (
      | { readonly op: 'set'; readonly path: readonly string[]; readonly value: unknown }
      | { readonly op: 'unset'; readonly path: readonly string[] }
    )[],
    expectedRevision?: number,
  ): Promise<boolean>
}

/** How one section field converts between its stored value and its draft text. */
export interface SettingsFieldSpec {
  readonly field: string
  readonly format: (value: unknown) => string
  readonly parse: (text: string) => { readonly kind: 'set'; readonly value: unknown } | { readonly kind: 'clear' } | undefined
}

/** A whole-number field: an empty draft clears, anything unparsable blocks the save. */
export function settingsNumberField(field: string): SettingsFieldSpec {
  return {
    field,
    format: value => typeof value === 'number' ? String(value) : '',
    parse: (text) => {
      const trimmed = text.trim()
      if (trimmed === '') return { kind: 'clear' }
      const parsed = Number(trimmed)
      return Number.isFinite(parsed) ? { kind: 'set', value: parsed } : undefined
    },
  }
}

/** The staged write one field resolves to. */
interface PlannedWrite {
  readonly field: string
  readonly run?: () => Promise<boolean>
  readonly op?: { readonly op: 'set'; readonly path: readonly string[]; readonly value: unknown } | { readonly op: 'unset'; readonly path: readonly string[] }
}

/** A minimal but faithful `SettingsFormModel`: stage, plan, save, discard. */
export class SettingsFormModel<T> {
  private readonly specs: Map<string, SettingsFieldSpec>
  private readonly staged = new Map<string, { readonly text: string; readonly clear: boolean }>()
  private readonly listeners = new Set<() => void>()
  private saving = false
  private failed = false

  constructor(
    private readonly scope: SettingsFormScope<T>,
    specs: readonly SettingsFieldSpec[],
  ) {
    this.specs = new Map(specs.map(spec => [spec.field, spec]))
    this.scope.subscribe(() => { this.publish() })
  }

  bind<S>(project: () => S): { getSnapshot(): S; subscribe(listener: () => void): () => void } {
    let current = project()
    const listeners = new Set<() => void>()
    this.listeners.add(() => {
      current = project()
      for (const listener of listeners) listener()
    })
    return {
      getSnapshot: () => current,
      subscribe: (listener) => { listeners.add(listener); return () => { listeners.delete(listener) } },
    }
  }

  shell(): SettingsFormShell {
    const plan = this.plan()
    return {
      available: this.scope.getSnapshot().status === 'ready',
      writable: this.scope.getSnapshot().writable,
      dirty: plan.length > 0,
      invalid: plan.some(item => item.op === undefined),
      saving: this.saving,
      failed: this.failed,
    }
  }

  field(field: string): SettingsFieldState {
    const spec = this.spec(field)
    const staged = this.staged.get(field)
    if (staged === undefined) {
      return { text: spec.format(this.sectionValue(field)), overridden: this.stored(field), invalid: false }
    }
    const write = staged.clear ? { kind: 'clear' as const } : spec.parse(staged.text)
    return { text: staged.text, overridden: write?.kind === 'set', invalid: write === undefined }
  }

  actions(): SettingsFormActions {
    return {
      edit: (field, text) => { this.staged.set(field, { text, clear: false }); this.publish() },
      resetField: (field) => {
        this.staged.set(field, { text: this.spec(field).format(this.baseValue(field)), clear: true })
        this.publish()
      },
      save: () => { void this.save() },
      discard: () => { this.staged.clear(); this.failed = false; this.publish() },
    }
  }

  async save(): Promise<void> {
    const plan = this.plan()
    if (plan.length === 0 || this.saving || !this.scope.getSnapshot().writable
      || plan.some(item => item.op === undefined)) return
    this.saving = true
    this.failed = false
    this.publish()
    try {
      const ops = plan.flatMap(item => item.op === undefined ? [] : [item.op])
      const landed = await this.scope.mutate(ops)
      if (landed) this.staged.clear()
      this.failed = !landed
    } catch {
      this.failed = true
    } finally {
      this.saving = false
      this.publish()
    }
  }

  private plan(): PlannedWrite[] {
    const plan: PlannedWrite[] = []
    for (const [field, staged] of this.staged) {
      const spec = this.spec(field)
      if (staged.clear) {
        if (this.stored(field)) plan.push({ field, op: { op: 'unset', path: [field] } })
        continue
      }
      if (staged.text === spec.format(this.sectionValue(field))) continue
      const write = spec.parse(staged.text)
      if (write === undefined) plan.push({ field })
      else if (write.kind === 'clear') plan.push({ field, op: { op: 'unset', path: [field] } })
      else plan.push({ field, op: { op: 'set', path: [field], value: write.value } })
    }
    return plan
  }

  private spec(field: string): SettingsFieldSpec {
    const spec = this.specs.get(field)
    if (spec === undefined) throw new Error(`plugin card has no field ${field}`)
    return spec
  }

  private sectionValue(field: string): unknown {
    return (this.scope.getSnapshot().value as Record<string, unknown> | undefined)?.[field]
  }

  private baseValue(field: string): unknown {
    return (this.scope.getSnapshot().base as Record<string, unknown> | undefined)?.[field]
  }

  private stored(field: string): boolean {
    const user = this.scope.getSnapshot().user
    return typeof user === 'object' && user !== null && Object.hasOwn(user, field)
  }

  private publish(): void { for (const listener of this.listeners) listener() }
}

/** The shared form frame: the copy, the state, and the save/discard controls. */
export function SettingsForm({ labels, state, onSave, onDiscard, children }: {
  readonly labels: SettingsFormLabels
  readonly state: SettingsFormShell
  readonly onSave: () => void
  readonly onDiscard: () => void
  readonly children?: ReactNode
}): ReactNode {
  return createElement('div', { className: 'settings-form' },
    !state.writable ? createElement('p', { role: 'status' }, labels.readOnly) : null,
    children,
    state.failed ? createElement('p', { role: 'status' }, labels.saveFailed) : null,
    createElement('button', {
      type: 'button',
      disabled: !state.dirty || state.invalid || state.saving,
      onClick: () => { onSave() },
    }, state.saving ? labels.saving : labels.save),
    createElement('button', { type: 'button', onClick: () => { onDiscard() } }, 'discard'),
  )
}

/** A staged text/number field: a labelled input with the override badge and reset. */
export function SettingsValueField(props: {
  readonly id: string
  readonly label: string
  readonly hint: string
  readonly text: string
  readonly overridden: boolean
  readonly invalid: boolean
  readonly overriddenLabel: string
  readonly resetLabel: string
  readonly invalidLabel: string
  readonly disabled: boolean
  readonly numeric?: boolean
  readonly placeholder?: string
  readonly onEdit: (text: string) => void
  readonly onReset: () => void
}): ReactNode {
  const [helpOpen] = useState(false)
  void helpOpen
  return createElement('div', { className: 'settings-field' },
    createElement('label', { htmlFor: props.id }, props.label),
    props.overridden
      ? [
        createElement('span', { key: 'badge' }, props.overriddenLabel),
        createElement('button', { key: 'reset', type: 'button', disabled: props.disabled, onClick: props.onReset }, props.resetLabel),
      ]
      : null,
    createElement('input', {
      id: props.id,
      type: 'text',
      value: props.text,
      placeholder: props.placeholder ?? '',
      disabled: props.disabled,
      ...(props.invalid ? { 'aria-invalid': true } : {}),
      onChange: (event: { target: { value: string } }) => { props.onEdit(event.target.value) },
    }),
    props.invalid
      ? createElement('p', null, props.invalidLabel)
      : createElement('p', null, props.hint),
  )
}

