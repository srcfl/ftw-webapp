// @vitest-environment node

/* Frame size and frame rate do not depend on what happened in the house.
 *
 * This is the second half of the privacy claim and the easier half to lose.
 * Encryption hides the reading; it does not hide that there was one. A lane 0
 * stream whose frames grow when the kettle goes on tells the relay operator
 * when the household wakes, cooks, leaves and comes home, through otherwise
 * perfect cryptography.
 *
 * So the assertion is not "roughly constant". It is that a still house and a
 * house where every reading moves every second produce byte-identical traffic
 * shapes, and that the relay passes both through unaltered.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { RelayServer } from '../relay/src/server.ts'
import { rendezvousHandle, currentEpoch } from '$lib/carrier/rendezvous'
import { decodeFrame } from '$lib/protocol/frame'
import { sealedPair, TestPeer, waitFor } from './support/relay-harness.ts'

/** A handle is a room and a room holds one uplink, so no two runs share one. */
function secretFor(n: number): Uint8Array {
  return new Uint8Array(32).fill(n)
}

const NOON = Date.UTC(2026, 6, 15, 12, 0, 0)
const TICKS = 60

interface Shape {
  lengths: number[]
  forwarded: number[]
  /** Message types before the seal, so the two runs can be shown to differ. */
  types: string[]
}

describe('lane 0 keeps its shape whatever the house does', () => {
  let relay: RelayServer

  beforeAll(async () => {
    relay = await RelayServer.start({ heartbeatMs: 1000 })
  })

  afterAll(async () => {
    await relay.stop()
  })

  /** One minute of telemetry, with the clock moved by `stepMs` per tick. */
  async function run(stepMs: number, secret: Uint8Array): Promise<Shape> {
    let clock = NOON
    const pair = await sealedPair(relay.url, secret, { now: () => clock })

    // Attached after the snapshot, so only the 1 Hz stream is measured. Bulk
    // leaks that a transfer is happening, which is unavoidable and harmless.
    const forwarded: number[] = []
    pair.carrier.onFrame((bytes) => forwarded.push(bytes.length))

    // Read on the box side, before anything is sealed. Without this the test
    // could pass on two runs that were secretly the same run.
    const types: string[] = []
    pair.box.onFrame((frame) => types.push(decodeFrame(frame).envelope.t))

    const before = pair.boxPeer.sent.length
    for (let i = 0; i < TICKS; i++) {
      clock += stepMs
      pair.box.tick()
    }

    await waitFor(() => forwarded.length >= TICKS, `${TICKS} frames across the relay`)

    const lengths = pair.boxPeer.sent.slice(before).map((f) => f.length)
    pair.stop()
    return {
      lengths: lengths.slice(0, TICKS),
      forwarded: forwarded.slice(0, TICKS),
      types: types.slice(0, TICKS),
    }
  }

  it('sends the same number of frames of the same size, busy or still', async () => {
    // A pinned clock: every sample is identical and the box has nothing to
    // report, so it sends `tick`. Silence would itself be information.
    const still = await run(0, secretFor(3))
    // A minute per tick: solar, load, battery and state of charge all move,
    // so every frame is a full delta.
    const busy = await run(60_000, secretFor(4))

    // The two runs really are different houses: one with mostly nothing to
    // say, one whose every field moves every second and drags the source
    // table along with it. Without this the test could pass on two runs that
    // were secretly the same run.
    expect(still.types.filter((t) => t === 'tick').length).toBeGreaterThan(TICKS / 2)
    expect(new Set(busy.types)).toEqual(new Set(['delta']))

    expect(still.lengths).toHaveLength(TICKS)
    expect(busy.lengths).toHaveLength(TICKS)
    expect(new Set([...still.lengths, ...busy.lengths]).size).toBe(1)
    expect(still.lengths.length).toBe(busy.lengths.length)

    // And what came out the other side matches what went in.
    expect(still.forwarded).toEqual(still.lengths)
    expect(busy.forwarded).toEqual(busy.lengths)
  })

  it('forwards each frame byte for byte', async () => {
    const pair = await sealedPair(relay.url, secretFor(5))
    const received: Uint8Array[] = []
    pair.carrier.onFrame((bytes) => received.push(bytes))

    const before = pair.boxPeer.sent.length
    for (let i = 0; i < 5; i++) pair.box.tick()
    await waitFor(() => received.length >= 5, 'five frames')

    const sent = pair.boxPeer.sent.slice(before, before + 5)
    for (let i = 0; i < 5; i++) {
      expect([...received[i]!]).toEqual([...sent[i]!])
    }

    pair.stop()
  })
})

describe('the relay beats at its own rate', () => {
  it('emits the same heartbeat whether the room is busy or silent', async () => {
    const relay = await RelayServer.start({ heartbeatMs: 30 })
    const epoch = relay.epoch
    const handle = rendezvousHandle(secretFor(6), epoch)

    const uplink = new TestPeer(relay.url, epoch, handle, 'box')
    const stream = new TestPeer(relay.url, epoch, handle, 'app')
    await waitFor(() => uplink.linked && stream.linked, 'the room')

    const quietStart = relay.inspect().heartbeats
    await new Promise((r) => setTimeout(r, 300))
    const quiet = relay.inspect().heartbeats - quietStart

    const busyStart = relay.inspect().heartbeats
    const flood = setInterval(() => uplink.send(new Uint8Array(512)), 5)
    await new Promise((r) => setTimeout(r, 300))
    clearInterval(flood)
    const busy = relay.inspect().heartbeats - busyStart

    // The relay's own emissions are on a timer that no message path touches,
    // so a listener cannot tell a busy room from an empty one by watching it.
    expect(quiet).toBeGreaterThan(4)
    expect(Math.abs(busy - quiet)).toBeLessThanOrEqual(2)

    uplink.close()
    stream.close()
    await relay.stop()
  })
})
