/* The drift script, proved against copies that have actually drifted.
 *
 * scripts/check-contract-drift.mjs is the only thing that can see both
 * repositories' copies of the paired contract files, and its predecessor
 * failed by quietly doing nothing. So the property under test is not "it
 * passes when the copies match" alone — it is that a mutated copy and a
 * missing copy both turn the check red. A check like this is only worth
 * having once its failure has been watched happening.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { spawnSync } from 'node:child_process'
import { cpSync, mkdtempSync, rmSync, writeFileSync, appendFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const ROOT = process.cwd()
const SCRIPT = join(ROOT, 'scripts', 'check-contract-drift.mjs')

let boxContract: string

/** Run the script exactly as CI runs it: against the box's registry path. */
function run(): { status: number | null; out: string } {
  const result = spawnSync(process.execPath, [SCRIPT, join(boxContract, 'registry.yaml')], {
    encoding: 'utf8',
  })
  return { status: result.status, out: `${result.stdout}${result.stderr}` }
}

beforeEach(() => {
  // A stand-in for the box's checkout, seeded from this repository's own
  // copies — which is what "no drift" means.
  boxContract = mkdtempSync(join(tmpdir(), 'ftw-box-contract-'))
  for (const name of ['registry.yaml', 'push-catalogue.yaml']) {
    cpSync(join(ROOT, 'contract', name), join(boxContract, name))
  }
})

afterEach(() => {
  rmSync(boxContract, { recursive: true, force: true })
})

describe('the contract drift check', () => {
  it('passes when both files are byte-identical, and says which files it read', () => {
    const { status, out } = run()

    expect(out).toContain('registry.yaml matches')
    expect(out).toContain('push-catalogue.yaml matches')
    expect(status).toBe(0)
  })

  it('fails when the box’s push catalogue says something else', () => {
    // The exact failure this pairing exists for: the box wording a lock
    // screen sentence this app never wrote.
    const theirs = join(boxContract, 'push-catalogue.yaml')
    appendFileSync(
      theirs,
      '  - kind: box.homesick\n    title: A sentence the app never wrote\n    body: "..."\n'
    )

    const { status, out } = run()

    expect(status).toBe(1)
    expect(out).toContain('push-catalogue.yaml have drifted')
    expect(out).toContain('box.homesick')
  })

  it('fails when the registry drifts, exactly as before the catalogue joined', () => {
    writeFileSync(join(boxContract, 'registry.yaml'), 'version: 2\n')

    const { status, out } = run()

    expect(status).toBe(1)
    expect(out).toContain('registry.yaml have drifted')
  })

  it('treats a missing catalogue as a failure, never as agreement', () => {
    // A quietly-skipped file is how the previous check failed. A renamed
    // path or a sparse-checkout line someone dropped must turn CI red.
    rmSync(join(boxContract, 'push-catalogue.yaml'))

    const { status, out } = run()

    expect(status).toBe(1)
    expect(out).toContain('push-catalogue.yaml')
    expect(out).toContain('not agreement')
  })
})
