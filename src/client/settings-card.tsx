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
 * It edits exactly two knobs — `enabled` (auto-cleanup switch) and `maxAgeDays`
 * (idle cutoff, a positive integer) — and stages them exactly like the
 * host-side /snapshot-auto-cleanup command does, so the GUI and the command can
 * never disagree. The switch collapses/expands the max-age editor; a
 * non-positive/non-integer draft blocks save (the same single validator the
 * host schema enforces).
 *
 * Staging follows the harness's own plugin forms: only a save writes, leaving
 * the page drops every staged edit (hence no Discard control), and a field the
 * user layer carries gets an "overridden" badge plus a reset that stages a
 * clear back to the composition layer.
 *
 * It neither imports the client settings typed contract nor depends on the
 * 0.1.2-rc.1-only `mutate` write API: it reads `getSnapshot().value` and writes
 * through the `set(field, value)` / `unset(field)` methods, and the card
 * receives a tiny structural {@link CleanupCardApi} supplied by
 * `src/client/index.ts` so the component stays harness-agnostic and
 * unit-testable in isolation.
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

/**
 * The `plugins.bundle.config` key this card registers under: the BUNDLE's
 * package name, which is how the Plugins page dispatches a bundle's form
 * (`renderSlot('plugins.bundle.config', …, { entryKey: pkg.name })`) and how it
 * decides a bundle is configurable. A cross-config test pins it to
 * `package.json`'s `name`.
 */
export const CLEANUP_SLOT_KEY = 'dsh-rewind-plugin'

/** The defaults the host uses; shown as the field placeholder until a draft. */
export const DEFAULT_MAX_AGE_DAYS = 30

/** The two editable knobs, exactly as the host policy exposes them. */
export interface CleanupPolicy {
  readonly enabled: boolean
  readonly maxAgeDays: number
}

/** One editable field, named exactly as the host's settings section names it. */
export type CleanupField = 'enabled' | 'maxAgeDays'

/** One staged save operation: a validated write, or a clear back to the base layer. */
export type CleanupOp =
  | { readonly field: CleanupField; readonly kind: 'set'; readonly value: boolean | number }
  | { readonly field: CleanupField; readonly kind: 'reset' }

/** A staged draft: the switch state and the raw (unparsed) max-age text. */
export interface CleanupDraft {
  readonly enabled: boolean
  readonly maxAgeDays: string
}

/** The structural api the card reads/saves through (supplied by the client). */
export interface CleanupCardApi {
  /** Read the resolved policy; `undefined` while the describe mirror loads. */
  read(): CleanupPolicy | undefined
  /**
   * Which fields the USER layer carries. Presence is the judgment, never value
   * equality: an override whose value equals the composition default is still
   * an override.
   */
  overridden(): Readonly<Record<CleanupField, boolean>>
  /** Whether the settings source accepts writes (false = read-only card). */
  writable(): boolean
  /** Apply the staged operations in order; `reset` clears the field. */
  save(ops: readonly CleanupOp[]): Promise<void>
  /** Optional change subscription (returns the disposer). */
  subscribe(cb: () => void): () => void
}

/** Translate one client dictionary key (the card's `t`). */
export type CardTranslate = (key: string, params?: Record<string, string | number>) => string

/** Load a draft from a policy (defaults when the view has not loaded). */
export function draftFrom(policy: CleanupPolicy | undefined): CleanupDraft {
  return { enabled: policy?.enabled ?? false, maxAgeDays: String(policy?.maxAgeDays ?? '') }
}

/** Parse the max-age text: a strict positive integer, else `null`. */
export function maxAgeOf(text: string): number | null {
  const trimmed = text.trim()
  if (!/^\d+$/.test(trimmed)) return null
  const days = Number(trimmed)
  return Number.isSafeInteger(days) && days > 0 ? days : null
}

/**
 * The policy a draft resolves to, or `null` when the max-age draft is invalid
 * (which blocks save). `enabled` is always a boolean from the switch, and
 * `maxAgeDays` comes from the validated draft.
 */
export function configOf(draft: CleanupDraft): CleanupPolicy | null {
  const days = maxAgeOf(draft.maxAgeDays)
  if (days === null) return null
  return { enabled: draft.enabled, maxAgeDays: days }
}

/** True when the draft differs from the baseline (an unsaved edit). */
export function dirtyOf(base: CleanupDraft, draft: CleanupDraft): boolean {
  return base.enabled !== draft.enabled || base.maxAgeDays !== draft.maxAgeDays
}

/**
 * The staged operations a save would write, in field order. A staged reset wins
 * over an edit of the same field; the max-age field is ignored while the switch
 * is off, matching its hidden state (a disabled policy does not carry a cutoff).
 * @param base - the last-read baseline.
 * @param draft - the current draft.
 * @param resets - the fields staged for a clear.
 * @returns the operations to apply; empty means "nothing to write".
 */
export function opsOf(
  base: CleanupDraft,
  draft: CleanupDraft,
  resets: readonly CleanupField[],
): readonly CleanupOp[] {
  const ops: CleanupOp[] = []
  if (resets.includes('enabled')) ops.push({ field: 'enabled', kind: 'reset' })
  else if (draft.enabled !== base.enabled) ops.push({ field: 'enabled', kind: 'set', value: draft.enabled })
  if (draft.enabled) {
    if (resets.includes('maxAgeDays')) {
      ops.push({ field: 'maxAgeDays', kind: 'reset' })
    } else {
      const days = maxAgeOf(draft.maxAgeDays)
      if (days !== null && days !== maxAgeOf(base.maxAgeDays)) {
        ops.push({ field: 'maxAgeDays', kind: 'set', value: days })
      }
    }
  }
  return ops
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
  const [baseline, setBaseline] = useState<CleanupDraft>(() => draftFrom(api.read()))
  const [draft, setDraft] = useState<CleanupDraft>(() => draftFrom(api.read()))
  const [resets, setResets] = useState<readonly CleanupField[]>([])
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  // Re-read the value when the namespace moves (e.g. the command edits it), and
  // only when the card is not mid-edit, so a draft is never clobbered.
  useEffect(() => api.subscribe(() => {
    const next = draftFrom(api.read())
    setBaseline((base) => {
      setDraft((cur) => (dirtyOf(base, cur) ? cur : next))
      return next
    })
  }), [api])

  if (view === 'summary') return null

  // Read on every render: the overridden set moves with the host document, and
  // a reset staged for a field the user layer no longer carries is not pending.
  const over = api.overridden()
  const staged = resets.filter(field => over[field])
  const writable = api.writable()
  const invalid = draft.enabled && maxAgeOf(draft.maxAgeDays) === null
  const disabled = busy || !writable
  const ops = opsOf(baseline, draft, staged)
  const dirty = ops.length > 0
  const blocked = busy || !writable || !dirty || invalid

  const edit = (patch: Partial<CleanupDraft>) => {
    setDraft((cur) => ({ ...cur, ...patch }))
    setError(null)
  }

  const stageReset = (field: CleanupField) => {
    setResets((cur) => (cur.includes(field) ? cur : [...cur, field]))
    setError(null)
  }

  const save = async () => {
    if (blocked || ops.length === 0) return
    setBusy(true)
    setError(null)
    try {
      await api.save(ops)
      // Re-read rather than optimistically adopting the draft: a staged reset
      // resolves to the composition layer, not to the value that was showing.
      const reconciled = api.read()
      const next = reconciled === undefined ? draft : draftFrom(reconciled)
      setBaseline(next)
      setDraft(next)
      setResets([])
    } catch (e) {
      setError(t('cleanup.saveFailed', { message: e instanceof Error ? e.message : String(e) }))
    } finally {
      setBusy(false)
    }
  }

  /** The "overridden + reset" control pair of one field. */
  const badges = (field: CleanupField) => (
    <span className="dsh-rewind-cleanup-badges">
      <Tag tone="neutral">{t('cleanup.overridden')}</Tag>
      <button
        type="button"
        className="dsh-rewind-cleanup-reset"
        disabled={disabled}
        onClick={() => { stageReset(field) }}
      >
        {t('cleanup.reset')}
      </button>
    </span>
  )

  return (
    <div className="dsh-rewind-cleanup-form">
      {!writable ? <p className="dsh-rewind-cleanup-readonly" role="status">{t('cleanup.readonly')}</p> : null}
      <div className="dsh-rewind-cleanup-permission">
        <div className="dsh-rewind-cleanup-toggle-row">
          <span className="dsh-rewind-cleanup-toggle-label">
            {t('cleanup.auto')}
            {over.enabled && !staged.includes('enabled') ? badges('enabled') : null}
          </span>
          <Switch
            checked={draft.enabled}
            label={t('cleanup.auto')}
            disabled={disabled}
            onChange={(next) => { edit({ enabled: next }) }}
          />
        </div>
        <p className="dsh-rewind-cleanup-hint">{t(draft.enabled ? 'cleanup.auto.on' : 'cleanup.auto.off')}</p>
      </div>
      {draft.enabled ? (
        <div className="dsh-rewind-cleanup-field">
          <div className="dsh-rewind-cleanup-head">
            <label className="dsh-rewind-cleanup-label" htmlFor="dsh-rewind-cleanup-maxage">{t('cleanup.maxAge')}</label>
            {over.maxAgeDays && !staged.includes('maxAgeDays') ? badges('maxAgeDays') : null}
          </div>
          <input
            className={`dsh-rewind-cleanup-input${invalid ? ' dsh-rewind-cleanup-input-invalid' : ''}`}
            type="text" inputMode="numeric" id="dsh-rewind-cleanup-maxage" value={draft.maxAgeDays}
            disabled={disabled} aria-invalid={invalid || undefined} placeholder={String(DEFAULT_MAX_AGE_DAYS)}
            onChange={(e) => { edit({ maxAgeDays: e.target.value }) }} />
          <p className={invalid ? 'dsh-rewind-cleanup-error' : 'dsh-rewind-cleanup-hint'}>
            {invalid ? t('cleanup.invalid') : t('cleanup.maxAge.hint')}
          </p>
        </div>
      ) : null}
      <div className="dsh-rewind-cleanup-footer">
        {error ? <p className="dsh-rewind-cleanup-failed" role="status">{error}</p> : null}
        <button type="button" className="dsh-rewind-cleanup-save" disabled={blocked} onClick={save}>
          {busy ? t('cleanup.saving') : t('cleanup.save')}
        </button>
      </div>
    </div>
  )
}
