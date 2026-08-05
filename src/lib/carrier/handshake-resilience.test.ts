import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { NoiseCarrier } from './noise'
import { CarrierBase, type Carrier, type CarrierStatus } from './carrier'
import { generateKeyPair } from '$lib/crypto/noise'
import type { CarrierState } from '$lib/protocol/types'

/* A stray frame during the handshake must not end the carrier.
 *
 * The relay broadcasts the box's frames to every stream in a room, so a
 * second phone in the same house starts its handshake into a running 1 Hz
 * telemetry stream. Those frames are not message 2. Feeding them to
 * readMessage used to close the carrier non-retryably — a household where
 * the first phone works and the second never can, and a one-packet kill
 * switch for anyone able to write to the socket.
 */

/** An inner carrier a test can push arbitrary bytes through. */
class FakeInner extends CarrierBase implements Carrier {
  readonly kind: CarrierState = 'relay'
  readonly sent: Uint8Array[] = []
  #status: CarrierStatus = { phase: 'connecting' }

  get rttMs(): number | null {
    return null
  }
  get status(): CarrierStatus {
    return this.#status
  }
  send(frame: Uint8Array): void {
    this.sent.push(frame)
  }
  close(): void {
    this.#status = { phase: 'closed', reason: 'test', retryable: true }
    this.emitStatus(this.#status)
  }
  open(): void {
    this.#status = { phase: 'open', sinceMs: Date.now() }
    this.emitStatus(this.#status)
  }
  deliver(bytes: Uint8Array): void {
    this.emitFrame(bytes)
  }
}

function carrierUnderTest() {
  const inner = new FakeInner()
  const app = generateKeyPair()
  const box = generateKeyPair()
  const carrier = new NoiseCarrier({
    inner,
    staticKey: app,
    remoteStatic: box.publicKey,
  })
  const seen: CarrierStatus[] = []
  carrier.onStatus((s) => seen.push(s))
  return { inner, carrier, seen }
}

describe('a handshake meeting somebody else’s frames', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  it('ignores a telemetry-sized frame instead of dying on it', async () => {
    const { inner, carrier, seen } = carrierUnderTest()
    inner.open()
    await vi.advanceTimersByTimeAsync(10)

    // A lane 0 frame from the other phone's session: right shape for the
    // wire, wrong thing entirely for this handshake.
    inner.deliver(new Uint8Array(512))
    inner.deliver(new Uint8Array(280))
    await vi.advanceTimersByTimeAsync(10)

    expect(
      seen.some((s) => s.phase === 'closed'),
      'a broadcast frame closed the carrier'
    ).toBe(false)
    expect(carrier.status.phase).not.toBe('closed')
  })

  it('ignores a wrong-key reply of the right length and keeps waiting', async () => {
    const { inner, carrier, seen } = carrierUnderTest()
    inner.open()
    await vi.advanceTimersByTimeAsync(10)

    // 48 bytes: exactly message 2's shape, but not from the pinned box.
    inner.deliver(new Uint8Array(48).fill(9))
    await vi.advanceTimersByTimeAsync(10)

    expect(seen.some((s) => s.phase === 'closed')).toBe(false)
    expect(carrier.status.phase).toBe('connecting')
  })

  it('gives up retryably when the box never answers at all', async () => {
    // A box that refuses a handshake stays silent on purpose — a reply would
    // confirm a box is on this handle. Without a deadline a revoked phone
    // sits on "Reaching your box" forever, socket open, never reconnecting.
    const { inner, seen } = carrierUnderTest()
    inner.open()
    await vi.advanceTimersByTimeAsync(15_000)

    const closed = seen.find((s) => s.phase === 'closed')
    expect(closed, 'silence never ended the handshake').toBeDefined()
    expect(closed && 'retryable' in closed && closed.retryable).toBe(true)
  })
})
