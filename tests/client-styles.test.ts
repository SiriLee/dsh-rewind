/**
 * Guard for the cleanup card's own CSS: the shared form frame (its unavailable,
 * read-only, save, and failure lines included) and the numeric field are the
 * harness's components now, so this pins only the block the card still owns —
 * the auto-cleanup toggle row and its hint.
 *
 * Source-text on purpose: jsdom applies no stylesheet, so only a real browser
 * could assert these numbers by rendering.
 */
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')

/** The prefix every class of this form carries. */
const P = '.dsh-rewind-cleanup-'

/** One rule: the selector and its exact declarations (`prop:value`, `;`-separated). */
const EXPECTATIONS: Readonly<Record<string, string>> = {
  [`${P}permission`]: 'display:grid; gap:6px; padding:12px 0',
  [`${P}toggle-row`]: 'display:flex; align-items:flex-start; justify-content:space-between; gap:16px; font-size:13px; line-height:1.5; color:var(--dsw-alias-label-primary)',
  [`${P}toggle-label`]: 'flex:1; min-width:0',
  [`${P}hint`]: 'margin:0; font-size:12px; line-height:1.5; color:var(--dsw-alias-label-tertiary)',
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

/** The whole injected stylesheet, for rules outside the cleanup block. */
function allRules(): Map<string, Record<string, string>> {
  const source = readFileSync(join(root, 'src/client/styles.ts'), 'utf8')
  return parseRules(source.slice(source.indexOf('`', source.indexOf('export const STYLE')) + 1))
}

describe('popover keyboard focus', () => {
  it('draws the focused row as the pointer fill and suppresses the browser ring', () => {
    // Arrow navigation moves REAL focus, so without this the UA two-tone ring
    // is painted around the filled row — in dark mode its dark half reads as a
    // residue edge. The harness Menu draws the same fill and suppresses it too.
    expect(allRules().get('.dsh-rewind-popover-option:focus-visible:not(:disabled)')).toEqual({
      background: 'var(--dsw-alias-interactive-bg-hover)',
      outline: 'none',
    })
  })
})

describe('cleanup card styles (the block the card still owns)', () => {
  const rules = cleanupRules()

  for (const [selector, declarations] of Object.entries(EXPECTATIONS)) {
    it(`${selector} keeps its pinned declarations`, () => {
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

  it('adds no rule this block does not pin', () => {
    // Every cleanup selector must be mapped above, so a new rule cannot slip in
    // unpinned (the assertion above already pins each mapped one's numbers).
    const unmapped = [...rules.keys()].filter(selector => selector.startsWith(P))
      .filter(selector => !Object.hasOwn(EXPECTATIONS, selector))
    expect(unmapped).toEqual([])
  })

  it('uses no literal colour where a design token exists', () => {
    const colourProps = ['color', 'background', 'border-color', 'border-top', 'border', 'outline', 'box-shadow']
    const suspicious: string[] = []
    for (const [selector, props] of rules) {
      if (!selector.startsWith(P)) continue
      for (const [property, value] of Object.entries(props)) {
        if (!colourProps.includes(property)) continue
        if (value.includes('#') || value.includes('rgb')) suspicious.push(`${selector} { ${property}: ${value} }`)
      }
    }
    expect(suspicious).toEqual([])
  })
})
