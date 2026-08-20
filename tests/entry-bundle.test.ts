/* What the first frame has to download.
 *
 * "Nothing blocks the first frame" is the app's first rule, and the launch
 * path is where it is either kept or quietly lost. A view loaded on demand
 * costs nothing until somebody opens it; the same view reached by a plain
 * `import` from the shell costs every launch, for everyone, forever — and the
 * change that does it looks like tidying up.
 *
 * The launch path is not one file. It is the entry chunk and everything the
 * entry chunk pulls in with a static import, transitively — a module two
 * static hops away is downloaded just as surely as one in the entry itself.
 * So that closure is what is computed here and what the rules below are
 * about.
 *
 * Nothing here is a budget in kilobytes: a number like that goes stale, gets
 * raised, and stops meaning anything. It names the few things known not to
 * belong on the way to the first frame, and says why for each.
 */

import { describe, it, expect, beforeAll } from 'vitest'
import { build } from 'vite'
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

interface Chunk {
  file: string
  isEntry?: boolean
  isDynamicEntry?: boolean
  /** Manifest keys this chunk imports with a plain `import`. */
  imports?: string[]
  /** Manifest keys this chunk imports only after an explicit `import()`. */
  dynamicImports?: string[]
}

/** Every script the browser downloads before it can paint, as text. */
let launchPath = ''

/** Every emitted script, so a marker can be found wherever it landed. */
let chunks = new Map<string, string>()

/** The production manifest and its static launch closure. */
let manifest: Record<string, Chunk> = {}
let entryKey = ''
let launchKeys = new Set<string>()

/** The emitted worker, whose injected file list is the offline precache. */
let serviceWorker = ''

/**
 * A string that exists inside the QR encoder's body and nowhere else.
 *
 * A minifier renames every function it emits, so a name is not a marker. A
 * literal it has to keep is.
 */
const ENCODER = 'data length overflow'

beforeAll(async () => {
  const outDir = mkdtempSync(join(tmpdir(), 'ftw-entry-'))
  // Vitest runs with NODE_ENV=test. Vite derives import.meta.env.DEV from that
  // process value even when its build mode is production, so leaving it alone
  // makes this test compile the development simulator path and then call the
  // result a production bundle. Match `vite build`, and put the runner's value
  // back before any other test can observe it.
  const priorNodeEnv = process.env['NODE_ENV']
  process.env['NODE_ENV'] = 'production'
  try {
    await build({ mode: 'production', logLevel: 'silent', build: { outDir, sourcemap: false } })
  } finally {
    if (priorNodeEnv === undefined) delete process.env['NODE_ENV']
    else process.env['NODE_ENV'] = priorNodeEnv
  }

  manifest = JSON.parse(
    readFileSync(join(outDir, '.vite/manifest.json'), 'utf8')
  ) as Record<string, Chunk>

  entryKey = Object.keys(manifest).find(
    (key) => manifest[key]!.isEntry && manifest[key]!.file.endsWith('.js')
  ) ?? ''
  expect(entryKey, 'the build emitted no entry chunk').not.toBe('')

  // The static closure. `imports` is the plain-import edge; `dynamicImports`
  // is deliberately not followed, because that is exactly the edge that costs
  // nothing until something asks.
  const walk = (key: string) => {
    if (launchKeys.has(key)) return
    launchKeys.add(key)
    for (const next of manifest[key]?.imports ?? []) walk(next)
  }
  walk(entryKey)

  for (const chunk of Object.values(manifest)) {
    if (chunk.file.endsWith('.js')) {
      chunks.set(chunk.file, readFileSync(join(outDir, chunk.file), 'utf8'))
    }
  }
  launchPath = [...launchKeys]
    .map((key) => chunks.get(manifest[key]!.file) ?? '')
    .join('\n')
  serviceWorker = readFileSync(join(outDir, 'sw.js'), 'utf8')
}, 120_000)

/** Fails loudly when a marker has stopped naming exactly one chunk. */
function chunkWith(marker: string): string {
  const found = [...chunks].filter(([, code]) => code.includes(marker))
  expect(found.length, `${marker} is in ${found.length} chunks, expected 1`).toBe(1)
  return found[0]![1]
}

describe('what a cold start downloads before it can paint', () => {
  it('is really the launch path and not the whole build', () => {
    // The control. Every rule below is an absence, and an absence proves
    // nothing if the thing being searched is empty or is everything.
    expect(launchPath.length, 'the launch path came out empty').toBeGreaterThan(1000)
    expect(chunks.size, 'the build was never split at all').toBeGreaterThan(3)
    // Something that must be there: the shell mounts the pairing screen
    // itself, because a phone with nothing paired has no other screen.
    expect(launchPath, 'the closure missed a chunk the shell imports').toContain(
      'Connect FTW'
    )
  })

  it('does not carry the QR encoder', () => {
    // Drawn on one screen, by one household, a handful of times in the life
    // of an install. The Reed-Solomon tables alone are larger than several
    // views. It arrives through `import()` in Access.svelte and again in
    // QrCode.svelte, and either one turned into a plain import puts it here.
    expect(launchPath, 'the QR encoder is on the launch path').not.toContain(ENCODER)
    // It is in the build, in one place — not merely missing.
    expect(chunkWith(ENCODER)).toContain(ENCODER)
  })

  it('does not carry the Overview cards under Now', () => {
    // Price, plan, today and the fuse are the rest of a glance, and they
    // wait until the house has painted. A plain import from Now would put
    // the price chart on every cold start.
    expect(launchPath, 'Overview cards entered the static launch closure').not.toContain(
      'What FTW does next',
    )
    expect(chunkWith('What FTW does next')).toContain('What FTW does next')
  })

  it('does not carry the QR decoder', () => {
    // jsQR is 130 kB and runs when a camera is pointed at something. The
    // pairing screen imports it on demand and this is what keeps it there.
    expect(launchPath, 'the camera decoder is on the launch path').not.toMatch(
      /binarize|extractSquare/
    )
  })

  it('keeps the public demo behind one dynamic edge and precaches it', () => {
    const demoKey = 'src/lib/demo/simulated-site.ts'
    const demo = manifest[demoKey]

    expect(demo, 'the public demo was not emitted').toBeDefined()
    expect(demo!.isDynamicEntry, 'the public demo is not a dynamic entry').toBe(true)
    expect(launchKeys.has(demoKey), 'the public demo entered the static launch closure').toBe(false)
    expect(
      manifest[entryKey]!.dynamicImports ?? [],
      'the app entry has no explicit dynamic edge to the public demo'
    ).toContain(demoKey)

    // Every emitted JS and CSS path in this object is fetched during service
    // worker install. The demo stays off the first frame but remains available
    // when an installed app is opened without a network.
    expect(serviceWorker, 'the public demo is missing from the offline precache').toContain(
      JSON.stringify(`/${demo!.file}`)
    )
  })
})
