/**
 * dsh-rewind client settings card: the "Snapshot cleanup" module under
 * Settings > Plugins > Plugin configuration, drawn as one `settings.plugin.item`
 * card (keyed by the host-registered settings namespace).
 *
 * The card edits exactly two knobs — `enabled` (auto-cleanup switch) and
 * `maxAgeDays` (idle cutoff, a positive integer) — and stages them exactly like
 * the host-side /snapshot-auto-cleanup command does, so the GUI and the command
 * can never disagree. The switch collapses/expands the max-age editor; a
 * non-positive/non-integer draft blocks save (the same single validator the
 * host schema enforces). "Discard changes" restores the last-read baseline.
 *
 * It neither imports the client settings typed contract nor depends on the
 * alpha-only `mutate` write API: it reads `getSnapshot().value` and writes via
 * the `set(field, value)` method present on both rc.2 and alpha, and the card
 * receives a tiny structural `CleanupCardApi` supplied by `src/client/index.ts`
 * so the component stays harness-agnostic and unit-testable in isolation.
 *
 * @module dsh-rewind/client/settings-card
 */

import { useEffect, useState } from 'react'

/**
 * The dsh-settings namespace the card binds to. Duplicated here (not imported
 * from the host module) because the client build must stay free of host/node
 * imports; a cross-config test pins it equal to the host's constant. The
 * settings grammar forbids dots, so this is hyphenated.
 */
export const CLEANUP_SETTINGS_NAMESPACE = 'dsh-rewind-snapshot-cleanup'

/** The defaults the host uses; shown as the field placeholder until a draft. */
export const DEFAULT_MAX_AGE_DAYS = 30

/** The two editable knobs, exactly as the host policy exposes them. */
export interface CleanupPolicy {
  readonly enabled: boolean
  readonly maxAgeDays: number
}

/** A staged draft: the switch state and the raw (unparsed) max-age text. */
export interface CleanupDraft {
  readonly enabled: boolean
  readonly maxAgeDays: string
}

/** The structural api the card reads/saves through (supplied by the client). */
export interface CleanupCardApi {
  /** Read the resolved policy; `undefined` while the describe mirror loads. */
  read(): CleanupPolicy | undefined
  /** Whether the settings source accepts writes (false = read-only card). */
  writable(): boolean
  /** Persist a validated policy; rejects on failure. */
  save(next: CleanupPolicy): Promise<void>
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
 * The card body. Draws the switch (+ collapse), the max-age editor, and the
 * discard/save actions. Pure of host wiring: everything goes through the
 * supplied {@link CleanupCardApi}.
 * @param api - the read/write transport.
 * @param t - the client dictionary translator.
 * @returns the card element.
 */
export function SettingsCleanupCard({ api, t }: { api: CleanupCardApi; t: CardTranslate }) {
  const [open, setOpen] = useState(false)
  const [baseline, setBaseline] = useState<CleanupDraft>(() => draftFrom(api.read()))
  const [draft, setDraft] = useState<CleanupDraft>(() => draftFrom(api.read()))
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const writable = api.writable()

  // Re-read the value when the namespace moves (e.g. the command edits it), and
  // only when the card is not mid-edit, so a draft is never clobbered.
  useEffect(() => api.subscribe(() => {
    const next = draftFrom(api.read())
    setBaseline((base) => {
      setDraft((cur) => (dirtyOf(base, cur) ? cur : next))
      return next
    })
  }), [api])

  const dirty = dirtyOf(baseline, draft)
  const days = maxAgeOf(draft.maxAgeDays)
  const invalid = days === null
  const disabled = busy || !writable

  const edit = (patch: Partial<CleanupDraft>) => {
    setDraft((cur) => ({ ...cur, ...patch }))
    setError(null)
  }

  const save = async () => {
    if (busy || !writable || !dirty) return
    const next = configOf(draft)
    if (next === null) { setError(t('cleanup.invalid')); return }
    setBusy(true)
    setError(null)
    try {
      await api.save(next)
      setBaseline(draft)
      setError(null)
    } catch (e) {
      setError(t('cleanup.saveFailed', { message: e instanceof Error ? e.message : String(e) }))
    } finally {
      setBusy(false)
    }
  }

  const discard = () => { if (busy) return; setDraft(baseline); setError(null) }

  return (
    <li className={`dsh-rewind-cleanup-card${open ? ' dsh-rewind-cleanup-card-open' : ''}`}>
      <button type="button" className="dsh-rewind-cleanup-header" aria-expanded={open}
        aria-label={`${t(open ? 'cleanup.collapse' : 'cleanup.expand')}: ${t('cleanup.title')}`}
        onClick={() => setOpen(!open)}>
        <span className="dsh-rewind-cleanup-head-text">
          <span className="dsh-rewind-cleanup-name">{t('cleanup.title')}</span>
          <span className="dsh-rewind-cleanup-desc">{t('cleanup.desc')}</span>
        </span>
        {dirty ? <span className="dsh-rewind-cleanup-pending">{t('cleanup.unsaved')}</span> : null}
        <svg className={`dsh-rewind-cleanup-chevron${open ? ' dsh-rewind-cleanup-chevron-open' : ''}`}
          width="14" height="14" viewBox="0 0 16 16" aria-hidden="true">
          <path d="M4 6l4 4 4-4" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      </button>
      {open ? (
        <div className="dsh-rewind-cleanup-body">
          {!writable ? <p className="dsh-rewind-cleanup-readonly" role="status">{t('cleanup.readonly')}</p> : null}
          <div className="dsh-rewind-cleanup-permission">
            <div className="dsh-rewind-cleanup-toggle-row">
              <span className="dsh-rewind-cleanup-toggle-label" id="dsh-rewind-cleanup-enabled-label">{t('cleanup.auto')}</span>
              <button type="button" role="switch" className={`dsh-rewind-cleanup-switch${draft.enabled ? ' dsh-rewind-cleanup-switch-on' : ''}`}
                aria-checked={draft.enabled} aria-labelledby="dsh-rewind-cleanup-enabled-label" disabled={disabled}
                onClick={() => edit({ enabled: !draft.enabled })}>
                <span className="dsh-rewind-cleanup-thumb" />
              </button>
            </div>
            <p className="dsh-rewind-cleanup-hint">{t(draft.enabled ? 'cleanup.auto.on' : 'cleanup.auto.off')}</p>
          </div>
          {draft.enabled ? (
            <div className="dsh-rewind-cleanup-field">
              <div className="dsh-rewind-cleanup-head">
                <label className="dsh-rewind-cleanup-label" htmlFor="dsh-rewind-cleanup-maxage">{t('cleanup.maxAge')}</label>
              </div>
              <input
                className={`dsh-rewind-cleanup-input${invalid ? ' dsh-rewind-cleanup-input-invalid' : ''}`}
                type="text" inputMode="numeric" id="dsh-rewind-cleanup-maxage" value={draft.maxAgeDays}
                disabled={disabled} aria-invalid={invalid || undefined} placeholder={String(DEFAULT_MAX_AGE_DAYS)}
                onChange={(e) => edit({ maxAgeDays: e.target.value })} />
              <p className={invalid ? 'dsh-rewind-cleanup-error' : 'dsh-rewind-cleanup-hint'}>
                {invalid ? t('cleanup.invalid') : t('cleanup.maxAge.hint')}
              </p>
            </div>
          ) : null}
          <div className="dsh-rewind-cleanup-footer">
            {error ? <p className="dsh-rewind-cleanup-failed" role="status">{error}</p> : null}
            <button type="button" className="dsh-rewind-cleanup-discard" disabled={!dirty || busy || !writable}
              onClick={discard}>{t('cleanup.discard')}</button>
            <button type="button" className="dsh-rewind-cleanup-save" disabled={!dirty || busy || !writable || invalid}
              onClick={save}>{busy ? t('cleanup.saving') : t('cleanup.save')}</button>
          </div>
        </div>
      ) : null}
    </li>
  )
}
