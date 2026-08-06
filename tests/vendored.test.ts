/* The vendored components are copies, and this is what keeps them copies.
 *
 * Every file under src/vendor/ftw carries a header saying to change it
 * upstream and re-copy, never here. Nothing enforced that, and one file had
 * already drifted: price-summary.js kept a coercion the box had since fixed,
 * so it read a slot's `total: null` as a supplied 0 where the box's own
 * dashboard recomputed it. Inert in this app today — the compact card is
 * never rendered here — and exactly the divergence the vendoring exists to
 * prevent.
 *
 * A recorded digest per file, because the box repo is not checked out beside
 * this one in CI and there is nothing to diff against. The digest covers the
 * body only, everything past the provenance header, so re-stamping that
 * header with a commit hash when the box side lands is not mistaken for
 * someone editing the file.
 *
 * When a vendored file legitimately changes: change it in the box, copy it
 * here, keep the header, and re-record with
 *   RECORD_VENDOR_DIGESTS=1 npx vitest run tests/vendored.test.ts
 * That is deliberately a separate act. A check that re-records itself on the
 * way past would agree with an edit made here just as readily as with a
 * re-copy, which is the whole thing this is here to tell apart.
 */

import { describe, it, expect } from 'vitest'
import { createHash } from 'node:crypto'
import { readFileSync, writeFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'

// From the project root, which is where vitest runs. import.meta.url is not
// a file URL here — the test is transformed and served like any other module.
const DIR = join(process.cwd(), 'src/vendor/ftw')
const RECORD = join(DIR, 'digests.json')

/** Lines of provenance every vendored file opens with. Not part of the copy. */
const HEADER_LINES = 3

const PROVENANCE = /^\/\/ Vendored from srcfl\/ftw web\/components\/(.+) at (.+)\.$/

/** The `.js` files are the box's. The `.d.ts` beside them are this app's. */
function vendored(): string[] {
  return readdirSync(DIR)
    .filter((name) => name.endsWith('.js'))
    .sort()
}

function linesOf(name: string): string[] {
  return readFileSync(join(DIR, name), 'utf8').split('\n')
}

function bodyOf(name: string): string {
  return linesOf(name).slice(HEADER_LINES).join('\n')
}

function digests(): Record<string, string> {
  const out: Record<string, string> = {}
  for (const name of vendored()) {
    out[name] = createHash('sha256').update(bodyOf(name)).digest('hex')
  }
  return out
}

if (process.env.RECORD_VENDOR_DIGESTS) {
  writeFileSync(RECORD, `${JSON.stringify(digests(), null, 2)}\n`)
}

const recorded = JSON.parse(readFileSync(RECORD, 'utf8')) as Record<string, string>

describe('the vendored components', () => {
  it('each say where they came from', () => {
    for (const name of vendored()) {
      const [first, ...rest] = linesOf(name)
      const cites = PROVENANCE.exec(first ?? '')

      expect(cites, `${name} has no provenance line`).not.toBeNull()
      // A file that cites another file's name is a copy that was pasted over
      // the wrong one, and the digest below would not notice.
      expect(cites![1], `${name} cites ${cites![1]} upstream`).toBe(name)
      expect(rest.slice(0, HEADER_LINES - 1).join(' ')).toMatch(/do not edit here/i)
    }
  })

  it('are the record of what was copied, file for file', () => {
    // A file added or removed without its digest being recorded is a file
    // nothing below is checking.
    expect(Object.keys(digests())).toEqual(Object.keys(recorded))
  })

  it('have not been edited in place', () => {
    for (const [name, digest] of Object.entries(digests())) {
      expect(
        digest,
        `${name} differs from what was vendored. Change it in the box and ` +
          're-copy, then re-record — see the top of this file.'
      ).toBe(recorded[name])
    }
  })
})
