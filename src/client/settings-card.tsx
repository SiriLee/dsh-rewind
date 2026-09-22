/**
 * This bundle's configuration form for the snapshot-cleanup policy, rendered
 * on its Plugins-page card (`plugins.bundle.config`, keyed by the package
 * name).
 *
 * The staging model, the field controls, and the form frame are the harness's
 * own (`SettingsFormModel` + `SettingsValueField` + `SettingsForm`); the one
 * control the official set does not provide is a boolean-with-reset, so the
 * switch follows the official subagent page (`Switch` inside the form body)
 * and stages through the same model.
 *
 * @module dsh-rewind/client/settings-card
 */

import { SettingsFormModel, settingsNumberField, SettingsForm, SettingsValueField, Switch } from '@deepseek-ai/dsh-client-ui-primitives'
import type { SettingsFieldState, SettingsFormActions, SettingsFormLabels } from '@deepseek-ai/dsh-client-ui-primitives'

/**
 * The plugin entry whose form this is: the bundle's package name, which is the
 * profile entry id the host addresses the configuration by.
 */
export const CLEANUP_ENTRY_ID = 'dsh-rewind-plugin'

/** The default max age; an empty numeric draft means "use this". */
export const DEFAULT_MAX_AGE_DAYS = 30

/** The two editable knobs, exactly as the host policy exposes them. */
export interface CleanupPolicy {
  readonly enabled: boolean
  readonly maxAgeDays: number
}

/** Translate one client dictionary key. */
export type CardTranslate = (key: string, params?: Record<string, string | number>) => string

/** The staged-write shape the model's field spec returns. */
type FieldWrite = { readonly kind: 'set'; readonly value: unknown } | { readonly kind: 'clear' }

/** How one field converts between its stored value and its draft text. */
interface FieldSpec {
  readonly field: string
  readonly format: (value: unknown) => string
  readonly parse: (text: string) => FieldWrite | undefined
}

/**
 * The `enabled` field: a two-state control, so every edit is a set and never a
 * clear (the schema default already means "off").
 * @returns the field's conversion spec.
 */
function enabledField(): FieldSpec {
  return {
    field: 'enabled',
    format: value => String(value === true),
    parse: text => ({ kind: 'set', value: text === 'true' }),
  }
}

/** One form snapshot as this card reads it (the shared store's `getSnapshot`). */
/** One form snapshot as this card reads it (the shared store's `getSnapshot`). */
interface SnapshotLike {
  readonly status: 'loading' | 'ready' | 'unavailable'
  readonly available: boolean
  readonly writable: boolean
  readonly dirty: boolean
  readonly invalid: boolean
  readonly saving: boolean
  readonly failed: boolean
  readonly enabled: SettingsFieldState
  readonly maxAgeDays: SettingsFieldState
}

/** The bound card store the slot renderer reads through. */
interface CardStore {
  getSnapshot(): SnapshotLike
  subscribe(listener: () => void): () => void
}

/**
 * The shared per-entry form this card stages over: the harness's
 * `SettingsFormScope` read/write face, declared structurally so the card never
 * couples to an internal declaration file's path.
 */
export interface CleanupFormScope<T> {
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

/** Props the Plugins page binds for this bundle's configuration form. */
export interface SettingsCleanupCardProps {
  readonly view?: 'summary' | 'page'
  readonly t?: CardTranslate
  readonly hooks?: { readonly cleanupCard: CardStore }
  readonly save?: () => void
  readonly discard?: () => void
  readonly edit?: (field: string, text: string) => void
  readonly resetField?: (field: string) => void
}

/** The form frame's copy, read from this plugin's dictionary. */
export function formLabels(t: CardTranslate): SettingsFormLabels {
  return {
    unavailable: t('cleanup.unavailable'),
    readOnly: t('cleanup.readonly'),
    saveFailed: t('cleanup.saveFailed'),
    save: t('cleanup.save'),
    saving: t('cleanup.saving'),
  }
}

/**
 * Build the staged form over one entry's configuration.
 * @param scope - the shared per-entry configuration form.
 * @param t - the card's dictionary translator.
 * @returns the model plus the card's bound read hook.
 */
export function cleanupForm(scope: CleanupFormScope<CleanupPolicy>, t: CardTranslate) {
  const form = new SettingsFormModel<CleanupPolicy>(scope, [
    enabledField(),
    settingsNumberField('maxAgeDays'),
  ])
  return {
    form,
    store: form.bind((): SnapshotLike => {
      const shell = form.shell()
      return {
        ...shell,
        status: shell.available ? 'ready' : 'unavailable',
        enabled: form.field('enabled'),
        maxAgeDays: form.field('maxAgeDays'),
      }
    }),
    labels: formLabels(t),
  }
}

/**
 * The bundle's configuration form; `summary` renders nothing (the page only
 * asks a bundle configuration for its `page` form).
 * @param props - the view, the card's read hook, locale seat, and form actions.
 * @returns the form element, or null for the summary view.
 */
export function SettingsCleanupCard(props: SettingsCleanupCardProps) {
  const t = props.t ?? ((key: string) => key)
  const store = props.hooks?.cleanupCard
  const state = store?.getSnapshot()
  if (props.view === 'summary' || state === undefined) return null
  if (state.status !== 'ready') {
    return <p className="dsh-rewind-cleanup-unavailable" role="status">{t('cleanup.unavailable')}</p>
  }
  const disabled = !state.writable || state.saving
  const enabled = state.enabled.text === 'true'
  return (
    <SettingsForm
      labels={formLabels(t)}
      state={state}
      onSave={() => { props.save?.() }}
      onDiscard={() => { props.discard?.() }}
    >
      <div className="dsh-rewind-cleanup-permission">
        <div className="dsh-rewind-cleanup-toggle-row">
          <span className="dsh-rewind-cleanup-toggle-label">{t('cleanup.auto')}</span>
          <Switch
            checked={enabled}
            label={t('cleanup.auto')}
            disabled={disabled}
            onChange={(next) => { props.edit?.('enabled', String(next)) }}
          />
        </div>
        <p className="dsh-rewind-cleanup-hint">{t(enabled ? 'cleanup.auto.on' : 'cleanup.auto.off')}</p>
      </div>
      {enabled ? (
        <SettingsValueField
          id="dsh-rewind-cleanup-maxage"
          label={t('cleanup.maxAge')}
          hint={t('cleanup.maxAge.hint')}
          overriddenLabel={t('cleanup.overridden')}
          resetLabel={t('cleanup.reset')}
          invalidLabel={t('cleanup.invalid')}
          placeholder={String(DEFAULT_MAX_AGE_DAYS)}
          numeric
          disabled={disabled}
          {...state.maxAgeDays}
          onEdit={(text) => { props.edit?.('maxAgeDays', text) }}
          onReset={() => { props.resetField?.('maxAgeDays') }}
        />
      ) : null}
    </SettingsForm>
  )
}

/** The face the slot registration injects into the card. */
export interface SettingsCleanupFace extends SettingsFormActions {
  readonly hooks: { readonly cleanupCard: CardStore }
}

/** The card's snapshot store type (the registration's injected hook). */
export type SettingsCleanupStore = SettingsCleanupFace['hooks']['cleanupCard']
