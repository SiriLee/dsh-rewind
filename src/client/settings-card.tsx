/**
 * dsh-rewind's configuration form for the Snapshot cleanup policy, rendered on
 * this bundle's page under the sidebar's Plugins page (`plugins.bundle.config`,
 * keyed by the bundle package name — 0.1.6-alpha.2 deleted the per-namespace
 * `settings.plugin.item` slot).
 *
 * The harness forms (`PluginConfigForm`, `CardForm`, `ValueField`) are
 * package-internal — `ui-settings-plugins` ships `lib/**` only — so their
 * behaviour and numbers are re-implemented here rather than imported; each rule
 * below names the official function it mirrors. The switch follows
 * `SubagentModelSelectionFields` (the official ships no boolean-with-reset
 * control, so its entry point is the plain staged toggle) and the number
 * follows `ValueField`.
 *
 * Two deliberate divergences, both where the official provides the entry point
 * but no card uses it: the optional `help` disclosure is unused (it needs a
 * second, help-only copy), and `placeholder` shows the host default (an empty
 * draft means "use the default", and nothing else would say what that is).
 *
 * The transport is the structural {@link CleanupCardApi} supplied by
 * `src/client/index.ts`: no client-settings type import, no `mutate`.
 *
 * @module dsh-rewind/client/settings-card
 */

import { useEffect, useState } from 'react'
import { Switch, Tag } from '@deepseek-ai/dsh-client-ui-primitives'

/**
 * The dsh-settings namespace, duplicated from the host module (the client build
 * must stay free of host/node imports); both sides pin the literal.
 */
export const CLEANUP_SETTINGS_NAMESPACE = 'dsh-rewind-snapshot-cleanup'

/** The default max age; an empty draft means "use this". */
export const DEFAULT_MAX_AGE_DAYS = 30

/** The two editable knobs, exactly as the host policy exposes them. */
export interface CleanupPolicy {
  readonly enabled: boolean
  readonly maxAgeDays: number
}

/** One editable field, named exactly as the host's settings section names it. */
export type CleanupField = 'enabled' | 'maxAgeDays'

/** The value type one field writes. */
export type CleanupValue = boolean | number

/** One staged edit: the text the control renders, and whether saving clears the field. */
export interface StagedEdit {
  /** Draft text the control renders. */
  readonly text: string
  /** True when this edit clears the field whatever text it shows. */
  readonly clear: boolean
}

/** The staged edits, keyed by field (iteration order is staging order). */
export type StagedEdits = ReadonlyMap<CleanupField, StagedEdit>

/**
 * One entry in the save plan (the official `PlannedWrite`): `invalid` carries no
 * write, which keeps the form dirty and makes the save refuse.
 */
export type PlannedWrite =
  | { readonly field: CleanupField; readonly kind: 'set'; readonly value: CleanupValue }
  | { readonly field: CleanupField; readonly kind: 'clear' }
  | { readonly field: CleanupField; readonly kind: 'invalid' }

/** The reads one field's staging needs (the official scope reads). */
export interface CleanupFieldReads {
  /** The resolved (effective) value of the field, if the section carries one. */
  readonly value: CleanupValue | undefined
  /** Whether the USER layer carries the field (presence, never value equality). */
  readonly stored: boolean
}

/** The structural api the card reads/writes through (supplied by the client). */
export interface CleanupCardApi {
  /**
   * Whether the namespace is served to this client. The official shell reads
   * `status === 'ready'`, so a still-loading namespace is NOT available.
   */
  available(): boolean
  /** Whether the settings source accepts writes (false = read-only card). */
  writable(): boolean
  /** The resolved (effective) value of one field. */
  read(field: CleanupField): CleanupValue | undefined
  /** The COMPOSITION value of one field, which a reset reverts to. */
  base(field: CleanupField): CleanupValue | undefined
  /** Whether the user layer carries one field. */
  stored(field: CleanupField): boolean
  /** Write one field; resolves to whether the Host holds the value afterwards. */
  set(field: CleanupField, value: CleanupValue): Promise<boolean>
  /** Clear one field; resolves to whether the user layer no longer carries it. */
  unset(field: CleanupField): Promise<boolean>
  /** Optional change subscription (returns the disposer). */
  subscribe(cb: () => void): () => void
}

/** Translate one client dictionary key (the card's `t`). */
export type CardTranslate = (key: string, params?: Record<string, string | number>) => string

/** The write a max-age draft stages. */
export type MaxAgeWrite = { readonly kind: 'clear' } | { readonly kind: 'set'; readonly value: number }

/** The parsed form of one field's draft. */
export type FieldWrite = { readonly kind: 'clear' } | { readonly kind: 'set'; readonly value: CleanupValue }

/**
 * The write a max-age draft stages, or undefined when the draft is not a value
 * this field accepts (an invalid draft blocks the save rather than dropping the
 * edit). An EMPTY draft clears, matching the official `numberField` spec.
 * @param text - the control's draft text.
 * @returns the staged write, or undefined when the draft is invalid.
 */
export function parseMaxAge(text: string): MaxAgeWrite | undefined {
  const trimmed = text.trim()
  if (trimmed === '') return { kind: 'clear' }
  if (!/^\d+$/.test(trimmed)) return undefined
  const days = Number(trimmed)
  return Number.isSafeInteger(days) && days > 0 ? { kind: 'set', value: days } : undefined
}

/** Render a stored value as the max-age control's draft text (the official `numberField.format`). */
export function formatMaxAge(value: unknown): string {
  return typeof value === 'number' ? String(value) : ''
}

/** Render a stored value as the switch's draft text. */
export function formatEnabled(value: unknown): string {
  return String(value === true)
}

/**
 * The write a boolean draft stages: the official switch is two-state, so every
 * staged edit is a set and never a clear.
 * @param text - the staged toggle text (`'true'` / `'false'`).
 * @returns the staged write.
 */
export function parseEnabled(text: string): { kind: 'set'; value: boolean } {
  return { kind: 'set', value: text === 'true' }
}

/** Format one field's value as draft text. */
export function formatOf(field: CleanupField, value: unknown): string {
  return field === 'enabled' ? formatEnabled(value) : formatMaxAge(value)
}

/** Parse one field's draft through its own spec. */
export function parseOf(field: CleanupField, text: string): FieldWrite | undefined {
  return field === 'enabled' ? parseEnabled(text) : parseMaxAge(text)
}

/**
 * The text one field's control renders: the staged draft when one stands,
 * otherwise the effective value.
 * @param field - field to render.
 * @param staged - the current staged edits.
 * @param reads - the field's effective value.
 * @returns the control text.
 */
export function textOf(field: CleanupField, staged: StagedEdits, reads: CleanupFieldReads): string {
  const edit = staged.get(field)
  return edit !== undefined ? edit.text : formatOf(field, reads.value)
}

/**
 * Whether saving would leave a user-layer entry for one field (the official
 * `field().overridden`): a staged set answers true, a staged clear false, and
 * with nothing staged the user layer's presence decides.
 * @param field - field to judge.
 * @param staged - the current staged edits.
 * @param reads - the field's effective value and user-layer presence.
 * @returns whether the badge is shown.
 */
export function overriddenOf(field: CleanupField, staged: StagedEdits, reads: CleanupFieldReads): boolean {
  const edit = staged.get(field)
  if (edit === undefined) return reads.stored
  if (edit.clear) return false
  return parseOf(field, edit.text)?.kind === 'set'
}

/**
 * Whether one field's draft is invalid, which blocks the save (the official
 * `field().invalid`). A staged clear is never invalid.
 * @param field - field to judge.
 * @param staged - the current staged edits.
 * @returns whether the draft cannot be saved.
 */
export function invalidOf(field: CleanupField, staged: StagedEdits): boolean {
  const edit = staged.get(field)
  if (edit === undefined || edit.clear) return false
  return parseOf(field, edit.text) === undefined
}

/**
 * Every entry a save would act on, in staging order (the official `plan()`).
 * Two drafts plan nothing — one equal to the field's effective value, and a
 * clear of a field the user layer never carried; an invalid draft plans an
 * entry with no write, so the form stays dirty AND the save refuses.
 * @param staged - the current staged edits.
 * @param reads - per-field effective value and user-layer presence.
 * @returns the planned entries.
 */
export function planOf(
  staged: StagedEdits,
  reads: (field: CleanupField) => CleanupFieldReads,
): readonly PlannedWrite[] {
  const plan: PlannedWrite[] = []
  for (const [field, edit] of staged) {
    const read = reads(field)
    if (edit.clear) {
      if (read.stored) plan.push({ field, kind: 'clear' })
      continue
    }
    if (edit.text === formatOf(field, read.value)) continue
    const write = parseOf(field, edit.text)
    if (write === undefined) plan.push({ field, kind: 'invalid' })
    else if (write.kind === 'clear') {
      if (read.stored) plan.push({ field, kind: 'clear' })
    } else {
      plan.push({ field, kind: 'set', value: write.value })
    }
  }
  return plan
}

/** The form state the footer reads (the official `CardShell` subset this card uses). */
export interface CardShellState {
  /** Whether the form holds edits a save would act on (an invalid entry counts). */
  readonly dirty: boolean
  /** Whether any planned entry carries no write, which blocks the save. */
  readonly invalid: boolean
  readonly saving: boolean
  readonly failed: boolean
}

/**
 * The card-level state (the official `CardShell`): both `dirty` and `invalid`
 * come from the plan, so the button and the drafts cannot disagree.
 * @param plan - the entries a save would act on.
 * @param flags - the crossing-the-wire and failure flags.
 * @returns the footer's state.
 */
export function shellOf(
  plan: readonly PlannedWrite[],
  flags: { readonly saving: boolean; readonly failed: boolean },
): CardShellState {
  return {
    dirty: plan.length > 0,
    invalid: plan.some(entry => entry.kind === 'invalid'),
    saving: flags.saving,
    failed: flags.failed,
  }
}

/**
 * The bundle's configuration form; `summary` renders nothing (the page only
 * asks a bundle configuration for its `page` form).
 * @param props.view - the view the Plugins page asks for.
 * @param props.api - the read/write transport.
 * @param props.t - the client dictionary translator.
 * @returns the form element, or null for the summary view.
 */
export function SettingsCleanupCard({ view, api, t }: {
  readonly view?: 'summary' | 'page'
  readonly api: CleanupCardApi
  readonly t: CardTranslate
}) {
  const [staged, setStaged] = useState<StagedEdits>(() => new Map())
  const [saving, setSaving] = useState(false)
  const [failed, setFailed] = useState(false)
  // Re-read the effective values on every scope change; the staged text stays put.
  const [, setRevision] = useState(0)
  useEffect(() => api.subscribe(() => { setRevision(revision => revision + 1) }), [api])

  if (view === 'summary') return null

  const readField = (field: CleanupField): CleanupFieldReads => ({
    value: api.read(field),
    stored: api.stored(field),
  })
  const stage = (field: CleanupField, edit: StagedEdit): void => {
    setStaged((current) => {
      const next = new Map(current)
      next.set(field, edit)
      return next
    })
    setFailed(false)
  }

  const plan = planOf(staged, readField)
  const shell = shellOf(plan, { saving, failed })
  const writable = api.writable()
  const disabled = !writable || saving
  const blocked = !shell.dirty || shell.invalid || shell.saving

  const save = async (): Promise<void> => {
    const writes = plan.map(entry => async (): Promise<boolean> => {
      if (entry.kind === 'clear') return api.unset(entry.field)
      if (entry.kind === 'set') return api.set(entry.field, entry.value)
      return false
    })
    // The official guard: nothing to do, already crossing the wire, or an
    // invalid draft (which plans an entry that carries no write).
    if (plan.length === 0 || saving || plan.some(entry => entry.kind === 'invalid')) return
    setSaving(true)
    setFailed(false)
    let landed = true
    for (const write of writes) landed = (await write()) && landed
    if (landed) setStaged(new Map())
    setSaving(false)
    setFailed(!landed)
  }

  const enabledReads = readField('enabled')
  const enabledText = textOf('enabled', staged, enabledReads)
  const enabled = enabledText === 'true'
  const maxAgeReads = readField('maxAgeDays')
  const maxAgeText = textOf('maxAgeDays', staged, maxAgeReads)
  const maxAgeInvalid = invalidOf('maxAgeDays', staged)

  if (!api.available()) {
    return <p className="dsh-rewind-cleanup-unavailable" role="status">{t('cleanup.unavailable')}</p>
  }

  return (
    <div className="dsh-rewind-cleanup-form">
      {!writable ? <p className="dsh-rewind-cleanup-readonly" role="status">{t('cleanup.readonly')}</p> : null}
      <div className="dsh-rewind-cleanup-permission">
        <div className="dsh-rewind-cleanup-toggle-row">
          <span className="dsh-rewind-cleanup-toggle-label">{t('cleanup.auto')}</span>
          <Switch
            checked={enabled}
            label={t('cleanup.auto')}
            disabled={disabled}
            onChange={(next) => { stage('enabled', { text: formatEnabled(next), clear: false }) }}
          />
        </div>
        <p className="dsh-rewind-cleanup-hint">{t(enabled ? 'cleanup.auto.on' : 'cleanup.auto.off')}</p>
      </div>
      {enabled ? (
        <div className="dsh-rewind-cleanup-field">
          <div className="dsh-rewind-cleanup-head">
            <div className="dsh-rewind-cleanup-label-group">
              <label className="dsh-rewind-cleanup-label" htmlFor="dsh-rewind-cleanup-maxage">{t('cleanup.maxAge')}</label>
            </div>
            {overriddenOf('maxAgeDays', staged, maxAgeReads)
              ? (
                <span className="dsh-rewind-cleanup-badges">
                  <Tag tone="neutral">{t('cleanup.overridden')}</Tag>
                  <button
                    type="button"
                    className="dsh-rewind-cleanup-reset"
                    disabled={disabled}
                    onClick={() => {
                      // The official resetField stages a clear whose TEXT is the
                      // composition value, so the control shows the reverted value.
                      stage('maxAgeDays', { text: formatMaxAge(api.base('maxAgeDays')), clear: true })
                    }}
                  >
                    {t('cleanup.reset')}
                  </button>
                </span>
              )
              : null}
          </div>
          <input
            id="dsh-rewind-cleanup-maxage"
            className="dsh-rewind-cleanup-input"
            type="text"
            inputMode="numeric"
            {...maxAgeInvalid ? { 'aria-invalid': true } : {}}
            aria-describedby="dsh-rewind-cleanup-maxage-message"
            value={maxAgeText}
            placeholder={String(DEFAULT_MAX_AGE_DAYS)}
            disabled={disabled}
            onChange={(event) => { stage('maxAgeDays', { text: event.target.value, clear: false }) }}
          />
          <p
            id="dsh-rewind-cleanup-maxage-message"
            className={maxAgeInvalid ? 'dsh-rewind-cleanup-error' : 'dsh-rewind-cleanup-hint'}
          >
            {maxAgeInvalid ? t('cleanup.invalid') : t('cleanup.maxAge.hint')}
          </p>
        </div>
      ) : null}
      <div className="dsh-rewind-cleanup-footer">
        {shell.failed ? <p className="dsh-rewind-cleanup-failed" role="status">{t('cleanup.saveFailed')}</p> : null}
        <button type="button" className="dsh-rewind-cleanup-save" disabled={blocked} onClick={() => { void save() }}>
          {shell.saving ? t('cleanup.saving') : t('cleanup.save')}
        </button>
      </div>
    </div>
  )
}
