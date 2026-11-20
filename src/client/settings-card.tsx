/**
 * This bundle's configuration form for the file-checkpointing and snapshot
 * cleanup switches, rendered on its Plugins-page card (`plugins.bundle.config`,
 * keyed by the package name).
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
import type { SettingsFieldState, SettingsFormActions, SettingsFormLabels, SettingsFormShell } from '@deepseek-ai/dsh-client-ui-primitives'
import type { InjectFace, LocaleNamespaceMap, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type { RewindKey } from './locales.ts'
// Type-only: supplies the `plugins.bundle.config` slot declaration this card's
// props are composed from (the same import the official bundle pages use).
import type {} from '@deepseek-ai/dsh-client-ui-plugin-manager/client'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** The card reads the plugin's own `rewind` dictionary (see `./locales.ts`). */
    rewind: RewindKey
  }
}

/**
 * The dictionary namespace the card's copy comes from: the `rewind` namespace
 * the rest of the client plugin registers, which the slot registration declares
 * as its `locale`.
 */
export const CARD_LOCALE_NS = 'rewind'

/**
 * The plugin entry whose form this is: the bundle's package name, which is the
 * profile entry id the host addresses the configuration by.
 */
export const SETTINGS_ENTRY_ID = 'dsh-rewind-plugin'

/** The default max age; an empty numeric draft means "use this". */
export const DEFAULT_MAX_AGE_DAYS = 30

/** The editable knobs, exactly as the entry's configuration document names them. */
export interface SettingsPolicy {
  readonly fileCheckpointingEnabled: boolean
  readonly autoCleanupEnabled: boolean
  readonly autoCleanupMaxAgeDays: number
}

/** The staged-write shape the model's field spec returns. */
type FieldWrite = { readonly kind: 'set'; readonly value: unknown } | { readonly kind: 'clear' }

/** How one field converts between its stored value and its draft text. */
interface FieldSpec {
  readonly field: string
  readonly format: (value: unknown) => string
  readonly parse: (text: string) => FieldWrite | undefined
}

/**
 * The `autoCleanupEnabled` field: a two-state control, so every edit is a set
 * and never a clear (the schema default already means "off").
 * @returns the field's conversion spec.
 */
function autoCleanupEnabledField(): FieldSpec {
  return {
    field: 'autoCleanupEnabled',
    format: value => String(value === true),
    parse: text => ({ kind: 'set', value: text === 'true' }),
  }
}

/**
 * The `fileCheckpointingEnabled` field: default on, so turning it back on
 * clears the stored value and re-inherits the schema default.
 * @returns the field's conversion spec.
 */
function fileCheckpointingEnabledField(): FieldSpec {
  return {
    field: 'fileCheckpointingEnabled',
    format: value => String(value !== false),
    parse: text => text === 'true' ? { kind: 'clear' } : { kind: 'set', value: false },
  }
}

/**
 * One form snapshot as this card reads it: the shared form frame's own state
 * (`SettingsFormShell`) plus the three field drafts.
 */
export interface SettingsCardSnapshot extends SettingsFormShell {
  readonly checkpointingEnabled: SettingsFieldState
  readonly enabled: SettingsFieldState
  readonly maxAgeDays: SettingsFieldState
}

/**
 * The bound snapshot store the slot renderer rebinds as the card's
 * `useSettingsCard` selector hook.
 */
export interface SettingsCardStore {
  getSnapshot(): SettingsCardSnapshot
  subscribe(listener: () => void): () => void
}

/**
 * The shared per-entry form this card stages over: the harness's
 * `SettingsFormScope` read/write face, declared structurally so the card never
 * couples to an internal declaration file's path.
 */
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

/**
 * Props the Plugins page binds for this bundle's configuration form: the slot's
 * runtime owner share (`view`), the locale `t` seat, and the injected face with
 * its `hooks` compartment rebound as a `use<Name>` selector hook.
 */
export type SettingsCardProps =
  PropsRuntime<'plugins.bundle.config'>
  & PropsLocale<typeof CARD_LOCALE_NS>
  & InjectFace<SettingsCardFace>

/**
 * Every dictionary key this card reads: the switch row, the day field, and the
 * five labels the shared form frame renders.
 */
export type SettingsLabelKey =
  | 'backup.title'
  | 'backup.on'
  | 'backup.off'
  | 'cleanup.auto'
  | 'cleanup.auto.on'
  | 'cleanup.auto.off'
  | 'cleanup.maxAge'
  | 'cleanup.maxAge.hint'
  | 'cleanup.overridden'
  | 'cleanup.reset'
  | 'cleanup.invalid'
  | 'cleanup.unavailable'
  | 'cleanup.readonly'
  | 'cleanup.saveFailed'
  | 'cleanup.save'
  | 'cleanup.saving'

/** The form frame's copy, read from this plugin's dictionary. */
export function formLabels(t: (key: SettingsLabelKey) => string): SettingsFormLabels {
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
 * @returns the model plus the card's bound read hook.
 */
export function settingsForm(scope: SettingsFormScope<SettingsPolicy>) {
  const form = new SettingsFormModel<SettingsPolicy>(scope, [
    fileCheckpointingEnabledField(),
    autoCleanupEnabledField(),
    settingsNumberField('autoCleanupMaxAgeDays'),
  ])
  return {
    form,
    store: form.bind((): SettingsCardSnapshot => ({
      ...form.shell(),
      checkpointingEnabled: form.field('fileCheckpointingEnabled'),
      enabled: form.field('autoCleanupEnabled'),
      maxAgeDays: form.field('autoCleanupMaxAgeDays'),
    })),
  }
}

/**
 * The bundle's configuration form; `summary` renders nothing (the page only
 * asks a bundle configuration for its `page` form).
 * @param props - the view, the card's read hook, locale seat, and form actions.
 * @returns the form element, or null for the summary view.
 */
export function SettingsCard(props: SettingsCardProps) {
  const { t, useSettingsCard } = props
  const state = useSettingsCard(snapshot => snapshot)
  if (props.view === 'summary') return null
  // The shared frame renders the unavailable and read-only lines itself, from
  // the state it is given; the card only supplies the controls.
  const disabled = !state.writable || state.saving
  const checkpointing = state.checkpointingEnabled.text === 'true'
  const cleanupEnabled = state.enabled.text === 'true'
  return (
    <SettingsForm
      labels={formLabels(t)}
      state={state}
      onSave={props.save}
      onDiscard={props.discard}
    >
      <div className="dsh-rewind-settings-section">
        <div className="dsh-rewind-settings-toggle-row">
          <span className="dsh-rewind-settings-toggle-label">{t('backup.title')}</span>
          <Switch
            checked={checkpointing}
            label={t('backup.title')}
            disabled={disabled}
            onChange={(next) => { props.edit('fileCheckpointingEnabled', String(next)) }}
          />
        </div>
        <p className="dsh-rewind-settings-hint">{t(checkpointing ? 'backup.on' : 'backup.off')}</p>
      </div>
      <div className="dsh-rewind-settings-divider" />
      <div className="dsh-rewind-settings-section">
        <div className="dsh-rewind-settings-toggle-row">
          <span className="dsh-rewind-settings-toggle-label">{t('cleanup.auto')}</span>
          <Switch
            checked={cleanupEnabled}
            label={t('cleanup.auto')}
            disabled={disabled}
            onChange={(next) => { props.edit('autoCleanupEnabled', String(next)) }}
          />
        </div>
        <p className="dsh-rewind-settings-hint">{t(cleanupEnabled ? 'cleanup.auto.on' : 'cleanup.auto.off')}</p>
      </div>
      {cleanupEnabled ? (
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
          onEdit={(text) => { props.edit('autoCleanupMaxAgeDays', text) }}
          onReset={() => { props.resetField('autoCleanupMaxAgeDays') }}
        />
      ) : null}
    </SettingsForm>
  )
}

/** The face the slot registration injects into the card. */
export interface SettingsCardFace extends SettingsFormActions {
  readonly hooks: {
    readonly settingsCard: SettingsCardStore
  }
}

