// The vendored components' tokens, checked against both themes.
//
// src/styles/tokens.css claims to be "shared with FTW's on-box UI — keep
// them in step", and until this script nothing held that claim: the two
// files agreed by discipline alone, and one renamed padding token was
// enough to put two cards on their fallbacks with every test green.
//
// The check is scoped to what actually crosses the repo boundary: every
// custom property a file under src/vendor/ftw reads. For each such name,
// resolve it — chasing var() chains — in this repo's tokens.css and in the
// box's theme.css. A name both files define must resolve to the same value,
// in the dark block and in the light one. A name only one side defines is
// reported but does not fail: that asymmetry is real, known drift (the box
// runs on the fallback), and closing it is upstream work, not a reason to
// hold this repository's gate red.
//
// Usage: node scripts/check-token-drift.mjs <path-to-box-theme.css>
// CI runs it beside check:contract, against the same checkout of the box.

import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'

const boxTheme = process.argv[2]
if (!boxTheme) {
  console.error('usage: check-token-drift.mjs <path to forty-two-watts/web/components/theme.css>')
  process.exit(2)
}

const VENDOR_DIR = 'src/vendor/ftw'
const APP_TOKENS = 'src/styles/tokens.css'

/** Every custom property a vendored file reads. */
function consumedNames() {
  const names = new Set()
  for (const f of readdirSync(VENDOR_DIR)) {
    if (!/\.(js|css)$/.test(f)) continue
    const text = readFileSync(join(VENDOR_DIR, f), 'utf8')
    for (const m of text.matchAll(/var\(\s*(--[a-z0-9-]+)/gi)) names.add(m[1])
  }
  return names
}

/**
 * The declarations of one CSS file, split into the dark (default) and
 * light themes. Good enough for two hand-kept token files: top-level
 * `:root`-ish blocks are the default, and any block whose selector or
 * @media mentions `light` overrides into the light table.
 */
function tables(cssPath) {
  // Comments go first: a header that merely mentions the word "light" put
  // the whole dark block in the light table, and the checker shipped its
  // first false negative before its first run was over.
  const text = readFileSync(cssPath, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '')
  const dark = new Map()
  const light = new Map()

  // For each declaration, ask whether any enclosing block's selector or
  // @media header mentions light. Two hand-kept token files, not a CSS
  // engine — the day this is not enough is the day a real parser earns in.
  const decl = /(--[a-z0-9-]+)\s*:\s*([^;]+);/gi
  for (const m of text.matchAll(decl)) {
    const upto = text.slice(0, m.index)
    let open = 0
    let inLight = false
    for (const b of upto.matchAll(/([^{}]*)([{}])/g)) {
      if (b[2] === '{') {
        open++
        if (/light/i.test(b[1])) inLight = true
      } else {
        open--
        if (open === 0) inLight = false
      }
    }
    const name = m[1]
    // "0.10" and "0.1" are one value; a check failing on spelling would be
    // noise nobody fixes, and noise is how a gate gets ignored.
    const value = m[2]
      .trim()
      .replace(/\s+/g, ' ')
      .replace(/\d*\.?\d+/g, (n) => String(Number.parseFloat(n)))
    ;(inLight ? light : dark).set(name, value)
    if (!inLight && !light.has(name)) light.set(name, value)
  }
  // Light inherits what it does not override.
  for (const [k, v] of dark) if (!light.has(k)) light.set(k, v)
  return { dark, light }
}

/** Chase var() references until a literal value or a dead end. */
function resolve(table, name, seen = new Set()) {
  if (seen.has(name)) return null
  seen.add(name)
  const raw = table.get(name)
  if (raw === undefined) return null
  const ref = raw.match(/^var\(\s*(--[a-z0-9-]+)\s*(?:,[^)]*)?\)$/)
  if (ref) return resolve(table, ref[1], seen) ?? null
  return raw
}

const names = [...consumedNames()].sort()
const app = tables(APP_TOKENS)
const box = tables(boxTheme)

const drift = []
const oneSided = []

for (const name of names) {
  for (const theme of ['dark', 'light']) {
    const a = resolve(app[theme], name)
    const b = resolve(box[theme], name)
    if (a !== null && b !== null && a !== b) {
      drift.push(`${name} (${theme}): app "${a}" vs box "${b}"`)
    } else if ((a === null) !== (b === null)) {
      oneSided.push(`${name} (${theme}): only ${a !== null ? 'app' : 'box'} defines it`)
    }
  }
}

if (oneSided.length > 0) {
  console.log(`defined on one side only (known drift, not failing):`)
  for (const line of [...new Set(oneSided)]) console.log(`  ${line}`)
}

if (drift.length > 0) {
  console.error(`\ntoken drift between ${APP_TOKENS} and the box's theme.css:`)
  for (const line of drift) console.error(`  ${line}`)
  process.exit(1)
}

console.log(`${names.length} vendored token names checked, both themes, no drift`)
