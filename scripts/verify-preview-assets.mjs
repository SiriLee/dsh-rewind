#!/usr/bin/env node
/**
 * Validate bundle preview SVGs: every docs/preview*.svg is a self-contained
 * 640×300 illustration, with an English and Chinese pair, no executable or
 * external content, at most 1 MiB together. Mirrors the upstream plugin-preview
 * checks without adding a DOM dependency.
 */
import { readFileSync, readdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const docs = join(root, 'docs')
const MAX_PAIR_BYTES = 1024 * 1024
const FORBIDDEN = /<(?:script|style|foreignObject|text|animate|animateTransform|animateMotion|set)\b/u
const GEOMETRY = /<(?:path|rect|circle|ellipse|line|polyline|polygon)\b/u
const files = readdirSync(docs).filter(name => /^preview(?:\.[a-z]+)?\.svg$/u.test(name)).sort()
const failures = []

/** Record one failed asset check. */
function fail(file, message) {
  failures.push(`${file}: ${message}`)
}

/** One opening-tag attribute, or undefined when the tag omits it. */
function attr(tag, name) {
  return new RegExp(`\\b${name}="([^"]*)"`, 'u').exec(tag)?.[1]
}

/** Every `href`/`url()` reference in the source. */
function refs(svg) {
  const result = [...svg.matchAll(/\b(?:href|xlink:href)="([^"]*)"/gu)].map(match => match[1])
  for (const match of svg.matchAll(/url\(\s*([^)\s]+)\s*\)/gu)) result.push(match[1])
  return result
}

if (files.length === 0) fail('docs', 'no preview*.svg found')

const pairs = new Map()
for (const file of files) {
  const name = file.slice(0, -4)
  const chinese = name.endsWith('.zh')
  const stem = chinese ? name.slice(0, -3) : name
  const pair = pairs.get(stem) ?? {}
  if (chinese) pair.zh = file
  else pair.en = file
  pairs.set(stem, pair)
}

for (const [stem, pair] of pairs) {
  if (pair.en !== `${stem}.svg` || pair.zh !== `${stem}.zh.svg`) {
    fail(stem, 'expected an English .svg and Chinese .zh.svg pair')
    continue
  }
  const sources = []
  let bytes = 0
  for (const file of [pair.en, pair.zh]) {
    const svg = readFileSync(join(docs, file), 'utf8')
    sources.push(svg)
    bytes += Buffer.byteLength(svg)
    const tag = /<svg\b[^>]*>/u.exec(svg)?.[0]
    if (tag === undefined) {
      fail(file, 'missing <svg> root')
      continue
    }
    if (attr(tag, 'xmlns') !== 'http://www.w3.org/2000/svg') fail(file, 'missing the SVG namespace')
    if (attr(tag, 'width') !== '640') fail(file, 'width must be 640')
    if (attr(tag, 'height') !== '300') fail(file, 'height must be 300')
    if (attr(tag, 'viewBox') !== '0 0 640 300') fail(file, 'viewBox must be 0 0 640 300')
    if (!GEOMETRY.test(svg)) fail(file, 'needs at least one geometry element')
    if (FORBIDDEN.test(svg)) fail(file, 'contains a forbidden script, style, text, or animation element')
    if (/\son[a-z]+\s*=/iu.test(svg)) fail(file, 'contains an event handler')
    if (!svg.trimEnd().endsWith('</svg>')) fail(file, 'missing closing </svg>')
    const ids = new Set([...svg.matchAll(/\sid="([^"]+)"/gu)].map(match => match[1]))
    for (const ref of refs(svg)) {
      if (/^data:image\/(?:png|jpeg|webp);base64,/u.test(ref)) continue
      if (!ref.startsWith('#') || !ids.has(ref.slice(1))) fail(file, `external or missing reference ${ref}`)
    }
  }
  if (bytes > MAX_PAIR_BYTES) fail(stem, `pair exceeds ${MAX_PAIR_BYTES} bytes`)
  if (sources[0] === sources[1]) fail(stem, 'English and Chinese files are identical')
}

if (failures.length > 0) {
  console.error('preview assets: failed')
  for (const failure of failures) console.error(`  ${failure}`)
  process.exitCode = 1
} else {
  console.log(`preview assets: ${pairs.size} pair(s) ok`)
}
