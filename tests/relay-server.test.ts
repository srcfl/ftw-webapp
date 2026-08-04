// @vitest-environment node

/* The relay's routing and its refusals.
 *
 * Every case here is a rule the relay enforces without understanding anything
 * it is carrying: who may join, who reaches whom, and what happens when a peer
 * does something the routing path is not allowed to interpret.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { RelayServer, parseJoin } from '../relay/src/server.ts'
import { CLOSE_BAD_JOIN, CLOSE_EPOCH, CLOSE_BUSY } from '../relay/src/protocol.ts'
import { rendezvousHandle } from '$lib/carrier/rendezvous'
import { TestPeer, waitFor } from './support/relay-harness.ts'

const SECRET = new Uint8Array(32).fill(5)
const OTHER = new Uint8Array(32).fill(6)

describe('parseJoin', () => {
  it('accepts exactly one shape', () => {
    const handle = 'a'.repeat(32)
    expect(parseJoin(`/r/12/${handle}/app`)).toEqual({ epoch: 12, handle, role: 'app' })
    expect(parseJoin(`/r/12/${handle}/box?x=1`)).toEqual({ epoch: 12, handle, role: 'box' })
  })

  it('refuses everything else', () => {
    const handle = 'a'.repeat(32)
    expect(parseJoin('/')).toBeNull()
    expect(parseJoin(`/r/12/${handle}`)).toBeNull()
    expect(parseJoin(`/x/12/${handle}/app`)).toBeNull()
    expect(parseJoin(`/r/-1/${handle}/app`)).toBeNull()
    expect(parseJoin(`/r/12/${handle}/installer`)).toBeNull()
    expect(parseJoin('/r/12/short/app')).toBeNull()
    expect(parseJoin(`/r/12/${'A'.repeat(32)}/app`)).toBeNull()
  })
})

describe('joining a room', () => {
  let relay: RelayServer

  beforeAll(async () => {
    relay = await RelayServer.start({ heartbeatMs: 1000, maxStreamsPerHandle: 2 })
  })

  afterAll(async () => {
    await relay.stop()
  })

  it('corrects a peer that guessed the epoch wrong', async () => {
    const peer = new TestPeer(relay.url, 0, rendezvousHandle(SECRET, 0), 'app')
    await waitFor(() => peer.closes.length > 0, 'a close')

    expect(peer.closes[0]!.code).toBe(CLOSE_EPOCH)
    // The right number comes back, so the peer can derive this epoch's handle
    // and return immediately. A box whose clock reads 1970 recovers this way.
    expect(Number(peer.closes[0]!.reason)).toBe(relay.epoch)
  })

  it('refuses a malformed join', async () => {
    const ws = new WebSocket(`${relay.url}/nonsense`)
    const closed = await new Promise<number>((resolve) => {
      ws.onclose = (ev) => resolve(ev.code)
      ws.onerror = () => {}
    })
    expect(closed).toBe(CLOSE_BAD_JOIN)
  })

  it('keeps the incumbent uplink when a second box arrives', async () => {
    const handle = rendezvousHandle(SECRET, relay.epoch)
    const first = new TestPeer(relay.url, relay.epoch, handle, 'box')
    await waitFor(() => first.open, 'the first uplink')

    const second = new TestPeer(relay.url, relay.epoch, handle, 'box')
    await waitFor(() => second.closes.length > 0, 'the second uplink to be refused')

    // Evicting the incumbent would make a second connection a way to cut a
    // household off. A dead socket is reaped by the heartbeat instead.
    expect(second.closes[0]!.code).toBe(CLOSE_BUSY)
    expect(first.open).toBe(true)
    first.close()
  })

  it('caps the number of browser streams', async () => {
    const handle = rendezvousHandle(OTHER, relay.epoch)
    const a = new TestPeer(relay.url, relay.epoch, handle, 'app')
    const b = new TestPeer(relay.url, relay.epoch, handle, 'app')
    await waitFor(() => a.open && b.open, 'two streams')

    const c = new TestPeer(relay.url, relay.epoch, handle, 'app')
    await waitFor(() => c.closes.length > 0, 'the third to be refused')
    expect(c.closes[0]!.code).toBe(CLOSE_BUSY)

    a.close()
    b.close()
  })
})

describe('routing', () => {
  let relay: RelayServer

  beforeAll(async () => {
    relay = await RelayServer.start({ heartbeatMs: 1000 })
  })

  afterAll(async () => {
    await relay.stop()
  })

  it('joins the uplink to every stream, and streams to nobody but the uplink', async () => {
    const handle = rendezvousHandle(SECRET, relay.epoch)
    const box = new TestPeer(relay.url, relay.epoch, handle, 'box')
    const one = new TestPeer(relay.url, relay.epoch, handle, 'app')
    const two = new TestPeer(relay.url, relay.epoch, handle, 'app')
    await waitFor(() => box.linked && one.linked && two.linked, 'the room')

    box.send(new Uint8Array([1, 2, 3]))
    await waitFor(() => one.received.length > 0 && two.received.length > 0, 'the broadcast')

    one.send(new Uint8Array([4, 5, 6]))
    await waitFor(() => box.received.length > 0, 'the uplink to hear it')

    // The uplink cannot be told which stream a ciphertext belongs to without
    // reading it, so it hears from all of them and answers all of them. What
    // must never happen is one household member's stream reaching another's.
    await new Promise((r) => setTimeout(r, 60))
    expect(two.received).toHaveLength(1)
    expect([...two.received[0]!]).toEqual([1, 2, 3])

    box.close()
    one.close()
    two.close()
  })

  it('says when the other side arrives and when it leaves', async () => {
    const handle = rendezvousHandle(OTHER, relay.epoch)
    const app = new TestPeer(relay.url, relay.epoch, handle, 'app')
    await waitFor(() => app.open, 'the stream')

    // Alone in the room, so nothing is said: an empty room is not an error,
    // it is a box that is not switched on yet.
    await new Promise((r) => setTimeout(r, 60))
    expect(app.control).toEqual([])

    const box = new TestPeer(relay.url, relay.epoch, handle, 'box')
    await waitFor(() => app.linked, 'ready')

    box.close()
    await waitFor(() => app.control.at(-1) === 'gone', 'gone')

    // The socket survives the box going away, so an hour offline costs one
    // connection rather than sixty.
    expect(app.open).toBe(true)
    app.close()
  })

  it('closes a peer that sends text on a binary channel', async () => {
    const handle = rendezvousHandle(SECRET, relay.epoch)
    const app = new TestPeer(relay.url, relay.epoch, handle, 'app')
    await waitFor(() => app.open, 'the stream')

    app.sendText('hello relay')
    await waitFor(() => app.closes.length > 0, 'the close')
    expect(app.closes[0]!.code).toBe(CLOSE_BAD_JOIN)
  })
})

describe('rate limiting', () => {
  it('turns away a flood without keeping a record of who flooded', async () => {
    const relay = await RelayServer.start({ heartbeatMs: 1000 })

    let refused = 0
    for (let i = 0; i < 40; i++) {
      // A fresh handle each time, so the only thing that can refuse these is
      // the attempt counter rather than a full room.
      const peer = new TestPeer(relay.url, relay.epoch, rendezvousHandle(SECRET, i), 'app')
      await waitFor(() => peer.open || peer.closes.length > 0, 'a verdict')
      if (peer.closes[0]?.code === CLOSE_BUSY) refused += 1
      peer.close()
    }

    expect(refused).toBeGreaterThan(0)

    // Nothing about the caller survives. The counters are indexed by a keyed
    // hash whose key is thrown away with them each window.
    expect(JSON.stringify(relay.inspect())).not.toContain('127.0.0.1')

    await relay.stop()
  })
})
