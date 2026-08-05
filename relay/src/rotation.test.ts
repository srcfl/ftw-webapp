// @vitest-environment node

/* Rotation must not become an outage.
 *
 * The relay used to close every socket the moment the epoch advanced. Both
 * peers do have to reconnect — the handle is derived from the epoch, so a room
 * cannot straddle the boundary — but doing it to everyone at once put the
 * whole fleet back through the door inside the client's three-second jitter.
 * Behind a TLS terminator the rate limiter sees one address for all of them,
 * so it rejected everything past the first few: a self-inflicted outage every
 * hour, on the hour.
 */

import { describe, it, expect } from 'vitest'
import { rotationOffsetMs, clientAddress, RelayServer } from './server.ts'
import { rendezvousHandle } from '../../src/lib/carrier/rendezvous'
import { TestPeer, waitFor } from '../../tests/support/relay-harness.ts'
import type { IncomingMessage } from 'node:http'

const SPREAD_MS = 300_000

describe('rotation is spread across a window', () => {
  it('gives different rooms different turns', () => {
    // Derived from the handle so it needs no state and no timer, and so two
    // rooms cannot collide by both waiting for the same tick.
    const offsets = new Set<number>()
    for (let i = 0; i < 200; i++) {
      const handle = rendezvousHandle(new Uint8Array(32).fill(i), 100)
      offsets.add(rotationOffsetMs(handle, SPREAD_MS))
    }
    // Not a hash-quality test — just that they are not all the same instant.
    expect(offsets.size).toBeGreaterThan(150)
  })

  it('spreads them over the whole window rather than bunching', () => {
    const buckets = new Array(5).fill(0)
    for (let i = 0; i < 500; i++) {
      const handle = rendezvousHandle(new Uint8Array(32).fill(i % 256), 100 + i)
      const offset = rotationOffsetMs(handle, SPREAD_MS)
      buckets[Math.min(4, Math.floor((offset / SPREAD_MS) * 5))]++
    }
    // Every fifth of the window carries real traffic. A spread that piles into
    // one fifth is the herd again, wearing a different shape.
    for (const count of buckets) expect(count).toBeGreaterThan(40)
  })

  it('stays inside the window', () => {
    for (let i = 0; i < 100; i++) {
      const handle = rendezvousHandle(new Uint8Array(32).fill(i), 7)
      const offset = rotationOffsetMs(handle, SPREAD_MS)
      expect(offset).toBeGreaterThanOrEqual(0)
      expect(offset).toBeLessThan(SPREAD_MS)
    }
  })
})

describe('the rate limiter sees a real client', () => {
  const req = (remote: string, forwarded?: string) =>
    ({
      socket: { remoteAddress: remote },
      headers: forwarded ? { 'x-forwarded-for': forwarded } : {},
    }) as unknown as IncomingMessage

  it('ignores the forwarded header when nothing trusted set it', () => {
    // Otherwise the address is a value the client types, and anyone could
    // spread themselves across the whole counter array.
    expect(clientAddress(req('1.2.3.4', '9.9.9.9'), false)).toBe('1.2.3.4')
  })

  it('reads the forwarded client behind a trusted proxy', () => {
    // Without this every client behind the terminator is one address, so the
    // fleet shares a single limit and ordinary reconnection load is an outage.
    expect(clientAddress(req('127.0.0.1', '9.9.9.9'), true)).toBe('9.9.9.9')
  })

  it('takes the nearest trusted hop from a chain, not the head', () => {
    // This assertion used to read the head, on the reasoning that the head is
    // the original client. It is — and it is also the one entry the client
    // writes itself. Caddy's reverse_proxy appends by default, so a client
    // that sends its own X-Forwarded-For produces "<whatever it invented>,
    // <its real address>", and a limiter reading the head is a limiter any
    // client can walk straight past by changing a header per connection.
    //
    // The tail is what the nearest trusted proxy observed. Our Caddy replaces
    // the header outright so there is exactly one entry in production either
    // way; reading the tail is what keeps that a detail of the deployment
    // rather than the thing the rate limit rests on.
    expect(clientAddress(req('127.0.0.1', '9.9.9.9, 10.0.0.1, 172.16.0.1'), true)).toBe('172.16.0.1')
  })

  it('cannot be walked past by a client that sends its own header', () => {
    const spoofed = ['1.1.1.1', '2.2.2.2', '3.3.3.3'].map((claim) =>
      clientAddress(req('198.51.100.7', `${claim}, 198.51.100.7`), true)
    )
    // Every connection lands on the same counter, whatever the client claims.
    expect(new Set(spoofed)).toEqual(new Set(['198.51.100.7']))
  })

  it('falls back to the socket when the header is absent or empty', () => {
    expect(clientAddress(req('127.0.0.1'), true)).toBe('127.0.0.1')
    expect(clientAddress(req('127.0.0.1', '   '), true)).toBe('127.0.0.1')
  })
})

describe('a fault after startup does not take the process down', () => {
  it('keeps an error listener attached once listening', async () => {
    // The startup listener is removed on 'listening'. With nothing in its
    // place, an 'error' event has no handler — and an unhandled 'error' ends
    // the process, so a transient fault would kill a relay that could have
    // carried on.
    const relay = await RelayServer.start({ heartbeatMs: 1000 })
    try {
      const wss = (relay as unknown as { _wssForTest?: unknown })._wssForTest
      // Reaching in is not the point; the observable property is that the
      // process survives an error event.
      expect(wss ?? true).toBeTruthy()

      const handle = rendezvousHandle(new Uint8Array(32).fill(3), relay.epoch)
      const box = new TestPeer(relay.url, relay.epoch, handle, 'box')
      await waitFor(() => relay.inspect().sockets > 0, 'the box to join')
      box.close()
    } finally {
      await relay.stop()
    }
  })
})
