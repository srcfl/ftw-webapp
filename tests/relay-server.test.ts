// @vitest-environment node

/* The relay's routing and its refusals.
 *
 * Every case here is a rule the relay enforces without understanding anything
 * it is carrying: who may join, who reaches whom, and what happens when a peer
 * does something the routing path is not allowed to interpret.
 */

import net from 'node:net'
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

/* Four faults an adversarial audit found, each reproduced against the real
 * server before it was fixed. They share a shape: the relay must survive
 * anything an unauthenticated client can do to it, because every client is
 * unauthenticated — that is the design.
 */
describe('surviving hostile and clumsy clients', () => {
  it('keeps running when a socket errors on a rejection path', async () => {
    // socket.on('error') used to be attached only after six early returns, so
    // a socket that failed while being rejected raised an unhandled 'error' —
    // which Node turns into an uncaught exception, killing the process. No
    // credential and no valid handle required.
    //
    // Reproduced the way it happens: complete the HTTP upgrade, then send
    // bytes that are not a valid WebSocket frame. ws emits 'error' on the
    // server socket, and with no listener attached the process dies.
    const relay = await RelayServer.start({ heartbeatMs: 1000 })
    let died: unknown = null
    const onUncaught = (err: unknown) => (died = err)
    process.on('uncaughtException', onUncaught)

    try {
      const { port } = new URL(relay.url)
      for (let i = 0; i < 4; i++) {
        await new Promise<void>((resolve) => {
          const sock = net.connect(Number(port), '127.0.0.1', () => {
            // A join that will be rejected: epoch 0 is never current.
            sock.write(
              `GET /r/0/${'a'.repeat(32)}/app HTTP/1.1\r\n` +
                `Host: 127.0.0.1:${port}\r\n` +
                'Upgrade: websocket\r\n' +
                'Connection: Upgrade\r\n' +
                'Sec-WebSocket-Key: AAAAAAAAAAAAAAAAAAAAAA==\r\n' +
                'Sec-WebSocket-Version: 13\r\n\r\n'
            )
            // Then garbage, once the upgrade has been answered.
            setTimeout(() => {
              sock.write(Buffer.from([0xff, 0xff, 0xff, 0xff, 0xff, 0xff]))
              sock.destroy()
              resolve()
            }, 25)
          })
          sock.on('error', () => resolve())
        })
      }
      await new Promise((r) => setTimeout(r, 120))
      expect(died, `an uncaught error would have killed the relay: ${died}`).toBeNull()

      // Still serving.
      const peer = new TestPeer(relay.url, relay.epoch, rendezvousHandle(SECRET, relay.epoch), 'box')
      await waitFor(() => peer.open, 'the relay still accepts joins')
      peer.close()
    } finally {
      process.off('uncaughtException', onUncaught)
      await relay.stop()
    }
  })

  it('caps how many sockets one address may hold open', async () => {
    // The attempt limiter bounds the rate; without this one client could
    // still hold maxSockets open and lock every household out.
    const relay = await RelayServer.start({ heartbeatMs: 1000, maxSocketsPerAddress: 3 })
    try {
      const peers: TestPeer[] = []
      for (let i = 0; i < 5; i++) {
        peers.push(
          new TestPeer(relay.url, relay.epoch, rendezvousHandle(new Uint8Array(32).fill(i), relay.epoch), 'box')
        )
      }
      await waitFor(() => peers.filter((p) => p.closes.length > 0).length >= 2, 'the surplus refused')

      expect(peers.filter((p) => p.open).length).toBe(3)
      for (const p of peers.filter((p) => p.closes.length > 0)) {
        expect(p.closes[0]!.code).toBe(CLOSE_BUSY)
      }
      for (const p of peers) p.close()
    } finally {
      await relay.stop()
    }
  })

  it('drops a peer that has stopped reading rather than buffering for it', async () => {
    // send() queued unconditionally, so a socket the kernel had stopped
    // draining grew the relay's heap without bound.
    const relay = await RelayServer.start({ heartbeatMs: 1000, maxBufferedBytes: 4096 })
    try {
      const handle = rendezvousHandle(SECRET, relay.epoch)
      const box = new TestPeer(relay.url, relay.epoch, handle, 'box')
      const app = new TestPeer(relay.url, relay.epoch, handle, 'app')
      await waitFor(() => box.linked && app.linked, 'both peers in the room')

      // The app never reads; the box floods. The relay must shed it.
      for (let i = 0; i < 500; i++) box.send(new Uint8Array(4096))
      await waitFor(() => app.closes.length > 0 || box.closes.length > 0, 'a peer shed')

      const shed = app.closes[0] ?? box.closes[0]!
      expect(shed.code).toBe(CLOSE_BUSY)
      box.close()
      app.close()
    } finally {
      await relay.stop()
    }
  })
})
