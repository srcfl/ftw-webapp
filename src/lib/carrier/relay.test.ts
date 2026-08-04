// @vitest-environment node

/* Reconnection has to be invisible, so this is where that is checked.
 *
 * There is no "connect again" button in this app and no place for one. Every
 * case below is something a phone does on an ordinary afternoon — the box
 * restarts, the relay restarts, the clock is wrong — and in each of them the
 * carrier is expected to sort itself out without being asked.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { RelayServer } from '../../../relay/src/server.ts'
import { RelayCarrier, BACKOFF_CAP_MS } from './relay'
import { rendezvousHandle } from './rendezvous'
import { TestPeer, waitFor } from '../../../tests/support/relay-harness.ts'
import type { CarrierStatus } from './carrier'

const SECRET = new Uint8Array(32).fill(11)

/** Retry without waiting, so a test does not have to sit out a backoff. */
const IMMEDIATE = { random: () => 0 }

function portOf(url: string): number {
  return Number(new URL(url).port)
}

describe('the relay carrier', () => {
  let relay: RelayServer

  beforeEach(async () => {
    relay = await RelayServer.start({ heartbeatMs: 1000 })
  })

  afterEach(async () => {
    await relay.stop()
  })

  it('opens once the box is in the room, not merely once the socket is', async () => {
    const carrier = new RelayCarrier({ url: relay.url, secret: SECRET, ...IMMEDIATE })
    await waitFor(() => carrier.status.phase === 'connecting', 'the dial')

    // A socket to a relay with nobody behind it is not a carrier. Reporting it
    // as open would make the app announce a live connection to nothing.
    await new Promise((r) => setTimeout(r, 80))
    expect(carrier.status.phase).not.toBe('open')

    const box = new TestPeer(relay.url, relay.epoch, rendezvousHandle(SECRET, relay.epoch), 'box')
    await waitFor(() => carrier.status.phase === 'open', 'the carrier to open')
    expect(carrier.rttMs).toBeGreaterThanOrEqual(0)

    box.close()
    carrier.close()
  })

  it('follows the box out of the room and back in without a new socket', async () => {
    const handle = rendezvousHandle(SECRET, relay.epoch)
    const carrier = new RelayCarrier({ url: relay.url, secret: SECRET, ...IMMEDIATE })
    const box = new TestPeer(relay.url, relay.epoch, handle, 'box')
    await waitFor(() => carrier.status.phase === 'open', 'open')

    const sockets = relay.inspect().sockets
    box.close()
    await waitFor(() => carrier.status.phase === 'closed', 'the box leaving')

    const back = new TestPeer(relay.url, relay.epoch, handle, 'box')
    await waitFor(() => carrier.status.phase === 'open', 'the box returning')

    // One stream socket throughout. An hour of the box being offline costs a
    // single connection, not one per backoff.
    expect(relay.inspect().sockets).toBe(sockets)

    back.close()
    carrier.close()
  })

  it('never carries a frame across a gap', async () => {
    const handle = rendezvousHandle(SECRET, relay.epoch)
    const carrier = new RelayCarrier({ url: relay.url, secret: SECRET, ...IMMEDIATE })
    const box = new TestPeer(relay.url, relay.epoch, handle, 'box')
    await waitFor(() => carrier.status.phase === 'open', 'open')

    box.close()
    await waitFor(() => carrier.status.phase === 'closed', 'the gap')

    carrier.send(new Uint8Array([1, 2, 3]))
    carrier.send(new Uint8Array([4, 5, 6]))

    const back = new TestPeer(relay.url, relay.epoch, handle, 'box')
    await waitFor(() => carrier.status.phase === 'open', 'the box returning')
    await new Promise((r) => setTimeout(r, 80))

    // A frame held through an outage and delivered afterwards is an old
    // instruction arriving as if it were new. The session asks again instead.
    expect(back.received).toEqual([])

    back.close()
    carrier.close()
  })

  it('refuses an epoch the relay names out of nowhere, even to get connected', async () => {
    // This replaces a test that asserted the opposite. Trusting the announced
    // epoch let the relay pick the handle: it could close us with any number,
    // read handle(secret, N) out of the join path, and build a table of this
    // household's future handles that no later fix could undo, since the
    // secret cannot be rotated remotely.
    //
    // The trade is deliberate and worth stating: a client whose clock is
    // hours wrong cannot connect at all. That is the right way round. A phone
    // has network time; a box with a dead clock is the box's problem to fix
    // locally, not something to solve by letting the relay name identifiers.
    const handle = rendezvousHandle(SECRET, relay.epoch)
    const box = new TestPeer(relay.url, relay.epoch, handle, 'box')

    const carrier = new RelayCarrier({
      url: relay.url,
      secret: SECRET,
      now: () => 0, // 1970
      random: () => 0,
    })

    await new Promise((r) => setTimeout(r, 300))
    expect(carrier.status.phase).not.toBe('open')

    box.close()
    carrier.close()
  })

  it('still corrects across an hour boundary, which is what correction is for', async () => {
    const handle = rendezvousHandle(SECRET, relay.epoch)
    const box = new TestPeer(relay.url, relay.epoch, handle, 'box')

    // One epoch behind: a phone that woke just after the hour turned.
    const carrier = new RelayCarrier({
      url: relay.url,
      secret: SECRET,
      now: () => Date.now() - 3_600_000,
      random: () => 0,
    })

    await waitFor(() => carrier.status.phase === 'open', 'the corrected join')

    box.close()
    carrier.close()
  })

  it('finds the relay again after it restarts, unprompted', async () => {
    const port = portOf(relay.url)
    const handle = rendezvousHandle(SECRET, relay.epoch)
    const carrier = new RelayCarrier({ url: relay.url, secret: SECRET, ...IMMEDIATE })
    let box = new TestPeer(relay.url, relay.epoch, handle, 'box')
    await waitFor(() => carrier.status.phase === 'open', 'open')

    await relay.stop()
    await waitFor(() => carrier.status.phase !== 'open', 'the drop')

    relay = await RelayServer.start({ port, heartbeatMs: 1000 })
    box = new TestPeer(relay.url, relay.epoch, handle, 'box')

    // Nothing asked it to. There is no button to press and no reload.
    await waitFor(() => carrier.status.phase === 'open', 'the carrier to heal', 8000)

    box.close()
    carrier.close()
  })

  it('stops for good when the session closes it', async () => {
    const handle = rendezvousHandle(SECRET, relay.epoch)
    const carrier = new RelayCarrier({ url: relay.url, secret: SECRET, ...IMMEDIATE })
    const box = new TestPeer(relay.url, relay.epoch, handle, 'box')
    await waitFor(() => carrier.status.phase === 'open', 'open')

    const seen: CarrierStatus[] = []
    carrier.onStatus((s) => seen.push(s))
    carrier.close('revoked')

    await new Promise((r) => setTimeout(r, 150))
    expect(carrier.status).toEqual({ phase: 'closed', reason: 'revoked', retryable: false })
    expect(relay.inspect().rooms[0]?.streams ?? 0).toBe(0)

    box.close()
  })

  it('caps its backoff at a minute', () => {
    // Long enough not to hammer a relay that is down, short enough that a
    // phone coming out of a tunnel is never more than a minute behind — and
    // the online and visibility handlers usually beat it to the retry.
    expect(BACKOFF_CAP_MS).toBe(60_000)
  })
})
