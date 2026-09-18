/**
 * Numeric guard for the cleanup form's CSS: every property the form sets is
 * compared, value for value, against the official CSS module it mirrors — the
 * form re-implements `PluginConfigForm` / `ValueField` /
 * `SubagentModelSelectionFields` (package-internal, so the numbers are copied).
 * A drifted value, or a cleanup rule nobody mapped, fails here.
 *
 * Source-text on purpose: jsdom applies no stylesheet, so only a real browser
 * could assert these numbers by rendering.
 *
 * Not mirrored, because the structures are not used (see the card's doc):
 * `.helpButton`/`.help*`, `SubagentLimitsFields.module.css`
 * `.limits`/`.limit`/`.depthTable*` (and its `tabular-nums`), `SubagentCard`'s
 * `.section`/`.heading`, and the model-selection list rules.
 */
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')

/** The prefix every class of this form carries. */
const P = '.dsh-rewind-cleanup-'

/** Every cleanup rule and its official counterpart. */
/**
 * One rule: the official module + selector it mirrors, and that selector's exact
 * declarations (`prop:value`, `;`-separated), copied from the official CSS.
 */
const EXPECTATIONS: Readonly<Record<string, readonly [official: string, declarations: string]>> = {
  [`${P}form`]: ['PluginConfigForm.module.css .form', 'display:flex; flex-direction:column'],
  [`${P}readonly`]: ['PluginConfigForm.module.css .readOnly, .unavailable', 'margin:0 0 12px; font-size:12px; line-height:1.5; color:var(--dsw-alias-label-tertiary)'],
  [`${P}unavailable`]: ['PluginConfigForm.module.css .readOnly, .unavailable', 'margin:0 0 12px; font-size:12px; line-height:1.5; color:var(--dsw-alias-label-tertiary)'],
  [`${P}footer`]: ['PluginConfigForm.module.css .footer', 'display:flex; align-items:center; gap:8px; padding-top:16px'],
  [`${P}failed`]: ['PluginConfigForm.module.css .failed', 'flex:1; min-width:0; margin:0; font-size:12px; line-height:1.5; color:var(--dsw-alias-label-error)'],
  [`${P}save`]: ['PluginConfigForm.module.css .save', 'appearance:none; border:1px solid transparent; border-radius:8px; padding:5px 14px; font:inherit; font-size:13px; line-height:1.5; cursor:pointer; background:var(--dsw-alias-label-primary); color:var(--dsw-alias-bg-layer-3)'],
  [`${P}save:disabled`]: ['PluginConfigForm.module.css .save:disabled', 'opacity:0.4; cursor:default'],
  [`${P}save:focus-visible`]: ['PluginConfigForm.module.css .save:focus-visible', 'outline:2px solid var(--dsw-alias-brand-primary); outline-offset:1px'],
  [`${P}permission`]: ['SubagentModelSelectionFields.module.css .permission', 'display:grid; gap:6px; padding:12px 0'],
  [`${P}toggle-row`]: ['SubagentModelSelectionFields.module.css .toggleRow', 'display:flex; align-items:flex-start; justify-content:space-between; gap:16px; font-size:13px; line-height:1.5; color:var(--dsw-alias-label-primary)'],
  [`${P}toggle-label`]: ['SubagentModelSelectionFields.module.css .toggleLabel', 'flex:1; min-width:0'],
  [`${P}hint`]: ['SubagentModelSelectionFields.module.css .hint (+ .hint, .notice colour rule)', 'margin:0; font-size:12px; line-height:1.5; color:var(--dsw-alias-label-tertiary)'],
  [`${P}error`]: ['fields.module.css .invalid', 'margin:0; font-size:12px; line-height:1.5; color:var(--dsw-alias-state-error-primary)'],
  [`${P}field`]: ['fields.module.css .field', 'display:flex; flex-direction:column; gap:6px; padding:12px 0'],
  [`${P}field + ${P}field`]: ['fields.module.css .field + .field', 'border-top:0.5px solid var(--dsw-alias-border-l2)'],
  [`${P}head`]: ['fields.module.css .head', 'display:flex; align-items:center; gap:8px'],
  [`${P}label-group`]: ['fields.module.css .labelGroup', 'display:flex; align-items:center; gap:4px; flex:1; min-width:0'],
  [`${P}label`]: ['fields.module.css .label', 'flex:1; min-width:0; font-size:13px; font-weight:500; line-height:1.5; color:var(--dsw-alias-label-primary)'],
  [`${P}label-group > ${P}label`]: ['fields.module.css .labelGroup > .label', 'flex:0 1 auto'],
  [`${P}badges`]: ['fields.module.css .badges', 'display:inline-flex; align-items:center; gap:8px'],
  [`${P}reset`]: ['fields.module.css .reset', 'border:none; background:none; padding:0; font:inherit; font-size:12px; line-height:1.5; color:var(--dsw-alias-label-secondary); cursor:pointer'],
  [`${P}reset:hover:not(:disabled)`]: ['fields.module.css .reset:hover:not(:disabled)', 'color:var(--dsw-alias-label-primary)'],
  [`${P}reset:disabled`]: ['fields.module.css .reset:disabled', 'cursor:default'],
  [`${P}input`]: ['fields.module.css .input', 'height:34px; padding:0 12px; border:0.5px solid var(--dsw-alias-border-l4); border-radius:8px; background:var(--dsw-alias-bg-layer-3); font:inherit; font-size:13px; line-height:1.5; color:var(--dsw-alias-label-primary)'],
  [`${P}input:focus-visible`]: ['fields.module.css .input:focus-visible', 'outline:none; border-color:var(--dsw-alias-brand-primary)'],
  [`${P}input:disabled`]: ['fields.module.css .input:disabled', 'color:var(--dsw-alias-label-tertiary); cursor:default'],
  [`${P}input[aria-invalid='true']`]: ['fields.module.css .input[aria-invalid=\'true\']', 'border-color:var(--dsw-alias-state-error-primary)'],
}

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

  for (const [selector, [official, declarations]] of Object.entries(EXPECTATIONS)) {
    it(`${selector} matches ${official}`, () => {
      const props: Record<string, string> = {}
      for (const declaration of declarations.split(';')) {
        const at = declaration.indexOf(':')
        if (at < 0) continue
        props[declaration.slice(0, at).trim()] = declaration.slice(at + 1).trim()
      }
      expect(rules.get(selector), `${selector} is missing`).toBeDefined()
      expect(rules.get(selector)).toEqual(props)
    })
  }

  it('adds no rule the official form does not have', () => {
    // Every cleanup selector must be mapped above, so a new rule cannot slip in
    // unpinned (the assertion above already pins each mapped one's numbers).
    const unmapped = [...rules.keys()].filter(selector => selector.startsWith(P))
      .filter(selector => !Object.hasOwn(EXPECTATIONS, selector))
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
