// @vitest-environment node

/* The watch exchange, held to docs/watch-exchange.md.
 *
 * Routing, shape, limits and the epoch: tests 2 to 5 in that document's list.
 * Test 1, blindness, sits in tests/relay-blindness.test.ts beside the
 * stream's. Every case here is something the relay does without reading what
 * it carries: it reads the 16-byte id it wrote, and lengths.
 */

import net from 'node:net'
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { RelayServer, parseExchange, parseJoin, rotationOffsetMs } from '../relay/src/server.ts'
import { CLOSE_BAD_JOIN, CLOSE_BUSY, CLOSE_ROTATED, EXCHANGE_ID_BYTES } from '../relay/src/protocol.ts'
import { EXCHANGE } from '../relay/src/limits.ts'
import { EPOCH_MS } from '../relay/src/epoch.ts'
import { rendezvousHandle } from '$lib/carrier/rendezvous'
import {
  OP_BATTERY_HOLD,
  OP_LOADPOINT_BOOST,
  OP_LOADPOINT_HOLD,
  OP_LOADPOINT_SOC_SET,
  OP_LOADPOINT_SURPLUS_ONLY_SET,
  OP_PLANNER_PREFS_SET,
  OP_SET_MODE,
} from '$lib/protocol/messages'
import { TestPeer, waitFor } from './support/relay-harness.ts'
import {
  CHARGER,
  ExchangeBox,
  TRANSPORT_BYTES,
  Watch,
  command,
  concat,
  postExchange,
  type Outcome,
} from './support/exchange-harness.ts'

/** A handle is a room, so no two cases share a secret. */
function secretFor(n: number): Uint8Array {
  return new Uint8Array(32).fill(n)
}

function filled(length: number, value: number): Uint8Array {
  return new Uint8Array(length).fill(value)
}

/**
 * A box's exchange socket that answers each message with `answer(body)`
 * behind the relay's id. No Noise: these cases are about where bytes go.
 */
function rawBox(
  url: string,
  epoch: number,
  handle: string,
  answer: ((body: Uint8Array) => Uint8Array) | null = (body) => body.slice().reverse()
): TestPeer {
  const peer = new TestPeer(url, epoch, handle, 'exchange')
  if (answer) {
    peer.onBinary((message) => {
      peer.send(concat([message.subarray(0, EXCHANGE_ID_BYTES), answer(message.subarray(EXCHANGE_ID_BYTES))]))
    })
  }
  return peer
}

const ARGS: Record<string, Record<string, unknown>> = {
  [OP_SET_MODE]: { mode: 'planner_arbitrage' },
  [OP_PLANNER_PREFS_SET]: { style: 'balanced' },
  [OP_BATTERY_HOLD]: { w: -3000 },
  [OP_LOADPOINT_HOLD]: { lp: CHARGER.src, amps: 16 },
  [OP_LOADPOINT_BOOST]: { lp: CHARGER.src },
  [OP_LOADPOINT_SOC_SET]: { lp: CHARGER.src, soc: 640 },
  [OP_LOADPOINT_SURPLUS_ONLY_SET]: { lp: CHARGER.src, on: true },
}

describe('the exchange paths', () => {
  it('accept exactly one shape each', () => {
    const handle = 'a'.repeat(32)
    expect(parseJoin(`/r/12/${handle}/exchange`)).toEqual({ epoch: 12, handle, role: 'exchange' })
    expect(parseExchange(`/x/12/${handle}`)).toEqual({ epoch: 12, handle })

    for (const path of [
      '/x/',
      `/x/12`,
      `/x/12/${handle}/box`,
      `/x/-1/${handle}`,
      `/x/1.5/${handle}`,
      '/x/12/short',
      `/x/12/${'A'.repeat(32)}`,
      `/r/12/${handle}`,
      `/x/12/${handle}?id=1`,
    ]) {
      expect(parseExchange(path), path).toBeNull()
    }
  })
})

describe('routing', () => {
  let relay: RelayServer

  beforeAll(async () => {
    relay = await RelayServer.start({ heartbeatMs: 1000, exchangeAttemptLimit: 1000 })
  })

  afterAll(async () => {
    await relay.stop()
  })

  it('carries a request to the box and its answer back, byte for byte', async () => {
    const handle = rendezvousHandle(secretFor(1), relay.epoch)
    const answer = filled(1072, 0xab)
    const box = rawBox(relay.url, relay.epoch, handle, () => answer)
    await waitFor(() => box.open, 'the exchange socket')

    const request = filled(TRANSPORT_BYTES, 0x5c)
    const res = await postExchange(relay.url, relay.epoch, handle, request)

    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toBe('application/octet-stream')
    expect([...res.body]).toEqual([...answer])

    // What the box got: a fresh id of the relay's own, then the body as sent.
    expect(box.received).toHaveLength(1)
    expect(box.received[0]!.length).toBe(EXCHANGE_ID_BYTES + TRANSPORT_BYTES)
    expect([...box.received[0]!.subarray(EXCHANGE_ID_BYTES)]).toEqual([...request])
    box.close()
  })

  it('sends each answer to its own request only', async () => {
    const handle = rendezvousHandle(secretFor(2), relay.epoch)
    const box = new TestPeer(relay.url, relay.epoch, handle, 'exchange')
    await waitFor(() => box.open, 'the exchange socket')

    const first = postExchange(relay.url, relay.epoch, handle, filled(TRANSPORT_BYTES, 1))
    const second = postExchange(relay.url, relay.epoch, handle, filled(TRANSPORT_BYTES, 2))
    await waitFor(() => box.received.length === 2, 'both requests at the box')

    // Answered in the other order, each with the value its request carried.
    for (const message of [...box.received].reverse()) {
      const id = message.subarray(0, EXCHANGE_ID_BYTES)
      box.send(concat([id, filled(64, 100 + message[EXCHANGE_ID_BYTES]!)]))
    }

    const [a, b] = await Promise.all([first, second])
    expect(new Set(a.body)).toEqual(new Set([101]))
    expect(new Set(b.body)).toEqual(new Set([102]))

    // Two requests, two ids, never the same one.
    const ids = box.received.map((m) => Buffer.from(m.subarray(0, EXCHANGE_ID_BYTES)).toString('hex'))
    expect(new Set(ids).size).toBe(2)
    box.close()
  })

  it('drops an answer whose id it is not waiting for', async () => {
    const mine = rendezvousHandle(secretFor(3), relay.epoch)
    const theirs = rendezvousHandle(secretFor(4), relay.epoch)
    const box = new TestPeer(relay.url, relay.epoch, mine, 'exchange')
    const uplink = new TestPeer(relay.url, relay.epoch, mine, 'box')
    const stream = new TestPeer(relay.url, relay.epoch, mine, 'app')
    const other = new TestPeer(relay.url, relay.epoch, theirs, 'exchange')
    await waitFor(() => box.open && other.open && uplink.linked && stream.linked, 'two rooms')

    const pending = postExchange(relay.url, relay.epoch, mine, filled(TRANSPORT_BYTES, 9))
    await waitFor(() => box.received.length === 1, 'the request at the box')
    const id = box.received[0]!.subarray(0, EXCHANGE_ID_BYTES)

    // Another room's box answers with this room's id, and this box answers
    // with an id nobody drew. Neither reaches the watch or anyone else.
    other.send(concat([id, filled(64, 0xee)]))
    box.send(concat([filled(EXCHANGE_ID_BYTES, 0), filled(64, 0xdd)]))
    await new Promise((r) => setTimeout(r, 60))
    expect(relay.inspect().exchanges).toBe(1)

    box.send(concat([id, filled(64, 0x11)]))
    const res = await pending
    expect(new Set(res.body)).toEqual(new Set([0x11]))

    // The same id again, now settled, goes nowhere too.
    box.send(concat([id, filled(64, 0x22)]))
    await new Promise((r) => setTimeout(r, 60))

    expect(uplink.received).toEqual([])
    expect(stream.received).toEqual([])
    expect(box.open && other.open).toBe(true)
    for (const peer of [box, uplink, stream, other]) peer.close()
  })

  it('keeps exchanges and the room’s streams apart', async () => {
    const handle = rendezvousHandle(secretFor(5), relay.epoch)
    const uplink = new TestPeer(relay.url, relay.epoch, handle, 'box')
    const streams = [1, 2, 3, 4].map(() => new TestPeer(relay.url, relay.epoch, handle, 'app'))
    const box = rawBox(relay.url, relay.epoch, handle)
    await waitFor(() => uplink.linked && streams.every((s) => s.linked) && box.open, 'a full room')

    // Four streams and the exchange socket: the exchange took no stream's
    // place, so a watch cannot push a phone out, and a fifth phone is still
    // refused for the streams' own reason.
    expect(relay.inspect().rooms.find((r) => r.handle === handle)).toMatchObject({
      hasUplink: true,
      streams: 4,
      hasExchange: true,
    })
    const fifth = new TestPeer(relay.url, relay.epoch, handle, 'app')
    await waitFor(() => fifth.closes.length > 0, 'the fifth stream refused')
    expect(fifth.closes[0]!.code).toBe(CLOSE_BUSY)

    const res = await postExchange(relay.url, relay.epoch, handle, filled(TRANSPORT_BYTES, 7))
    expect(res.status).toBe(200)

    uplink.send(filled(512, 1))
    streams[0]!.send(filled(512, 2))
    await waitFor(
      () => streams.every((s) => s.received.length === 1) && uplink.received.length === 1,
      'room traffic'
    )
    await new Promise((r) => setTimeout(r, 60))

    // No stream saw the exchange, and the exchange socket saw no stream
    // frame and no control word.
    for (const s of streams) expect([...s.received[0]!]).toEqual([...filled(512, 1)])
    expect([...uplink.received[0]!]).toEqual([...filled(512, 2)])
    expect(box.received).toHaveLength(1)
    expect(box.control).toEqual([])

    for (const peer of [uplink, ...streams, box]) peer.close()
  })

  it('keeps the first exchange socket when a second arrives', async () => {
    const handle = rendezvousHandle(secretFor(6), relay.epoch)
    const first = rawBox(relay.url, relay.epoch, handle)
    await waitFor(() => first.open, 'the first')
    const second = rawBox(relay.url, relay.epoch, handle)
    await waitFor(() => second.closes.length > 0, 'the second refused')

    expect(second.closes[0]!.code).toBe(CLOSE_BUSY)
    expect(first.open).toBe(true)
    first.close()
  })

  it('says 404 with no box and 501 for a box without the exchange socket', async () => {
    const empty = rendezvousHandle(secretFor(7), relay.epoch)
    expect((await postExchange(relay.url, relay.epoch, empty, filled(TRANSPORT_BYTES, 0))).status).toBe(404)

    // Phones waiting for a box that is off: still no box.
    const waiting = new TestPeer(relay.url, relay.epoch, empty, 'app')
    await waitFor(() => waiting.open, 'the stream')
    expect((await postExchange(relay.url, relay.epoch, empty, filled(TRANSPORT_BYTES, 0))).status).toBe(404)

    const old = rendezvousHandle(secretFor(8), relay.epoch)
    const uplink = new TestPeer(relay.url, relay.epoch, old, 'box')
    await waitFor(() => uplink.open, 'an old box')
    expect((await postExchange(relay.url, relay.epoch, old, filled(TRANSPORT_BYTES, 0))).status).toBe(501)

    waiting.close()
    uplink.close()
  })

  it('answers 504 at once when the exchange socket goes', async () => {
    const handle = rendezvousHandle(secretFor(9), relay.epoch)
    const box = new TestPeer(relay.url, relay.epoch, handle, 'exchange')
    await waitFor(() => box.open, 'the exchange socket')

    const started = Date.now()
    const pending = postExchange(relay.url, relay.epoch, handle, filled(TRANSPORT_BYTES, 0))
    await waitFor(() => box.received.length === 1, 'the request at the box')
    box.close()

    expect((await pending).status).toBe(504)
    expect(Date.now() - started).toBeLessThan(EXCHANGE.timeoutMs / 2)
    expect(relay.inspect().exchanges).toBe(0)
  })

  it('closes an exchange socket that sends text or an answer of the wrong size', async () => {
    const text = new TestPeer(relay.url, relay.epoch, rendezvousHandle(secretFor(10), relay.epoch), 'exchange')
    const short = new TestPeer(relay.url, relay.epoch, rendezvousHandle(secretFor(11), relay.epoch), 'exchange')
    const long = new TestPeer(relay.url, relay.epoch, rendezvousHandle(secretFor(12), relay.epoch), 'exchange')
    await waitFor(() => text.open && short.open && long.open, 'three exchange sockets')

    // The uplink's dead man word is the uplink's alone.
    text.sendText(`deadman ${'a'.repeat(32)}`)
    short.send(filled(EXCHANGE_ID_BYTES, 1))
    long.send(filled(EXCHANGE_ID_BYTES + EXCHANGE.maxReplyBytes + 1, 1))
    await waitFor(() => [text, short, long].every((p) => p.closes.length > 0), 'all three closed')

    for (const peer of [text, short, long]) expect(peer.closes[0]!.code).toBe(CLOSE_BAD_JOIN)
    expect(relay.inspect().deadman.claimed).toBe(0)
  })

  it('takes only a POST of octet-stream, and never says CORS', async () => {
    const handle = rendezvousHandle(secretFor(13), relay.epoch)
    const box = rawBox(relay.url, relay.epoch, handle)
    await waitFor(() => box.open, 'the exchange socket')
    const url = `${relay.url.replace(/^ws/, 'http')}/x/${relay.epoch}/${handle}`

    const get = await fetch(url)
    expect(get.status).toBe(405)

    // A web page's preflight. No CORS header comes back, so a browser never
    // lets a page send the real request, let alone read its answer.
    const preflight = await fetch(url, {
      method: 'OPTIONS',
      headers: { origin: 'https://example.com', 'access-control-request-method': 'POST' },
    })
    expect(preflight.status).toBe(405)

    // The one type a page may POST without a preflight is refused too.
    const text = await postExchange(relay.url, relay.epoch, handle, filled(TRANSPORT_BYTES, 0), {
      'content-type': 'text/plain',
    })
    expect(text.status).toBe(400)

    const ok = await postExchange(relay.url, relay.epoch, handle, filled(TRANSPORT_BYTES, 0))
    expect(ok.status).toBe(200)

    for (const res of [get.headers, preflight.headers, text.headers, ok.headers]) {
      expect([...res.keys()].filter((k) => k.startsWith('access-control-'))).toEqual([])
    }
    expect(box.received).toHaveLength(1)
    box.close()
  })
})

describe('shape', () => {
  let relay: RelayServer

  beforeAll(async () => {
    relay = await RelayServer.start({ heartbeatMs: 1000, exchangeAttemptLimit: 1000 })
  })

  afterAll(async () => {
    await relay.stop()
  })

  it('gives a read and every command the same lengths, whatever the outcome', async () => {
    const outcomes: Outcome[] = ['applied', 'rejected', 'unconfirmed', 'tick']
    const opens = { up: new Set<number>(), down: new Set<number>() }
    const asks = { up: new Set<number>(), down: new Set<number>() }
    const said = new Set<string>()

    async function room(n: number): Promise<{ box: ExchangeBox; watch: Watch }> {
      const handle = rendezvousHandle(secretFor(40 + n), relay.epoch)
      const box = new ExchangeBox(relay.url, relay.epoch, handle)
      await waitFor(() => box.peer.open, 'the exchange socket')
      const watch = new Watch(relay.url, box.keys.publicKey, relay.epoch, handle)
      const opened = await watch.open()
      expect(opened.status).toBe(200)
      expect(opened.helloOk?.t).toBe('hello_ok')
      opens.up.add(watch.wire.at(-2)!.length)
      opens.down.add(opened.body.length)
      return { box, watch }
    }

    let n = 0
    for (const [i, op] of Object.keys(ARGS).entries()) {
      // One room and one session per op: four exchanges, as a session allows.
      const { box, watch } = await room(i)
      for (const outcome of outcomes) {
        box.outcome = outcome
        const res = await watch.ask(command(op, ARGS[op]!, n++))
        expect(res.status, `${op} ${outcome}`).toBe(200)
        asks.up.add(watch.wire.at(-2)!.length)
        asks.down.add(res.body.length)
        said.add(res.envelopes.map((e) => e.t).join(' '))
      }
      box.peer.close()
    }

    const { box, watch } = await room(Object.keys(ARGS).length)
    const read = await watch.ask({ t: 'now' })
    expect(read.status).toBe(200)
    asks.up.add(watch.wire.at(-2)!.length)
    asks.down.add(read.body.length)
    said.add(read.envelopes.map((e) => e.t).join(' '))

    // The runs really did differ inside the seal.
    expect(said).toEqual(
      new Set(['cmd.ack cmd.result', 'cmd.result tick', 'cmd.ack tick', 'now tick'])
    )

    // And outside it they did not.
    expect(opens).toEqual({ up: new Set([608]), down: new Set([1072]) })
    expect(asks).toEqual({ up: new Set([536]), down: new Set([1072]) })

    // The box saw each request behind the relay's id, and nothing else.
    expect(new Set(box.seen.map((m) => m.length))).toEqual(
      new Set([EXCHANGE_ID_BYTES + 608, EXCHANGE_ID_BYTES + 536])
    )
    box.peer.close()
  })

  it('refuses any other size with 400, before the box hears of it', async () => {
    const handle = rendezvousHandle(secretFor(60), relay.epoch)
    const box = rawBox(relay.url, relay.epoch, handle)
    await waitFor(() => box.open, 'the exchange socket')

    for (const size of [0, 1, 16, 535, 537, 607, 609, 1072, 4096, 65_536]) {
      const res = await postExchange(relay.url, relay.epoch, handle, filled(size, 3))
      expect(res.status, `${size} bytes`).toBe(400)
    }
    expect(box.received).toEqual([])
    box.close()
  })
})

describe('limits', () => {
  it('lets one address make 30 requests a minute', async () => {
    const relay = await RelayServer.start({ heartbeatMs: 1000 })
    try {
      const handle = rendezvousHandle(secretFor(70), relay.epoch)
      const statuses: number[] = []
      for (let i = 0; i <= EXCHANGE.attemptsPerMinute; i++) {
        statuses.push((await postExchange(relay.url, relay.epoch, handle, filled(TRANSPORT_BYTES, 0))).status)
      }
      expect(EXCHANGE.attemptsPerMinute).toBe(30)
      expect(statuses.slice(0, 30)).toEqual(new Array(30).fill(404))
      expect(statuses[30]).toBe(429)

      // The counter is a keyed hash, so nothing names the address.
      expect(JSON.stringify(relay.inspect())).not.toContain('127.0.0.1')
    } finally {
      await relay.stop()
    }
  })

  it('holds two open exchanges per room, and refuses a third', async () => {
    const relay = await RelayServer.start({ heartbeatMs: 1000, exchangeAttemptLimit: 1000 })
    try {
      const handle = rendezvousHandle(secretFor(71), relay.epoch)
      const box = new TestPeer(relay.url, relay.epoch, handle, 'exchange')
      await waitFor(() => box.open, 'the exchange socket')

      const held = [1, 2].map(() => postExchange(relay.url, relay.epoch, handle, filled(TRANSPORT_BYTES, 0)))
      await waitFor(() => box.received.length === 2, 'two requests at the box')

      const third = await postExchange(relay.url, relay.epoch, handle, filled(TRANSPORT_BYTES, 0))
      expect(EXCHANGE.openPerRoom).toBe(2)
      expect(third.status).toBe(429)
      expect(box.received).toHaveLength(2)

      box.close()
      expect((await Promise.all(held)).map((r) => r.status)).toEqual([504, 504])
    } finally {
      await relay.stop()
    }
  })

  it('lets a room have 30 exchanges a minute', async () => {
    // A still clock, so the allowance cannot refill while the test runs.
    const clock = Date.now()
    const relay = await RelayServer.start({
      heartbeatMs: 1000,
      exchangeAttemptLimit: 1000,
      now: () => clock,
    })
    try {
      const handle = rendezvousHandle(secretFor(72), relay.epoch)
      const box = rawBox(relay.url, relay.epoch, handle)
      await waitFor(() => box.open, 'the exchange socket')

      const statuses: number[] = []
      for (let i = 0; i <= EXCHANGE.perRoomPerMinute; i++) {
        statuses.push((await postExchange(relay.url, relay.epoch, handle, filled(TRANSPORT_BYTES, 0))).status)
      }
      expect(EXCHANGE.perRoomPerMinute).toBe(30)
      expect(statuses.slice(0, 30)).toEqual(new Array(30).fill(200))
      expect(statuses[30]).toBe(429)
      box.close()
    } finally {
      await relay.stop()
    }
  })

  it('caps open exchanges across the process', async () => {
    const relay = await RelayServer.start({
      heartbeatMs: 1000,
      exchangeAttemptLimit: 1000,
      maxOpenExchanges: 2,
    })
    try {
      const handles = [73, 74, 75].map((n) => rendezvousHandle(secretFor(n), relay.epoch))
      const boxes = handles.map((h) => new TestPeer(relay.url, relay.epoch, h, 'exchange'))
      await waitFor(() => boxes.every((b) => b.open), 'three exchange sockets')

      const held = handles
        .slice(0, 2)
        .map((h) => postExchange(relay.url, relay.epoch, h, filled(TRANSPORT_BYTES, 0)))
      await waitFor(() => relay.inspect().exchanges === 2, 'two open exchanges')

      const third = await postExchange(relay.url, relay.epoch, handles[2]!, filled(TRANSPORT_BYTES, 0))
      expect(EXCHANGE.openPerProcess).toBe(1024)
      expect(third.status).toBe(429)
      expect(boxes[2]!.received).toEqual([])

      for (const b of boxes) b.close()
      expect((await Promise.all(held)).map((r) => r.status)).toEqual([504, 504])
    } finally {
      await relay.stop()
    }
  })

  it('waits for the box no longer than the timeout, and forgets the request', async () => {
    const relay = await RelayServer.start({
      heartbeatMs: 1000,
      exchangeAttemptLimit: 1000,
      exchangeTimeoutMs: 200,
    })
    try {
      const handle = rendezvousHandle(secretFor(76), relay.epoch)
      const box = new TestPeer(relay.url, relay.epoch, handle, 'exchange')
      await waitFor(() => box.open, 'the exchange socket')

      const started = Date.now()
      const res = await postExchange(relay.url, relay.epoch, handle, filled(TRANSPORT_BYTES, 0))
      expect(EXCHANGE.timeoutMs).toBe(10_000)
      expect(res.status).toBe(504)
      expect(Date.now() - started).toBeGreaterThanOrEqual(190)
      expect(relay.inspect().exchanges).toBe(0)

      // The answer that comes too late finds nobody waiting, and the socket
      // carries on.
      box.send(concat([box.received[0]!.subarray(0, EXCHANGE_ID_BYTES), filled(64, 1)]))
      await new Promise((r) => setTimeout(r, 60))
      expect(box.open).toBe(true)
      expect(relay.inspect().exchanges).toBe(0)
      box.close()
    } finally {
      await relay.stop()
    }
  })
})

describe('a watch that hangs up', () => {
  it('is forgotten at once, and its late answer goes nowhere', async () => {
    const relay = await RelayServer.start({ heartbeatMs: 1000 })
    try {
      const handle = rendezvousHandle(secretFor(77), relay.epoch)
      const box = new TestPeer(relay.url, relay.epoch, handle, 'exchange')
      await waitFor(() => box.open, 'the exchange socket')

      // A raw request, so the test can hang up without a client library
      // retrying or waiting on its behalf.
      const { port } = new URL(relay.url)
      const sock = net.connect(Number(port), '127.0.0.1', () => {
        sock.write(
          `POST /x/${relay.epoch}/${handle} HTTP/1.1\r\nHost: relay\r\n` +
            `Content-Type: application/octet-stream\r\nContent-Length: ${TRANSPORT_BYTES}\r\n\r\n`
        )
        sock.write(Buffer.alloc(TRANSPORT_BYTES))
      })
      sock.on('error', () => {})
      await waitFor(() => box.received.length === 1, 'the request at the box')
      expect(relay.inspect().exchanges).toBe(1)

      sock.destroy()
      await waitFor(() => relay.inspect().exchanges === 0, 'the exchange to be forgotten')

      box.send(concat([box.received[0]!.subarray(0, EXCHANGE_ID_BYTES), filled(64, 1)]))
      await new Promise((r) => setTimeout(r, 60))
      expect(box.open).toBe(true)
      box.close()
    } finally {
      await relay.stop()
    }
  })
})

describe('the epoch', () => {
  it('answers a wrong one with 409 and the right one', async () => {
    const relay = await RelayServer.start({ heartbeatMs: 1000 })
    try {
      const res = await postExchange(relay.url, 0, rendezvousHandle(secretFor(80), 0), filled(TRANSPORT_BYTES, 0))
      expect(res.status).toBe(409)
      expect(Number(new TextDecoder().decode(res.body))).toBe(relay.epoch)
    } finally {
      await relay.stop()
    }
  })

  it('takes the previous epoch during the spread, closes the socket with its room, then refuses it', async () => {
    const spreadMs = 60_000
    let clock = EPOCH_MS * 480_000 + 60_000
    const relay = await RelayServer.start({
      heartbeatMs: 50,
      now: () => clock,
      rotateSpreadMs: spreadMs,
      exchangeAttemptLimit: 1000,
    })
    try {
      const epoch = relay.epoch
      // A room whose turn comes after the window opens, so the window can be
      // seen while it is still there.
      let n = 81
      while (rotationOffsetMs(rendezvousHandle(secretFor(n), epoch), spreadMs) === 0) n++
      const handle = rendezvousHandle(secretFor(n), epoch)

      const uplink = new TestPeer(relay.url, epoch, handle, 'box')
      const box = rawBox(relay.url, epoch, handle)
      await waitFor(() => uplink.open && box.open, 'the box')

      const post = (e: number) => postExchange(relay.url, e, handle, filled(TRANSPORT_BYTES, 0))
      expect((await post(epoch)).status).toBe(200)
      // No rotation yet, so the epoch before is just wrong.
      expect((await post(epoch - 1)).status).toBe(409)

      clock = (epoch + 1) * EPOCH_MS + 1
      await waitFor(() => relay.epoch === epoch + 1, 'the epoch to turn')

      // The box has not moved yet. On the new epoch there is no box under this
      // handle; on the previous one there is, for the length of the spread.
      expect((await post(epoch + 1)).status).toBe(404)
      expect((await post(epoch)).status).toBe(200)
      expect((await post(epoch - 1)).status).toBe(409)

      clock += spreadMs
      await waitFor(() => box.closes.length > 0 && uplink.closes.length > 0, 'the room to rotate')
      expect(box.closes[0]).toEqual({ code: CLOSE_ROTATED, reason: String(epoch + 1) })
      expect(uplink.closes[0]!.code).toBe(CLOSE_ROTATED)

      const after = await post(epoch)
      expect(after.status).toBe(409)
      expect(Number(new TextDecoder().decode(after.body))).toBe(epoch + 1)
    } finally {
      await relay.stop()
    }
  })
})
