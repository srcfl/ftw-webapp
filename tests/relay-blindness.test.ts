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

function findString(haystack: Uint8Array, needle: string): boolean {
  const bytes = new TextEncoder().encode(needle)
  outer: for (let i = 0; i + bytes.length <= haystack.length; i++) {
    for (let j = 0; j < bytes.length; j++) {
      if (haystack[i + j] !== bytes[j]) continue outer
    }
    return true
  }
  return false
}

/**
 * The shortest needle worth searching for, in bytes.
 *
 * The dump is around 36 kB, so any given three-byte sequence turns up in it
 * about twice in a thousand runs by coincidence — and with a handful of
 * readings searched that is a failure every few hundred runs against a relay
 * that leaked nothing. This file ran at three bytes and did exactly that. A
 * test people learn to re-run protects nothing, so the floor is four, where
 * the same sum is about one run in thirty thousand.
 */
const MIN_NEEDLE_BYTES = 4

/**
 * How a reading could appear on this wire.
 *
 * The raw widths, in case a future carrier packs readings some other way:
 * four bytes for an int32 and eight for a float64, both long enough that
 * finding one means something. The CBOR form is offered too and survives the
 * floor only for values past 65 535, which is where CBOR stops spending three
 * bytes on an integer.
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
  for (const s of KNOWN_STRINGS) if (findString(dump, s)) found.push(`string:${s}`)
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
    // was searched for as three bytes. 620 — a state of charge — is the one
    // that fired, on a run where nothing leaked at all.
    // Four is written out here rather than read from MIN_NEEDLE_BYTES on
    // purpose: checking a filter against the filter's own threshold passes
    // whatever the threshold is, which is the same nothing this test was
    // added to stop.
    for (const value of [300, 620, 1555, 65_535, -3_456, 1_000_000]) {
      for (const needle of encodingsOf(value)) {
        expect(
          needle.length,
          `${value} is hunted for as ${needle.length} bytes`
        ).toBeGreaterThanOrEqual(4)
      }
      // And the floor must not empty the quiver: a reading with nothing left
      // to search for is a reading this test has stopped covering.
      expect(encodingsOf(value).length, `nothing left to search for ${value}`).toBeGreaterThan(0)
    }
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
    const plain = encodeFrame(
      { lane: 0, flags: 0, envelope: { t: 'snap', b: { fields: readings } } },
      4096
    )
    expect(leaks(plain, readings).some((f) => f.startsWith('string:'))).toBe(true)

    // Readings packed as raw int32 — the shape the byte needles exist for,
    // and the one no envelope would announce with a name.
    const packed = new DataView(new ArrayBuffer(readings.length * 4))
    readings.forEach((v, i) => packed.setInt32(i * 4, v, true))
    expect(
      leaks(new Uint8Array(packed.buffer), readings).some((f) => f.startsWith('reading:'))
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
