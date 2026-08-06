/* The wire contract for `stale` is prose, and this is what keeps it true.
 *
 * One flag covers three shapes of short answer, and the two places a future
 * implementer reads first are a docstring and a document — neither of which
 * the compiler, the type system or any other test in this tree can contradict.
 * Both spent a release describing two shapes after the box had begun setting
 * the flag for a third, while the app one directory away already read all
 * three off the slots. A claim outrunning the code is the defect this whole
 * area keeps producing, so the claim gets a test.
 *
 * Not a spelling test. What is pinned is the count and the shape that was
 * missing, and both of those have to move when the box's rule moves. Reword
 * either passage as freely as you like; say something different about how many
 * shapes there are and this goes red.
 *
 * The box's own rule is `priceFrom` in go/internal/appproto/price.go: stale
 * unless the answer spans the window end to end with no hole in it — a head
 * that begins after `fromMs`, a gap between slots, and a tail that stops
 * before `toMs` are all the same flag.
 */

import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

/** From the project root, which is where vitest runs. */
const root = (p: string) => join(process.cwd(), p)

/** The `stale` docstring, from its opening line to the field it documents. */
function typeDoc(): string {
  const src = readFileSync(root('src/lib/protocol/messages.ts'), 'utf8')
  const from = src.indexOf('The answer does not cover the window asked for.')
  const to = src.indexOf('stale: boolean', from)
  expect(from, 'the stale docstring has been renamed or removed').toBeGreaterThan(-1)
  expect(to, 'the stale field is no longer below its own docstring').toBeGreaterThan(from)
  return src.slice(from, to)
}

/** The Prices section of the protocol document. */
function protocolDoc(): string {
  const src = readFileSync(root('docs/protocol.md'), 'utf8')
  const from = src.indexOf('\n## Prices\n')
  expect(from, 'the protocol document no longer has a Prices section').toBeGreaterThan(-1)
  const to = src.indexOf('\n## ', from + 1)
  return src.slice(from, to === -1 ? undefined : to)
}

describe('what the two written contracts say `stale` covers', () => {
  const sources: [string, () => string][] = [
    ['the Prices type', typeDoc],
    ['docs/protocol.md', protocolDoc],
  ]

  // Both passages are hard-wrapped, and a comment block puts ` * ` in the
  // middle of them, so a phrase can arrive with anything at all between its
  // words. Matching on a literal space would go red for a re-wrap.
  const phrase = (words: string) => new RegExp(words.split(' ').join('\\s+(?:\\*\\s+)?'), 'i')

  for (const [name, read] of sources) {
    it(`${name} counts three shapes, not two`, () => {
      const text = read()

      // The old contract, word for word. It survived a round of review by
      // being true of the box that existed when it was written.
      expect(text, 'still describing the contract the box replaced').not.toMatch(
        phrase('two shapes')
      )
      expect(text).toMatch(phrase('three shapes'))
    })

    it(`${name} names a window that begins after its start`, () => {
      const text = read()

      // The shape the box added, and the only one of the three that a reader
      // watching the tail alone would call a covered day. A store that first
      // heard from the market at breakfast answers a request from midnight
      // with slots that join each other perfectly — so the app draws six
      // missing hours as a market that simply went quiet, and the NOW marker
      // sits on the wrong bar with nothing on screen saying so.
      expect(text).toMatch(phrase('begins after'))
    })
  }
})
