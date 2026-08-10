/* The push catalogue is the one place push sentences are written, and this is
 * what keeps the app's side true to it.
 *
 * The box renders every push from its byte-identical copy of
 * contract/push-catalogue.yaml, so the app never parses the catalogue at
 * runtime — all it carries is the KINDS list behind the toggles. A list
 * nothing reads back is the drift this project keeps meeting, so this checks
 * it against the catalogue the same way registry-contract.test.ts checks the
 * protocol tables against the registry: set equality, both directions.
 *
 * Deliberately not a YAML parser, for the registry test's reason: the
 * catalogue is a flat list whose shape is itself part of what is pinned.
 */

import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { KINDS } from '$lib/notify/kinds'

const catalogue = readFileSync(join(process.cwd(), 'contract/push-catalogue.yaml'), 'utf8')

/** Every event block: its kind, and which of title and body it carries. */
function catalogueEvents(): { kind: string; title: boolean; body: boolean }[] {
  const out: { kind: string; title: boolean; body: boolean }[] = []
  for (const line of catalogue.split('\n')) {
    if (line.trim().startsWith('#')) continue
    const kind = /^\s*-\s*kind:\s*(\S+)\s*$/.exec(line)
    if (kind) {
      out.push({ kind: kind[1]!, title: false, body: false })
      continue
    }
    const last = out.at(-1)
    if (!last) continue
    if (/^\s*title:\s*\S/.test(line)) last.title = true
    if (/^\s*body:\s*\S/.test(line)) last.body = true
  }
  return out
}

describe('the push kinds', () => {
  it('are the catalogue’s events exactly, in both directions', () => {
    // Both directions, because each miss hides differently: a kind here that
    // the catalogue lacks is a toggle for a notification no box will ever
    // send, and a catalogue event missing here is a notification nobody can
    // turn off — in a catalogue whose whole covenant is being mutable by the
    // person it interrupts.
    const declared = catalogueEvents().map((e) => e.kind)
    expect(declared.length, 'no events were found in the catalogue').toBeGreaterThan(0)
    expect([...KINDS].sort()).toEqual([...declared].sort())
  })

  it('each carry a rendered title and body in the catalogue', () => {
    // The box renders from this file and only this file. An event without
    // both is a push the box would have to word itself, which is the one
    // thing the catalogue exists to prevent.
    for (const event of catalogueEvents()) {
      expect(event.title, `${event.kind} has no title to render`).toBe(true)
      expect(event.body, `${event.kind} has no body to render`).toBe(true)
    }
  })
})
