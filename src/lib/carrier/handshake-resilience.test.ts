import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { NoiseCarrier } from './noise'
import { CarrierBase, type Carrier, type CarrierStatus } from './carrier'
import { generateKeyPair, HandshakeState } from '$lib/crypto/noise'
import { NoiseTransport } from '$lib/crypto/transport'
import type { CarrierState } from '$lib/protocol/types'
import { linkCounters, resetLinkCounters } from '$lib/perf/link'

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

function carrierUnderTest(box = generateKeyPair()) {
  const inner = new FakeInner()
  const app = generateKeyPair()
  const carrier = new NoiseCarrier({
    inner,
    staticKey: app,
    remoteStatic: box.publicKey,
  })
  const seen: CarrierStatus[] = []
  carrier.onStatus((s) => seen.push(s))
  return { inner, carrier, seen, box }
}

describe('a handshake meeting somebody else’s frames', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    resetLinkCounters()
  })
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

  it('asks again after the deadline, and a late-answering box still gets in', async () => {
    // The deadline ends the first attempt retryably — but the socket is
    // still open, and the inner carrier never re-emits 'open' on a socket
    // that never dropped. The retry has to come from the Noise carrier
    // itself, or a box rebooting through an update leaves the app closed
    // until the epoch rotates.
    const { inner, carrier, seen, box } = carrierUnderTest()
    inner.open()
    await vi.advanceTimersByTimeAsync(10)
    expect(inner.sent.length).toBe(1)

    await vi.advanceTimersByTimeAsync(13_000)
    expect(seen.some((s) => s.phase === 'closed' && s.retryable)).toBe(true)

    // A fresh message 1 goes out on its own, without the socket moving.
    // Walked in small steps so the answer below lands while the newest
    // attempt is still waiting, wherever the jitter put it. The step count
    // is a bound, not a schedule: far more fake time than any first retry.
    for (let i = 0; i < 100 && inner.sent.length === 1; i++) await vi.advanceTimersByTimeAsync(500)
    expect(inner.sent.length, 'no second handshake was ever attempted').toBeGreaterThan(1)

    // The box comes back and answers the newest attempt; the session opens
    // with no reload and no reconnect.
    const responder = HandshakeState.responder({ staticKey: box })
    await responder.readMessage(inner.sent.at(-1)!)
    inner.deliver(await responder.writeMessage())
    await vi.advanceTimersByTimeAsync(10)
    expect(carrier.status.phase).toBe('open')

    // And frames flow: the box's first transport frame decrypts and surfaces.
    const heard: Uint8Array[] = []
    carrier.onFrame((f) => heard.push(f))
    const boxTransport = new NoiseTransport(responder.split())
    inner.deliver(boxTransport.encrypt(Uint8Array.from([7, 7, 7])))
    expect(heard).toEqual([Uint8Array.from([7, 7, 7])])
  })

  it('drops foreign transport frames without logging or disturbing its own stream', async () => {
    const sharedBox = generateKeyPair()
    const { inner, carrier } = carrierUnderTest(sharedBox)
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {})
    const marked = vi.spyOn(performance, 'mark')

    inner.open()
    await vi.advanceTimersByTimeAsync(10)
    const responder = HandshakeState.responder({ staticKey: sharedBox })
    await responder.readMessage(inner.sent[0]!)
    inner.deliver(await responder.writeMessage())
    await vi.advanceTimersByTimeAsync(10)

    // A second phone, with its own Noise session to the same box. The relay
    // sends the box's reply and transport frames to both phones.
    const other = carrierUnderTest(sharedBox)
    other.inner.open()
    await vi.advanceTimersByTimeAsync(10)
    const otherResponder = HandshakeState.responder({ staticKey: sharedBox })
    await otherResponder.readMessage(other.inner.sent[0]!)
    other.inner.deliver(await otherResponder.writeMessage())
    await vi.advanceTimersByTimeAsync(10)

    const heard: Uint8Array[] = []
    carrier.onFrame((frame) => heard.push(frame))
    const boxTransport = new NoiseTransport(responder.split())
    const otherBoxTransport = new NoiseTransport(otherResponder.split())
    const own = boxTransport.encrypt(Uint8Array.from([1, 2, 3]))
    const foreign = otherBoxTransport.encrypt(Uint8Array.from([9, 9, 9]))

    // Auth, bad shape and replay are all normal on a shared relay room.
    inner.deliver(foreign)
    inner.deliver(new Uint8Array(3))
    inner.deliver(own)
    inner.deliver(own)

    expect(carrier.status.phase).toBe('open')
    expect(heard).toEqual([Uint8Array.from([1, 2, 3])])
    expect(logged).not.toHaveBeenCalled()
    expect(marked).toHaveBeenCalledWith('ftw:noise-open', undefined)
    expect(linkCounters()).toMatchObject({ noiseAcceptedFrames: 1, noiseForeignFrames: 3 })
  })
})
