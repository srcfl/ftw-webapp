#!/usr/bin/env node

/* contract/ holds files that live in two repositories — registry.yaml and
 * push-catalogue.yaml — and this is the only thing that can tell whether each
 * still is one file.
 *
 * The registry's header has always said CI fails when the two drift. Nothing
 * checked it. tests/registry-contract.test.ts compares this repository's copy
 * against this repository's code, which it should — but from inside one clone
 * the other copy is not there to compare against, and the two drifted three
 * ways under that test without a word: a code the app declared that the box
 * had never heard of, a code the box sent that the app had never heard of, and
 * a retryable flag that disagreed in the direction that mattered. The push
 * catalogue is the same arrangement with higher stakes: the box renders those
 * sentences onto lock screens, so a drifted copy is the box speaking words
 * this app never wrote.
 *
 * So this takes a path to the box's registry.yaml, finds the catalogue beside
 * it, and refuses to have an opinion without both. There is deliberately no
 * mode where a missing checkout — or a missing sibling — is treated as
 * agreement: a check that quietly does nothing is how the last one failed,
 * and it would fail the same way again on the day someone renames a file in
 * CI.
 *
 *   node scripts/check-contract-drift.mjs ../ftw/contract/registry.yaml
 *   FTW_BOX_REGISTRY=../ftw/contract/registry.yaml npm run check:contract
 *
 * The box runs the same comparison the other way round — see the contract job
 * in .github/workflows/test.yml over there. Either side alone leaves a window
 * where one repository merges a change and the other only finds out on its
 * next push.
 */

import { readFileSync, statSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join, resolve } from 'node:path'

const HERE = dirname(fileURLToPath(import.meta.url))

/** Every file that is one file in two repositories. */
const PAIRED = ['registry.yaml', 'push-catalogue.yaml']

/** Exit with a sentence that says what to do, not what went wrong inside. */
function stop(message) {
  console.error(`\ncontract drift check: ${message}\n`)
  process.exit(1)
}

const given = process.argv[2] ?? process.env['FTW_BOX_REGISTRY']
if (!given) {
  stop(
    'no box copy to compare against.\n\n' +
      "  Pass the path to the box's contract/registry.yaml:\n" +
      '    node scripts/check-contract-drift.mjs ../ftw/contract/registry.yaml\n\n' +
      '  In CI this means the srcfl/ftw checkout step is missing or moved.\n' +
      '  This check has no opinion without both copies and will not pretend to.'
  )
}

const boxContract = dirname(resolve(given))

for (const name of PAIRED) {
  const mine = join(HERE, '..', 'contract', name)
  const theirs = join(boxContract, name)

  try {
    if (!statSync(theirs).isFile()) stop(`${theirs} is not a file.`)
  } catch {
    stop(
      `${theirs} does not exist.\n\n` +
        `  That path is where the box's copy of ${name} was expected — beside\n` +
        '  its registry.yaml, as it is here. A missing copy is not agreement,\n' +
        '  so this fails rather than skips.'
    )
  }

  compare(name, mine, theirs)
}

/** Byte-for-byte, and a line-level account when they differ. */
function compare(name, minePath, theirsPath) {
  const mine = readFileSync(minePath, 'utf8')
  const box = readFileSync(theirsPath, 'utf8')

  if (mine === box) {
    console.log(`contract/${name} matches ${theirsPath} — ${mine.length} bytes, byte for byte`)
    return
  }

  // Line for line rather than a real diff. Each file is a few hundred lines
  // of flat blocks, and "these lines are only on one side" is what a reader
  // needs.
  const here = mine.split('\n')
  const there = box.split('\n')

  const firstDivergence = here.findIndex((line, i) => line !== there[i])
  const onlyHere = here.filter((line) => line.trim() && !there.includes(line))
  const onlyThere = there.filter((line) => line.trim() && !here.includes(line))

  const report = [
    `the two copies of contract/${name} have drifted.`,
    '',
    `  app: ${minePath}`,
    `  box: ${theirsPath}`,
    '',
    `  first line that differs: ${firstDivergence + 1}`,
    '',
  ]

  if (onlyHere.length) {
    report.push('  only in the app:')
    for (const line of onlyHere) report.push(`    - ${line.trim()}`)
    report.push('')
  }
  if (onlyThere.length) {
    report.push('  only in the box:')
    for (const line of onlyThere) report.push(`    + ${line.trim()}`)
    report.push('')
  }

  report.push(
    '  This file is one file in two repositories. Decide which side is right by',
    "  reading what each side's code does, then change both copies in the same",
    '  pair of pull requests — and regenerate what the box builds from it',
    '  (`go generate ./internal/...` for the registry, the push templates for',
    '  the catalogue).'
  )

  stop(report.join('\n'))
}
