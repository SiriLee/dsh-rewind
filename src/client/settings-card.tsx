/**
 * dsh-rewind client settings card: the "Snapshot cleanup" configuration form
 * on the bundle's own page under the sidebar's Plugins page.
 *
 * DSH 0.1.6-alpha.2 removed the per-namespace Settings ▸ Plugins card slot
 * (`settings.plugin.item`) and moved every plugin's configuration to the
 * Plugins page, which asks a BUNDLE for its form through
 * `plugins.bundle.config` (keyed by the bundle's package name; the page draws
 * the title, the icon, and the crumb itself). This module is that form.
 *
 * The harness's own plugin forms are package-internal — `PluginConfigForm`,
 * `CardForm` and `ValueField` ship inside `ui-settings-plugins`, whose `files`
 * is `lib/**` only — so this module re-implements their exact behaviour and
 * values rather than importing them. Every rule below mirrors those three:
 *
 * - `CardForm` staging (`card-form.ts`): a field shows its effective value;
 *   `overridden` is the write a save WOULD leave (a staged `set` answers for
 *   itself, a staged clear answers false, otherwise the user layer's presence);
 *   `dirty` and `invalid` are both derived from the planned writes, so an
 *   invalid draft plans an entry with no write — the form stays dirty and the
 *   save refuses rather than dropping the text; editing back to the effective
 *   value, or clearing a field the user layer never carried, is not an edit;
 *   `resetField` stages a clear whose TEXT is the composition value, so the
 *   control immediately shows what the field reverts to; a save writes in
 *   staging order and drops the drafts only when every write landed.
 * - `PluginConfigForm` chrome: an unavailable namespace replaces the whole form
 *   with one status line; a read-only document says so above the controls; the
 *   save is blocked by "not dirty / invalid / saving" (not by read-only, which
 *   the disabled controls already cover); a failed save shows the fixed
 *   "deployment did not accept these values" line and KEEPS the drafts;
 *   leaving the page drops them.
 * - `ValueField` layout: `.head > .labelGroup(.label) + .badges(Tag + reset)`,
 *   the message paragraph carrying `${id}-message` wired through
 *   `aria-describedby`, and the invalid copy replacing the hint in place.
 *
 * The card is the official SUBSET for one boolean and one number: the switch
 * follows `SubagentModelSelectionFields` (label + `Switch` row, hint below, NO
 * override badge — the official ships no boolean-with-reset control, so its
 * entry point is the plain staged toggle), the number follows `ValueField`, and
 * the footer follows `PluginConfigForm`.
 *
 * Two deliberate divergences, both where the official provides the entry point
 * but no card exercises it:
 * - the optional `help` disclosure is unused: it needs a second, help-only copy
 *   and our single hint already carries the explanation (as in `BashCard`);
 * - `placeholder` shows the host default, because an empty draft now means
 *   "leave the default" and nothing else would tell the user what that is.
 *
 * It neither imports the client settings typed contract nor depends on the
 * 0.1.2-rc.1-only `mutate` write API: it reads the effective value, the
 * composition base and the user layer through a structural
 * {@link CleanupCardApi} supplied by `src/client/index.ts`, so the component
 * stays harness-agnostic and unit-testable in isolation.
 *
 * @module dsh-rewind/client/settings-card
 */

import { useEffect, useState } from 'react'
import { Switch, Tag } from '@deepseek-ai/dsh-client-ui-primitives'

/**
 * The dsh-settings namespace the card binds to. Duplicated here (not imported
 * from the host module) because the client build must stay free of host/node
 * imports; a cross-config test pins it equal to the host's constant. The
 * settings grammar forbids dots, so this is hyphenated.
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
 * The write a max-age draft stages, or undefined when the text is not a value
 * this field accepts (which blocks the save rather than dropping the edit). An
 * EMPTY draft clears the field, matching the official `numberField` spec:
 * leaving the control blank re-inherits the default instead of being invalid.
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
 * The write a boolean draft stages. The official switch is a two-state control
 * and never clears: every staged edit is a set.
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
 * `field().overridden`): a staged clear answers false, a staged valid set
 * answers true, and with nothing staged the user layer's presence decides.
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
 * Every entry a save would act on, in staging order (the official `plan()`): a
 * clear on a field the user layer never carried plans nothing; a draft equal to
 * the field's effective value plans nothing; an invalid draft plans an entry
 * with no write, so the form stays dirty and the save refuses.
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
 * The card-level state (the official `CardShell`): dirty and invalid are both
 * derived from the plan, so the button and the drafts can never disagree.
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
 * The bundle's configuration form. Renders nothing for the `summary` view: the
 * Plugins page only ever asks a bundle configuration for its `page` form (the
 * one-liner under the title is the package description the page already has).
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
  // Re-render on every scope change: nothing here keeps a draft copy of the
  // document, so a change from the command (or another browser) simply re-reads
  // the effective values while the staged text stays put (the official map).
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
                      // composition value, so the control immediately shows what
                      // the field reverts to.
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
