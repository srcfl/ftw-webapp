/* The whole chain, sealed.
 *
 * App session → Noise carrier → loopback → Noise box → box simulator, and
 * back. Nothing is stubbed and nothing is in the clear. This is the test that
 * says the product works: a reading crosses an encrypted session and lands on
 * a screen, and the transport in the middle can prove it saw nothing.
 */

import { describe, it, expect } from 'vitest'
import { x25519 } from '@noble/curves/ed25519.js'
import { Session } from '$lib/protocol/session'
import { NoiseCarrier } from '$lib/carrier/noise'
import { SimBox } from '$lib/sim/box'
import { NoiseBox } from '$lib/sim/noise-box'
import { CarrierBase, type Carrier, type CarrierStatus } from '$lib/carrier/carrier'
import type { CarrierState } from '$lib/protocol/types'

function keys() {
  const secretKey = x25519.utils.randomSecretKey()
  return { secretKey, publicKey: x25519.getPublicKey(secretKey) }
}

/**
 * A carrier that hands bytes to a NoiseBox and records every byte in transit.
 *
 * Standing in for the relay: it moves frames and is expected to learn nothing
 * from them.
 */
class TappedCarrier extends CarrierBase implements Carrier {
  readonly kind: CarrierState = 'relay'
  readonly seen: Uint8Array[] = []
  #peer: NoiseBox
  #status: CarrierStatus = { phase: 'connecting' }
  #unsubPeer: () => void

  constructor(peer: NoiseBox) {
    super()
    this.#peer = peer
    this.#unsubPeer = peer.onFrame((bytes) => {
      this.seen.push(bytes)
      queueMicrotask(() => this.emitFrame(bytes))
    })
    queueMicrotask(() => {
      this.#status = { phase: 'open', sinceMs: 0 }
      this.emitStatus(this.#status)
    })
  }

  get rttMs(): number | null {
    return 0
  }
  get status(): CarrierStatus {
    return this.#status
  }
  send(frame: Uint8Array): void {
    if (this.#status.phase !== 'open') return
    this.seen.push(frame)
    queueMicrotask(() => this.#peer.receive(frame))
  }
  close(reason = 'closed'): void {
    this.#status = { phase: 'closed', reason, retryable: false }
    this.emitStatus(this.#status)
    this.clearHandlers()
    // Stop recording too, or the box's own ticks keep landing in `seen` and a
    // test about what crossed the wire after a close measures nothing.
    this.#unsubPeer()
  }
}

async function settle(times = 30) {
  for (let i = 0; i < times; i++) await new Promise((r) => setTimeout(r, 2))
}

function chain(boxOpts: ConstructorParameters<typeof SimBox>[0] = {}) {
  const boxKeys = keys()
  const appKeys = keys()

  const sim = new SimBox({ now: () => Date.now(), ...boxOpts })
  const noiseBox = new NoiseBox({ box: sim, staticKey: boxKeys })
  const wire = new TappedCarrier(noiseBox)

  const carrier = new NoiseCarrier({
    inner: wire,
    staticKey: appKeys,
    remoteStatic: boxKeys.publicKey,
  })

  const session = new Session({ build: 'test' })
  session.connect(carrier)

  return { session, sim, wire, boxKeys, appKeys, carrier }
}

describe('readings cross an encrypted session', () => {
  it('handshakes, subscribes and delivers a snapshot', async () => {
    const { session } = chain()
    await settle()

    expect(session.state.phase).toBe('streaming')
    expect(session.state.box?.id).toBe('sim-0001')
    // Frozen field ids; see contract/registry.yaml.
    expect(session.state.fields.get(2)).toBeTypeOf('number')
    expect(session.state.fields.get(5)).toBeTypeOf('number')
  })

  it('carries deltas after the handshake', async () => {
    const { session, sim } = chain()
    await settle()

    const before = session.state.fields.get(3)
    sim.tick()
    await settle()

    expect(session.state.uptimeMs).toBeGreaterThanOrEqual(0)
    expect(session.state.fields.get(3)).toBeTypeOf('number')
    expect(before).toBeTypeOf('number')
  })

  it('propagates a device failure through the encryption', async () => {
    const { session, sim } = chain()
    await settle()
    expect(session.worstSourceState(['meter.p1'])).toBe('live')

    sim.faults = { ...sim.faults, sourceStates: { 'meter.p1': 'down' } }
    sim.tick()
    await settle()

    expect(session.worstSourceState(['meter.p1'])).toBe('down')
    expect(session.state.dispatchBlockedBy).toEqual(['meter.p1'])
  })
})

describe('the transport in the middle learns nothing', () => {
  it('carries no recognisable plaintext', async () => {
    const { session, sim, wire } = chain()
    await settle()
    for (let i = 0; i < 5; i++) {
      sim.tick()
      await settle(4)
    }

    expect(session.state.phase).toBe('streaming')
    expect(wire.seen.length).toBeGreaterThan(5)

    const all = new Uint8Array(wire.seen.reduce((n, f) => n + f.length, 0))
    let at = 0
    for (const f of wire.seen) {
      all.set(f, at)
      at += f.length
    }
    const text = new TextDecoder('latin1').decode(all)

    // Names from the protocol and the box that would appear if any frame
    // crossed in the clear.
    for (const needle of [
      'grid_w',
      'pv_w',
      'battery_soc',
      'meter.p1',
      'inverter.sungrow',
      'sim-0001',
      'hello',
      'snap',
      'delta',
      'tick',
    ]) {
      expect(text, `wire leaked ${needle}`).not.toContain(needle)
    }

    // A control: the same needles are present before sealing, so the check
    // above is capable of failing. Without this it proves only that the
    // detector is broken.
    const plain = new TextDecoder('latin1').decode(
      new TextEncoder().encode(JSON.stringify({ t: 'snap', b: { grid_w: 11400 } }))
    )
    expect(plain).toContain('grid_w')
  })

  it('leaks no reading through frame length', async () => {
    // A still house and a busy one must be indistinguishable by size alone,
    // or the padding is decoration.
    const still = chain({ now: () => Date.UTC(2026, 0, 15, 3, 0, 0) })
    await settle()
    const busy = chain({ now: () => Date.UTC(2026, 6, 15, 18, 30, 0) })
    await settle()

    for (let i = 0; i < 4; i++) {
      still.sim.tick()
      busy.sim.tick()
      await settle(4)
    }

    // Handshake messages have their own fixed sizes by design. What must not
    // vary is the data frames, whose size would otherwise track how much of
    // the house changed.
    const dataSizes = (c: typeof still) =>
      new Set(c.wire.seen.filter((f) => f.length > 200).map((f) => f.length))

    expect(dataSizes(still)).toEqual(dataSizes(busy))
    // One lane 0 size and one bulk size. More would mean frame length is a
    // function of content somewhere.
    expect(dataSizes(still).size).toBeLessThanOrEqual(2)
  })
})

describe('pinning is what makes the box the box', () => {
  it('refuses a peer holding a different static key', async () => {
    const boxKeys = keys()
    const impostor = keys()
    const appKeys = keys()

    const sim = new SimBox({ now: () => Date.now() })
    // The relay, or anyone on the wire, answering with its own key.
    const noiseBox = new NoiseBox({ box: sim, staticKey: impostor })
    const wire = new TappedCarrier(noiseBox)

    const carrier = new NoiseCarrier({
      inner: wire,
      staticKey: appKeys,
      remoteStatic: boxKeys.publicKey, // what the QR said
    })
    const session = new Session({ build: 'test' })
    session.connect(carrier)

    await settle()

    // The impostor cannot decrypt message 1, so it never replies. No session,
    // no readings, and nothing claimed to be live.
    expect(session.state.phase).not.toBe('streaming')
    expect(carrier.status.phase).not.toBe('open')
    expect(session.state.fields.size).toBe(0)
  })

  it('refuses a session whose prologue differs', async () => {
    const boxKeys = keys()
    const appKeys = keys()
    const sim = new SimBox({ now: () => Date.now() })

    const noiseBox = new NoiseBox({
      box: sim,
      staticKey: boxKeys,
      prologue: new TextEncoder().encode('site-A'),
    })
    const wire = new TappedCarrier(noiseBox)

    const carrier = new NoiseCarrier({
      inner: wire,
      staticKey: appKeys,
      remoteStatic: boxKeys.publicKey,
      prologue: new TextEncoder().encode('site-B'),
    })
    const session = new Session({ build: 'test' })
    session.connect(carrier)
    await settle()

    // Binding the session to its enrollment context is what stops a captured
    // handshake being replayed into a different one.
    expect(session.state.phase).not.toBe('streaming')
  })

  it('lets the box refuse a device it has never seen', async () => {
    const boxKeys = keys()
    const appKeys = keys()
    const sim = new SimBox({ now: () => Date.now() })

    const noiseBox = new NoiseBox({
      box: sim,
      staticKey: boxKeys,
      // The hook that closes one-way authentication once the box uses it.
      acceptPairing: (payload) => new TextDecoder().decode(payload) === 'the-right-code',
    })
    const wire = new TappedCarrier(noiseBox)

    const carrier = new NoiseCarrier({
      inner: wire,
      staticKey: appKeys,
      remoteStatic: boxKeys.publicKey,
      handshakePayload: new TextEncoder().encode('the-wrong-code'),
    })
    const session = new Session({ build: 'test' })
    session.connect(carrier)
    await settle()

    expect(session.state.phase).not.toBe('streaming')
  })

  it('accepts the device when the code matches', async () => {
    const boxKeys = keys()
    const appKeys = keys()
    const sim = new SimBox({ now: () => Date.now() })

    const noiseBox = new NoiseBox({
      box: sim,
      staticKey: boxKeys,
      acceptPairing: (payload) => new TextDecoder().decode(payload) === 'the-right-code',
    })
    const wire = new TappedCarrier(noiseBox)

    const carrier = new NoiseCarrier({
      inner: wire,
      staticKey: appKeys,
      remoteStatic: boxKeys.publicKey,
      handshakePayload: new TextEncoder().encode('the-right-code'),
    })
    const session = new Session({ build: 'test' })
    session.connect(carrier)
    await settle()

    expect(session.state.phase).toBe('streaming')
  })
})

describe('a dropped carrier never resumes a session', () => {
  it('closes rather than carrying on with the old keys', async () => {
    const { session, wire, carrier } = chain()
    await settle()
    expect(session.state.phase).toBe('streaming')

    // A Noise session cannot survive a gap: its keys belong to one handshake
    // and its counters to one stream. Resuming would mean splitting the same
    // handshake twice — two ciphers, same key, both at nonce zero.
    wire.close('network gone')
    await settle()

    expect(carrier.status.phase).toBe('closed')
    // The readings stay. They were true, and the freshness band says how old.
    expect(session.state.fields.size).toBeGreaterThan(0)
  })

  it('refuses to send once the session is gone', async () => {
    const { wire, carrier } = chain()
    await settle()

    wire.close('network gone')
    await settle()

    const before = wire.seen.length
    carrier.send(new Uint8Array(512))
    await settle(3)

    // Sending in the clear to keep a caller happy would be worse than dropping.
    expect(wire.seen.length).toBe(before)
  })
})
