/* What Sourceful can read, said the same way everywhere it is said.
 *
 * Until FTW Cloud, "Sourceful cannot read your data" was true of every
 * Sourceful service this app touches. FTW Cloud (srcfl/ftw ADR 0008) is a
 * separate service for the iPhone app, and it can read what a box owner turns
 * on. The relay and the escrow are as blind as before, so their claims stand.
 * A sentence that says "Sourceful's services" or "the cloud" without naming
 * them now claims more than is true.
 *
 * Nothing goes red when a document goes stale, so this file reads them. Two
 * rules, both mechanical:
 *
 *   1. The broad sentences are gone. No document says that Sourceful's
 *      services, or the cloud as a whole, cannot read the data.
 *   2. Every document that tells a reader what Sourceful cannot read also
 *      names FTW Cloud and links the ADR, so the exception sits beside the
 *      claim.
 */

import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

// From the project root, which is where vitest runs.
const read = (path: string) =>
  readFileSync(join(process.cwd(), path), 'utf8').replace(/\s+/g, ' ')

/** The documents that tell a reader what Sourceful can and cannot read. */
const DOCS = ['README.md', 'docs/architecture.md', 'relay/README.md']

/** The sentences that were true before FTW Cloud and are too broad now. */
const BROAD = [
  /Sourceful's services cannot decrypt/i,
  /Sourceful's cloud carries the traffic and cannot read it/i,
  /\bthe cloud is blind\b/i,
  /only remote path between the two/i,
]

const ADR = 'srcfl/ftw/blob/master/docs/adr/0008-ftw-cloud.md'

describe('what Sourceful can read', () => {
  for (const path of DOCS) {
    it(`${path} claims nothing broader than the relay and escrow`, () => {
      const text = read(path)
      for (const pattern of BROAD) {
        expect(text, `${path} still says ${pattern}`).not.toMatch(pattern)
      }
    })

    it(`${path} names FTW Cloud beside its claim`, () => {
      const text = read(path)
      expect(
        text,
        `${path} no longer says what Sourceful cannot read; if that is on purpose, drop it from DOCS`
      ).toMatch(/cannot (read|decrypt)/i)
      expect(text, `${path} makes the claim without naming the exception`).toContain('FTW Cloud')
      expect(text, `${path} names FTW Cloud without linking the decision`).toContain(ADR)
    })
  }

  it('states the claim for the relay and the escrow by name', () => {
    expect(read('docs/architecture.md')).toContain(
      `**"Sourceful's relay and escrow cannot decrypt your energy data"**`
    )
  })
})
