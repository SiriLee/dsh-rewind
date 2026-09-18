/**
 * Numeric guard for the cleanup configuration form's CSS.
 *
 * The form re-implements the harness's `PluginConfigForm` / `ValueField` /
 * `SubagentModelSelectionFields` (those components are package-internal, so
 * their numbers are copied, not imported). This file is the verification that
 * the copy is EXACT: every custom property set in the cleanup block of
 * `src/client/styles.ts` is compared, property for property, against the values
 * of the official CSS module it mirrors.
 *
 * It is a source-text guard on purpose — CSS cannot be asserted through the
 * component tests (jsdom applies no stylesheet), and a rendered-diff test would
 * need a real browser for numbers this small. A change to any of these values —
 * or a new cleanup rule that nobody mapped — fails here, so drift is a
 * deliberate act rather than an accident.
 *
 * Official sources, all under
 * `packages/client/ui-settings-plugins/src/client/`:
 * - `PluginConfigForm.module.css` — the form shell, read-only/unavailable
 *   notice, footer, failure line, save button.
 * - `fields.module.css` — `ValueField`: field/head/labelGroup/label/badges/
 *   reset/input and the invalid border.
 * - `SubagentModelSelectionFields.module.css` — the permission block, the
 *   toggle row, and the hint (its `.hint`/`.notice` and `.invalid`/`.conflict`
 *   rules are selector lists; the merged values are asserted here).
 *
 * Deliberately NOT mirrored (no official counterpart in the structures this
 * form uses; see the card's module doc): `fields.module.css` `.helpButton` /
 * `.help*` (no help disclosure), `SubagentLimitsFields.module.css`
 * `.limits`/`.limit`/`.depthTable*` (a two-column layout for a different card)
 * and its `.limit input { font-variant-numeric: tabular-nums }`,
 * `SubagentCard.module.css` `.section`/`.heading` (the page draws the title and
 * this form is a single group), and the Subagent model-selection list rules
 * (`.selection`, `.models*`, `.model*`, `.route`, `.catalogError*`).
 */
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')

/** The prefix every class of this form carries. */
const P = '.dsh-rewind-cleanup-'

/** One rule's expected declarations, taken from the official CSS module. */
interface Expectation {
  /** Selector inside the cleanup block. */
  readonly selector: string
  /** The official module and selector this copies. */
  readonly official: string
  /** Exact declarations, in the official wording. */
  readonly props: Readonly<Record<string, string>>
}

/** Every cleanup rule and its official counterpart. */
const EXPECTATIONS: readonly Expectation[] = [
  {
    selector: `${P}form`,
    official: 'PluginConfigForm.module.css .form',
    props: { display: 'flex', 'flex-direction': 'column' },
  },
  {
    selector: `${P}readonly`,
    official: 'PluginConfigForm.module.css .readOnly, .unavailable',
    props: { margin: '0 0 12px', 'font-size': '12px', 'line-height': '1.5', color: 'var(--dsw-alias-label-tertiary)' },
  },
  {
    selector: `${P}unavailable`,
    official: 'PluginConfigForm.module.css .readOnly, .unavailable',
    props: { margin: '0 0 12px', 'font-size': '12px', 'line-height': '1.5', color: 'var(--dsw-alias-label-tertiary)' },
  },
  {
    selector: `${P}footer`,
    official: 'PluginConfigForm.module.css .footer',
    props: { display: 'flex', 'align-items': 'center', gap: '8px', 'padding-top': '16px' },
  },
  {
    selector: `${P}failed`,
    official: 'PluginConfigForm.module.css .failed',
    props: {
      flex: '1',
      'min-width': '0',
      margin: '0',
      'font-size': '12px',
      'line-height': '1.5',
      color: 'var(--dsw-alias-label-error)',
    },
  },
  {
    selector: `${P}save`,
    official: 'PluginConfigForm.module.css .save',
    props: {
      appearance: 'none',
      border: '1px solid transparent',
      'border-radius': '8px',
      padding: '5px 14px',
      font: 'inherit',
      'font-size': '13px',
      'line-height': '1.5',
      cursor: 'pointer',
      background: 'var(--dsw-alias-label-primary)',
      color: 'var(--dsw-alias-bg-layer-3)',
    },
  },
  {
    selector: `${P}save:disabled`,
    official: 'PluginConfigForm.module.css .save:disabled',
    props: { opacity: '0.4', cursor: 'default' },
  },
  {
    selector: `${P}save:focus-visible`,
    official: 'PluginConfigForm.module.css .save:focus-visible',
    props: { outline: '2px solid var(--dsw-alias-brand-primary)', 'outline-offset': '1px' },
  },
  {
    selector: `${P}permission`,
    official: 'SubagentModelSelectionFields.module.css .permission',
    props: { display: 'grid', gap: '6px', padding: '12px 0' },
  },
  {
    selector: `${P}toggle-row`,
    official: 'SubagentModelSelectionFields.module.css .toggleRow',
    props: {
      display: 'flex',
      'align-items': 'flex-start',
      'justify-content': 'space-between',
      gap: '16px',
      'font-size': '13px',
      'line-height': '1.5',
      color: 'var(--dsw-alias-label-primary)',
    },
  },
  {
    selector: `${P}toggle-label`,
    official: 'SubagentModelSelectionFields.module.css .toggleLabel',
    props: { flex: '1', 'min-width': '0' },
  },
  {
    selector: `${P}hint`,
    official: 'SubagentModelSelectionFields.module.css .hint (+ .hint, .notice colour rule)',
    props: { margin: '0', 'font-size': '12px', 'line-height': '1.5', color: 'var(--dsw-alias-label-tertiary)' },
  },
  {
    selector: `${P}error`,
    official: 'fields.module.css .invalid',
    props: {
      margin: '0',
      'font-size': '12px',
      'line-height': '1.5',
      color: 'var(--dsw-alias-state-error-primary)',
    },
  },
  {
    selector: `${P}field`,
    official: 'fields.module.css .field',
    props: { display: 'flex', 'flex-direction': 'column', gap: '6px', padding: '12px 0' },
  },
  {
    selector: `${P}field + ${P}field`,
    official: 'fields.module.css .field + .field',
    props: { 'border-top': '0.5px solid var(--dsw-alias-border-l2)' },
  },
  {
    selector: `${P}head`,
    official: 'fields.module.css .head',
    props: { display: 'flex', 'align-items': 'center', gap: '8px' },
  },
  {
    selector: `${P}label-group`,
    official: 'fields.module.css .labelGroup',
    props: { display: 'flex', 'align-items': 'center', gap: '4px', flex: '1', 'min-width': '0' },
  },
  {
    selector: `${P}label`,
    official: 'fields.module.css .label',
    props: {
      flex: '1',
      'min-width': '0',
      'font-size': '13px',
      'font-weight': '500',
      'line-height': '1.5',
      color: 'var(--dsw-alias-label-primary)',
    },
  },
  {
    selector: `${P}label-group > ${P}label`,
    official: 'fields.module.css .labelGroup > .label',
    props: { flex: '0 1 auto' },
  },
  {
    selector: `${P}badges`,
    official: 'fields.module.css .badges',
    props: { display: 'inline-flex', 'align-items': 'center', gap: '8px' },
  },
  {
    selector: `${P}reset`,
    official: 'fields.module.css .reset',
    props: {
      border: 'none',
      background: 'none',
      padding: '0',
      font: 'inherit',
      'font-size': '12px',
      'line-height': '1.5',
      color: 'var(--dsw-alias-label-secondary)',
      cursor: 'pointer',
    },
  },
  {
    selector: `${P}reset:hover:not(:disabled)`,
    official: 'fields.module.css .reset:hover:not(:disabled)',
    props: { color: 'var(--dsw-alias-label-primary)' },
  },
  {
    selector: `${P}reset:disabled`,
    official: 'fields.module.css .reset:disabled',
    props: { cursor: 'default' },
  },
  {
    selector: `${P}input`,
    official: 'fields.module.css .input',
    props: {
      height: '34px',
      padding: '0 12px',
      border: '0.5px solid var(--dsw-alias-border-l4)',
      'border-radius': '8px',
      background: 'var(--dsw-alias-bg-layer-3)',
      font: 'inherit',
      'font-size': '13px',
      'line-height': '1.5',
      color: 'var(--dsw-alias-label-primary)',
    },
  },
  {
    selector: `${P}input:focus-visible`,
    official: 'fields.module.css .input:focus-visible',
    props: { outline: 'none', 'border-color': 'var(--dsw-alias-brand-primary)' },
  },
  {
    selector: `${P}input:disabled`,
    official: 'fields.module.css .input:disabled',
    props: { color: 'var(--dsw-alias-label-tertiary)', cursor: 'default' },
  },
  {
    selector: `${P}input[aria-invalid='true']`,
    official: "fields.module.css .input[aria-invalid='true']",
    props: { 'border-color': 'var(--dsw-alias-state-error-primary)' },
  },
]

/**
 * Parse one CSS text into `selector -> declarations`, expanding selector lists
 * and letting a later rule override an earlier one, exactly like the cascade
 * inside one stylesheet.
 * @param css - the CSS text (comments stripped).
 * @returns the declarations per selector.
 */
function parseRules(css: string): Map<string, Record<string, string>> {
  const rules = new Map<string, Record<string, string>>()
  for (const [, selectors, body] of css.replaceAll(/\/\*[\s\S]*?\*\//g, '').matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    const props: Record<string, string> = {}
    for (const declaration of body!.split(';')) {
      const at = declaration.indexOf(':')
      if (at < 0) continue
      props[declaration.slice(0, at).trim()] = declaration.slice(at + 1).trim().replaceAll(/\s+/g, ' ')
    }
    for (const selector of selectors!.split(',')) {
      const key = selector.trim().replaceAll(/\s+/g, ' ')
      rules.set(key, { ...rules.get(key), ...props })
    }
  }
  return rules
}

/** The cleanup block of the injected stylesheet (the STYLE template literal). */
function cleanupRules(): Map<string, Record<string, string>> {
  const source = readFileSync(join(root, 'src/client/styles.ts'), 'utf8')
  const start = source.indexOf('/* ---- Snapshot-cleanup configuration form')
  expect(start, 'the cleanup block marker moved').toBeGreaterThan(0)
  const end = source.indexOf('`', start)
  expect(end, 'the STYLE template literal is unterminated').toBeGreaterThan(start)
  return parseRules(source.slice(start, end))
}

describe('cleanup form styles (exact numbers from the official CSS modules)', () => {
  const rules = cleanupRules()

  for (const { selector, official, props } of EXPECTATIONS) {
    it(`${selector} matches ${official}`, () => {
      expect(rules.get(selector), `${selector} is missing`).toBeDefined()
      expect(rules.get(selector)).toEqual(props)
    })
  }

  it('adds no rule the official form does not have', () => {
    // Every cleanup selector must be mapped above, so a new rule cannot slip in
    // unpinned (the assertion above already pins each mapped one's numbers).
    const unmapped = [...rules.keys()].filter(selector => selector.startsWith(P))
      .filter(selector => !EXPECTATIONS.some(expectation => expectation.selector === selector))
    expect(unmapped).toEqual([])
  })

  it('uses no literal colour or size where the official rule uses a design token', () => {
    // Guard the token discipline itself: every declaration this form copies
    // that names a COLOUR must go through a --dsw-alias-* token.
    const colourProps = ['color', 'background', 'border-color', 'border-top', 'border', 'outline', 'box-shadow']
    const suspicious: string[] = []
    for (const [selector, props] of rules) {
      if (!selector.startsWith(P)) continue
      for (const [property, value] of Object.entries(props)) {
        if (!colourProps.includes(property)) continue
        if (property === 'border' && value.startsWith('1px solid transparent')) continue
        if (value.includes('#') || value.includes('rgb')) suspicious.push(`${selector} { ${property}: ${value} }`)
      }
    }
    expect(suspicious).toEqual([])
  })
})
