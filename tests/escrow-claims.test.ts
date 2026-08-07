/* The escrow's story, held to one version of itself.
 *
 * The claim — "Sourceful holds a sealed copy it cannot open, with an opaque id
 * and nothing beside it" — has been false six times, and every one of them was
 * found by running the thing rather than by reading it. Four were in the
 * service: a managed database's point-in-time history, a proxy log, a b-tree
 * page's cell order, and the rollback journal written by the fix for that. The
 * fifth was not on a disk at all. The store was rebuilt as a file of fixed
 * slots and `escrow/README.md` was rewritten around it — and the architecture
 * of record went on describing the store that had just been replaced, stating
 * failures three and four as the guarantee that made the claim safe.
 *
 * The sixth is not on a disk either, and it is the one left open: an accepted
 * write pays two fsyncs and everything else pays none, so the service can be
 * heard writing by anybody who can send it a request. It names no household,
 * which is measured rather than asserted — and the last block below holds the
 * code to what the three tellings say about it, because a document describing a
 * channel that has been closed rots exactly as quietly as one describing a
 * store that has been replaced.
 *
 * That is the failure this file exists to catch, and it is the cheapest one to
 * leave lying about: nothing goes red when a document goes stale, so the
 * document is where a dead store lives longest. Someone reads it to learn the
 * design.
 *
 * Two rules, both mechanical:
 *
 *   1. Where the escrow is described in the present tense, it is described as
 *      what runs. The names of the stores it used to be belong to the history,
 *      and the history is marked.
 *   2. Everywhere the story is told, it is told with the same count. Three
 *      files tell it, and a seventh failure has to move all three or this
 *      fails.
 */

import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

// From the project root, which is where vitest runs. import.meta.url is not a
// file URL here — the test is transformed and served like any other module.
const read = (path: string) => readFileSync(join(process.cwd(), path), 'utf8')

/** The names of stores the escrow used to be. None of them runs anywhere. */
const REPLACED = ['SQLite', 'VACUUM', 'Time Travel', 'D1']

/**
 * Where the history starts in the architecture doc.
 *
 * Everything above it is the design as it is; everything below it is how the
 * claim was broken and what that cost. The marker is a heading in bold rather
 * than a comment, so the split a reader sees is the split this test makes.
 */
const HISTORY_MARKER = '**The claim has been false six times'

/** The escrow's own section, from its heading to the next one. */
function escrowSection(): string {
  const doc = read('docs/architecture.md')
  const start = doc.indexOf('## The escrow')
  expect(start, 'the architecture doc has no escrow section').toBeGreaterThan(-1)
  const end = doc.indexOf('\n## ', start + 1)
  return doc.slice(start, end === -1 ? undefined : end)
}

describe('the architecture of record, against the store that runs', () => {
  it('describes the store the service actually opens', () => {
    const [design] = escrowSection().split(HISTORY_MARKER)

    // What runs: one file, fixed slots, a record's place a function of its id.
    // `escrow/layout.md` is the format, and the doc has to point at it rather
    // than describe a schema of its own that can drift from the bytes.
    expect(design, 'the design half never says what the store is now').toMatch(
      /fixed slot|slot file|file of fixed slots/i
    )
    expect(design).toMatch(/layout\.md/)
  })

  it('names a replaced store only in the history, never as the guarantee', () => {
    const section = escrowSection()
    const marker = section.indexOf(HISTORY_MARKER)
    expect(marker, 'the escrow section does not mark where its history starts').toBeGreaterThan(-1)

    const design = section.slice(0, marker)
    for (const name of REPLACED) {
      expect(
        design.includes(name),
        `"${name}" is a store nobody runs, described where the doc says what the escrow is`
      ).toBe(false)
    }
  })

  it('does not sell a replaced store as the reason the claim holds', () => {
    // The exact shape of the fault: failures three and four, written down as
    // the thing that makes the claim safe.
    const section = escrowSection().replace(/\s+/g, ' ')
    expect(section).not.toMatch(/nothing in a SQLite file is a clock/i)
    expect(section).not.toMatch(/the store is now a SQLite file/i)
  })
})

describe("the app's own README", () => {
  it('does not list the sealed copy among the things not built yet', () => {
    // It is built: the pairing screen offers it, the client opens it, and
    // `tests/escrow-e2e.test.ts` drives it end to end against the service. A
    // README that calls a shipped way back "not yet built" sends the one
    // person who needs it looking somewhere else.
    expect(read('src/lib/identity/escrow.ts')).toMatch(/export async function recoverFromEscrow/)

    const readme = read('README.md').replace(/\s+/g, ' ')
    const start = readme.indexOf('Not yet built')
    expect(start, 'the README no longer says what is missing').toBeGreaterThan(-1)
    expect(readme.slice(start, readme.indexOf('.', start) + 1)).not.toMatch(/escrow/i)
  })

  it('does not describe the escrow as rows in a database', () => {
    const readme = read('README.md').replace(/\s+/g, ' ')
    expect(readme, 'the escrow holds slots in one file, not one row per household').not.toMatch(
      /row per household/i
    )
    for (const name of REPLACED.filter((n) => n !== 'D1')) {
      expect(readme.includes(name), `"${name}" is a store nobody runs`).toBe(false)
    }
  })
})

/** "was false six times" — the one number a telling carries. */
function countIn(path: string): string {
  const text = read(path).replace(/\s+/g, ' ')
  const found = [...text.matchAll(/false (\w+) times/g)].map((m) => m[1]!)
  expect(found.length, `${path} tells the story ${found.length} times, not once`).toBe(1)
  return found[0]!
}

describe('the count of failures, wherever the story is told', () => {
  it('agrees across the three places that tell it', () => {
    // The architecture doc is where somebody goes to learn the design; the
    // escrow's own README is where an outsider checks it; the comment above
    // the client is where the next person to touch the wire reads it. All
    // three carried a count, and the doc of record carried the wrong one.
    const architecture = countIn('docs/architecture.md')
    const readme = countIn('escrow/README.md')
    const client = countIn('src/lib/identity/escrow.ts')

    expect({ architecture, readme, client }).toEqual({
      architecture,
      readme: architecture,
      client: architecture,
    })
  })

  it('counts the two that were not on a disk', () => {
    // Four in the service, one in the document that described it, and one on
    // the clock. A count of four is the count from before this file existed and
    // is exactly the failure this file is named after; a count of five is the
    // count from before the clock was measured.
    expect(countIn('escrow/README.md')).toBe('six')
  })
})

describe('the fourth telling, which counts the host and not the document', () => {
  /**
   * `escrow/deploy/README.md` tells the story too, and its count is four on
   * purpose: the sentence it is about is the host's, and neither the fifth
   * failure nor the sixth is a thing the host keeps. That is right and it is
   * also exactly what a stale count looks like from the outside — a reader
   * coming from a doc that says six has nothing to tell the two apart with. So
   * the smaller number has to carry its own reason, and the reason is held here
   * rather than left to survive the next edit on somebody's goodwill.
   *
   * The gap was one and is now two, so what this checks is the gap and both of
   * the reasons for it, not a form of words that happened to be true once.
   */
  const DEPLOY = 'escrow/deploy/README.md'

  it('counts the four that were on the host', () => {
    expect(countIn(DEPLOY)).toBe('four')
  })

  it('says why it is two fewer than the other three', () => {
    const text = read(DEPLOY).replace(/\s+/g, ' ')
    const at = text.indexOf('false four times')
    expect(at, `${DEPLOY} no longer tells the story`).toBeGreaterThan(-1)

    // In the paragraph, not somewhere else in a long file: the reader who can
    // be misled is the one reading this sentence.
    const paragraph = text.slice(at, at + 800)
    expect(paragraph, 'the smaller count does not say how far behind it is').toMatch(/two fewer/i)
    expect(paragraph, 'the smaller count does not say which two it leaves out').toMatch(/fifth/i)
    expect(paragraph, 'the smaller count does not say which two it leaves out').toMatch(/sixth/i)
    expect(paragraph, 'the smaller count does not point at the fuller one').toMatch(
      /README\.md|architecture\.md/
    )
  })
})

/**
 * The sixth, held to the code it is a claim about.
 *
 * All three tellings now say the same mechanical thing: an accepted write pays
 * two fsyncs and a read pays none. That is a sentence about `escrow/src/store.ts`
 * and about nothing else, so it is read off that file rather than believed. If
 * somebody closes the channel — an fsync on the read path, or one fewer on the
 * write — the three documents go wrong in the quietest way there is, which is
 * the failure this whole file is named after arriving from the other direction.
 *
 * And bumping a count is not telling the story, so each of the three has to
 * carry the mechanism, and the residue list has to carry the price with numbers
 * in it. "Some timing is left" is the sentence this file exists to refuse.
 */
describe('the sixth, against the code the three tellings describe', () => {
  const between = (text: string, from: string, to: string): string => {
    const start = text.indexOf(from)
    expect(start, `escrow/src/store.ts no longer has "${from}"`).toBeGreaterThan(-1)
    const end = text.indexOf(to, start + from.length)
    expect(end, `escrow/src/store.ts no longer has "${to}" after "${from}"`).toBeGreaterThan(-1)
    return text.slice(start, end)
  }
  const syncs = (text: string) => [...text.matchAll(/^\s*fsyncSync\(/gm)].length

  it('reads without touching the disk', () => {
    expect(syncs(between(read('escrow/src/store.ts'), 'async read(id) {', 'async write({'))).toBe(0)
  })

  it('writes with exactly the two every telling counts', () => {
    expect(syncs(between(read('escrow/src/store.ts'), 'async write({', '// The file'))).toBe(2)
  })

  it('is named, not merely counted, in all three', () => {
    for (const path of ['docs/architecture.md', 'escrow/README.md', 'src/lib/identity/escrow.ts']) {
      expect(read(path).replace(/\s+/g, ' '), `${path} counts the sixth without saying what it is`).toMatch(
        /two fsyncs/i
      )
    }
  })

  it('is priced where the residue is listed, with numbers', () => {
    const readme = read('escrow/README.md')
    const start = readme.indexOf('## What it still knows')
    expect(start, "escrow/README.md has no 'what it still knows'").toBeGreaterThan(-1)
    const section = readme.slice(start, readme.indexOf('\n## ', start + 1))

    expect(section, 'the residue list does not carry the sixth').toMatch(/fsync/i)
    expect(section, 'the sixth is named in the residue list without what it costs').toMatch(
      /\d+\.\d+ ms/
    )
  })
})
