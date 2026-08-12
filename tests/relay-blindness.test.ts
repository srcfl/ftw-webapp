// @vitest-environment node

/* The proof.
 *
 * docs/architecture.md makes one claim about the cloud that is architecture
 * rather than policy: "Sourceful's services cannot decrypt your energy data."
 * This file is what that sentence is worth. It runs a real box against a real
 * app across a real relay, collects everything the relay touched — every byte
 * routed, every line logged, everything held in memory — and fails if anything
 * recognisable is in it.
 *
 * A test like this is worthless if the detector is blunt, so the detector is
 * checked first: the same session's frames, unsealed, must trip every part of
 * it. If that control ever stops failing, the rest of this file is decoration.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { RelayServer } from '../relay/src/server.ts'
import { rendezvousHandle, currentEpoch } from '$lib/carrier/rendezvous'
import { encode as cborEncode } from 'cbor2'
import { encodeFrame } from '$lib/protocol/frame'
import { sealedPair, waitFor } from './support/relay-harness.ts'

/**
 * A secret the box and the app share optically. The relay never sees it.
 *
 * One per test, so two tests never land in the same room — a handle is a room
 * and a room holds exactly one uplink.
 */
function secretFor(n: number): Uint8Array {
  return new Uint8Array(32).fill(n)
}

const SECRET = secretFor(7)

/**
 * Strings a household would recognise as its own.
 *
 * Message types and field names, because they say what the app is doing.
 * Source ids and device names, because they say what hardware is in the house.
 * The box id and its timezone, because together they are close to an address.
 */
const KNOWN_STRINGS = [
  'hello_ok',
  'snap',
  'delta',
  'tick',
  'session.terminate',
  'grid_w',
  'pv_w',
  'battery_w',
  'battery_soc',
  'load_w',
  'meter.p1',
  'inverter.sungrow',
  'battery.sungrow',
  'P1 meter',
  'Sungrow inverter',
  'sim-0001',
  'Europe/Stockholm',
  'der.battery',
  'plan.dispatch',
  'dispatchBlockedBy',
]

function countBytes(haystack: Uint8Array, needle: Uint8Array): number {
  let count = 0
  outer: for (let i = 0; i + needle.length <= haystack.length; i++) {
    for (let j = 0; j < needle.length; j++) {
      if (haystack[i + j] !== needle[j]) continue outer
    }
    count++
  }
  return count
}

/**
 * The shortest needle worth searching for, in bytes.
 *
 * The dump is around 36 kB. Four bytes looked safe in isolation, but this test
 * searches two byte orders across a household of readings on every run. It
 * eventually found an int32-shaped coincidence in honest ciphertext and
 * failed the secure transport. Eight bytes puts that accidental match beyond
 * a useful CI horizon.
 *
 * A lone int32 is only four bytes, so the detector searches adjacent int32
 * readings as one eight-byte needle. A float64 is already eight. Short words
 * such as "snap" and "tick" must occur twice; this session sends repeated
 * frames in plaintext, while two equal four-byte ciphertext coincidences are
 * still far beyond a useful CI horizon.
 */
const MIN_NEEDLE_BYTES = 8

/**
 * How a reading could appear on this wire.
 *
 * The raw widths, in case a future carrier packs readings some other way:
 * eight bytes for a float64. Adjacent int32 readings are handled as a pair
 * below: retaining their coverage without treating one random four-byte match
 * as disclosure. The CBOR form is offered too when it is long enough.
 *
 * Dropping the short CBOR forms costs this test nothing. A reading can only
 * be CBOR on this wire by sitting in an envelope, and an envelope carries its
 * type and its field names — 'snap', 'delta', 'grid_w', 'battery_soc' — every
 * one of which is in KNOWN_STRINGS above and searched for regardless of how
 * long the numbers beside it are. A CBOR leak is caught by its words before
 * it is caught by its digits.
 */
function encodingsOf(value: number): Uint8Array[] {
  const out: Uint8Array[] = [cborEncode(value)]
  for (const little of [true, false]) {
    const i32 = new DataView(new ArrayBuffer(4))
    i32.setInt32(0, value, little)
    out.push(new Uint8Array(i32.buffer))

    const f64 = new DataView(new ArrayBuffer(8))
    f64.setFloat64(0, value, little)
    out.push(new Uint8Array(f64.buffer))
  }
  return out.filter((n) => n.length >= MIN_NEEDLE_BYTES)
}

/** Raw int32 coverage without a four-byte false-positive oracle. */
function int32PairEncodingsOf(values: number[]): Uint8Array[] {
  const out: Uint8Array[] = []
  for (let i = 0; i + 1 < values.length; i++) {
    const first = values[i]!
    const second = values[i + 1]!
    // A pair containing a near-zero reading is mostly zero bytes and reveals
    // no household.
    if (Math.abs(first) < 256 || Math.abs(second) < 256) continue

    for (const little of [true, false]) {
      const pair = new DataView(new ArrayBuffer(8))
      pair.setInt32(0, first, little)
      pair.setInt32(4, second, little)
      out.push(new Uint8Array(pair.buffer))
    }
  }
  return out
}

function findBytes(haystack: Uint8Array, needle: Uint8Array): boolean {
  if (needle.length === 0) return false
  outer: for (let i = 0; i + needle.length <= haystack.length; i++) {
    for (let j = 0; j < needle.length; j++) {
      if (haystack[i + j] !== needle[j]) continue outer
    }
    return true
  }
  return false
}

function concat(parts: Uint8Array[]): Uint8Array {
  const total = parts.reduce((n, p) => n + p.length, 0)
  const out = new Uint8Array(total)
  let at = 0
  for (const p of parts) {
    out.set(p, at)
    at += p.length
  }
  return out
}

/** Which of the known strings and readings the dump gives away. */
function leaks(dump: Uint8Array, readings: number[]): string[] {
  const found: string[] = []
  for (const s of KNOWN_STRINGS) {
    const bytes = new TextEncoder().encode(s)
    const occurrences = countBytes(dump, bytes)
    if (occurrences >= (bytes.length >= MIN_NEEDLE_BYTES ? 1 : 2)) found.push(`string:${s}`)
  }
  for (const value of readings) {
    // A number near zero has no encoding worth hunting for: it is a couple of
    // low-entropy bytes, and every stream of ciphertext is full of those. The
    // readings that would actually give a household away — kilowatts of solar,
    // of load, of battery — are all well clear of this line.
    if (Math.abs(value) < 256) continue
    for (const encoding of encodingsOf(value)) {
      if (findBytes(dump, encoding)) {
        found.push(`reading:${value}`)
        break
      }
    }
  }
  for (const encoding of int32PairEncodingsOf(readings)) {
    if (findBytes(dump, encoding)) {
      found.push('reading:int32-pair')
      break
    }
  }
  return found
}

describe('the relay cannot read what it carries', () => {
  let relay: RelayServer
  let logs: string[]

  beforeAll(async () => {
    logs = []
    relay = await RelayServer.start({
      heartbeatMs: 40,
      log: (line) => logs.push(line),
    })
  })

  afterAll(async () => {
    await relay.stop()
  })

  it('hunts only for needles long enough to mean something', () => {
    // Checked rather than argued in a comment, because the argument is what
    // went wrong: the prose made the case against two-byte needles and the
    // code stopped one byte short, so every reading a house actually produces
    // was searched for as three bytes. 620 — a state of charge — was the first
    // coincidence; after moving to four bytes, 4235 eventually proved that
    // threshold flaky too, again on a run where nothing leaked at all.
    // Eight is written out here rather than read from MIN_NEEDLE_BYTES on
    // purpose: checking a filter against the filter's own threshold passes
    // whatever the threshold is, which is the same nothing this test was
    // added to stop.
    for (const value of [300, 620, 1555, 65_535, -3_456, 1_000_000]) {
      for (const needle of encodingsOf(value)) {
        expect(
          needle.length,
          `${value} is hunted for as ${needle.length} bytes`
        ).toBeGreaterThanOrEqual(8)
      }
      // And the floor must not empty the quiver: a reading with nothing left
      // to search for is a reading this test has stopped covering.
      expect(encodingsOf(value).length, `nothing left to search for ${value}`).toBeGreaterThan(0)
    }

    const int32Pairs = int32PairEncodingsOf([1555, -3456])
    expect(int32Pairs).toHaveLength(2)
    for (const pair of int32Pairs) expect(pair).toHaveLength(8)
  })

  it('requires a repeated short protocol word, not one ciphertext coincidence', () => {
    const encoder = new TextEncoder()
    expect(leaks(encoder.encode('before snap after'), [])).toEqual([])
    expect(leaks(encoder.encode('before snap between snap after'), [])).toEqual(['string:snap'])
  })

  it('dumps everything it saw and gives nothing away', async () => {
    const pair = await sealedPair(relay.url, SECRET)

    // A minute of the house, including a device dropping out and coming back,
    // so the dump holds source states and dispatch blocking as well as watts.
    for (let i = 0; i < 20; i++) pair.box.tick()
    pair.box.faults = { ...pair.box.faults, sourceStates: { 'meter.p1': 'down' } }
    for (let i = 0; i < 10; i++) pair.box.tick()
    pair.box.faults = { ...pair.box.faults, sourceStates: {} }
    for (let i = 0; i < 20; i++) pair.box.tick()

    await waitFor(() => pair.session.state.fields.size > 0, 'readings')
    await new Promise((r) => setTimeout(r, 120))

    const readings = [...pair.session.state.fields.values()]
    expect(readings.some((v) => Math.abs(v) > 256)).toBe(true)
    expect(int32PairEncodingsOf(readings).length).toBeGreaterThan(0)

    const inspection = relay.inspect()
    const dump = concat([
      ...pair.wire,
      new TextEncoder().encode(logs.join('\n')),
      new TextEncoder().encode(JSON.stringify(inspection)),
    ])

    // The control, and it is two claims rather than one. "Something was
    // found" was satisfied by the words alone, so the half of the detector
    // that hunts for numbers was never proven — which is how its needles came
    // to be a byte too short without anything noticing.
    const plainFrame = encodeFrame(
      { lane: 0, flags: 0, envelope: { t: 'snap', b: { fields: readings } } },
      4096
    )
    const plain = concat([plainFrame, plainFrame])
    expect(leaks(plain, readings).some((f) => f.startsWith('string:'))).toBe(true)

    // Two readings packed as raw int32 — the shape the pair needle exists
    // for, and the one no envelope would announce with a name.
    const identifiable = readings.filter((v) => Math.abs(v) >= 256).slice(0, 2)
    expect(identifiable).toHaveLength(2)
    const packed = new DataView(new ArrayBuffer(identifiable.length * 4))
    identifiable.forEach((v, i) => packed.setInt32(i * 4, v, true))
    expect(
      leaks(new Uint8Array(packed.buffer), identifiable).some((f) => f.startsWith('reading:'))
    ).toBe(true)

    expect(leaks(dump, readings)).toEqual([])
    expect(inspection.framesRouted).toBeGreaterThan(40)

    pair.stop()
  })

  it('never writes down which handle was here', async () => {
    const pair = await sealedPair(relay.url, secretFor(8))
    for (let i = 0; i < 5; i++) pair.box.tick()
    await new Promise((r) => setTimeout(r, 120))

    // The handle is opaque, but it is still the one identifier the relay
    // holds. Keeping it out of the log is what stops an hour of operation
    // from becoming a permanent record of it.
    expect(logs.length).toBeGreaterThan(0)
    expect(logs.join('\n')).not.toContain(pair.handle)

    pair.stop()
  })

  it('cannot answer "which boxes exist" once they hang up', async () => {
    // Its own relay, so the assertion is about every room there is rather
    // than about one among several.
    const own = await RelayServer.start({ heartbeatMs: 1000 })
    const pair = await sealedPair(own.url, secretFor(9))
    expect(own.inspect().rooms).toHaveLength(1)

    pair.stop()
    await waitFor(() => own.inspect().rooms.length === 0, 'the room to be forgotten')

    // Not "declines to answer". There is nowhere the answer could come from.
    expect(own.inspect().rooms).toEqual([])
    expect(own.inspect().sockets).toBe(0)
    await own.stop()
  })

  it('hands out a different handle every epoch', () => {
    const now = currentEpoch()
    const handles = new Set([
      rendezvousHandle(SECRET, now),
      rendezvousHandle(SECRET, now + 1),
      rendezvousHandle(SECRET, now + 24),
      rendezvousHandle(SECRET, now + 24 * 365),
    ])
    expect(handles.size).toBe(4)

    // Unlinkable, not merely different: without the secret there is no
    // function from one handle to the next. The relay has only the secret's
    // outputs, never the secret.
    const other = new Uint8Array(32).fill(9)
    expect(rendezvousHandle(other, now)).not.toBe(rendezvousHandle(SECRET, now))
  })
})
