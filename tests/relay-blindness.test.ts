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
 * How a reading could appear on this wire.
 *
 * The CBOR form first, because that is what a leak would actually look like —
 * a type byte and then the number, which is both precise and specific enough
 * to mean something. Then the raw widths, in case a future carrier packs
 * readings some other way.
 *
 * Needles under three bytes are dropped rather than searched. Any given
 * two-byte sequence turns up in thirty kilobytes of ciphertext about half the
 * time, so including them would make this test fail on coincidence instead of
 * on a leak, and a test that cries wolf gets deleted.
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
  return out.filter((n) => n.length >= 3)
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

    // The control. If the detector cannot catch plaintext, its silence on
    // ciphertext means nothing at all.
    const plain = concat([
      encodeFrame({ lane: 0, flags: 0, envelope: { t: 'snap', b: { fields: readings } } }, 4096),
    ])
    expect(leaks(plain, readings).length).toBeGreaterThan(0)

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
