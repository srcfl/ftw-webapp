import { describe, it, expect } from 'vitest'
import { NoiseTransport, SEQ_BYTES, TRANSPORT_OVERHEAD, REPLAY_WINDOW } from './transport'
import { HandshakeState, CipherState, NoiseError, MAX_NONCE, generateKeyPair } from './noise'
import { encodeFrame, LANE_CONTROL } from '$lib/protocol/frame'

/** Two ends of a finished handshake, wired up as transports. */
async function connect(): Promise<{ app: NoiseTransport; box: NoiseTransport }> {
  const appKey = generateKeyPair()
  const boxKey = generateKeyPair()

  const initiator = HandshakeState.initiator({ staticKey: appKey, remoteStatic: boxKey.publicKey })
  const responder = HandshakeState.responder({ staticKey: boxKey })

  await responder.readMessage(await initiator.writeMessage())
  await initiator.readMessage(await responder.writeMessage())

  return { app: new NoiseTransport(initiator.split()), box: new NoiseTransport(responder.split()) }
}

const tick = () => encodeFrame({ lane: LANE_CONTROL, flags: 0, envelope: { t: 'tick', b: { seq: 1 } } }, 512)

const delta = (fields: Record<number, number>) =>
  encodeFrame({ lane: LANE_CONTROL, flags: 0, envelope: { t: 'delta', b: { seq: 2, fields } } }, 512)

describe('round trip', () => {
  it('carries a frame in both directions', async () => {
    const { app, box } = await connect()
    const frame = delta({ 2: 11400, 3: 6200, 4: -4200, 5: 875 })

    expect(box.decrypt(app.encrypt(frame))).toEqual(frame)
    expect(app.decrypt(box.encrypt(frame))).toEqual(frame)
  })

  it('keeps a long stream in step', async () => {
    const { app, box } = await connect()
    for (let i = 0; i < 200; i++) {
      const frame = delta({ 2: i * 13 })
      expect(box.decrypt(app.encrypt(frame))).toEqual(frame)
    }
    expect(app.nextSeq).toBe(200n)
  })

  it('adds a fixed overhead, so lane 0 stays one constant size on the wire', async () => {
    const { app } = await connect()
    const frames = [tick(), delta({}), delta({ 2: 1, 3: 2, 4: 3, 5: 4, 6: 5 })]
    const lengths = new Set(frames.map((f) => app.encrypt(f).length))

    expect(lengths).toEqual(new Set([512 + TRANSPORT_OVERHEAD]))
  })
})

describe('tampering', () => {
  it('rejects a flipped bit in the body', async () => {
    const { app, box } = await connect()
    const wire = app.encrypt(tick())
    wire[100] = wire[100]! ^ 0x01

    expect(() => box.decrypt(wire)).toThrow(NoiseError)
  })

  it('rejects a truncated tag', async () => {
    const { app, box } = await connect()
    expect(() => box.decrypt(app.encrypt(tick()).subarray(0, 400))).toThrow(NoiseError)
  })

  it('rejects a message too short to hold a sequence number and a tag', async () => {
    const { box } = await connect()
    expect(() => box.decrypt(new Uint8Array(TRANSPORT_OVERHEAD - 1))).toThrow(/transport message is/)
  })

  it('rejects a renumbered message, because the sequence number is authenticated', async () => {
    const { app, box } = await connect()
    const wire = app.encrypt(tick())
    wire[SEQ_BYTES - 1] = 9

    expect(() => box.decrypt(wire)).toThrow(NoiseError)
  })

  it('says only that authentication failed', async () => {
    const { app, box } = await connect()
    const wire = app.encrypt(tick())
    wire[wire.length - 1] = wire[wire.length - 1]! ^ 0x80

    try {
      box.decrypt(wire)
      expect.unreachable('a forged tag must not decrypt')
    } catch (err) {
      expect((err as NoiseError).code).toBe('E_NOISE_AUTH')
    }
  })
})

describe('replay', () => {
  it('rejects a frame it has already accepted', async () => {
    const { app, box } = await connect()
    const wire = app.encrypt(tick())

    expect(box.decrypt(wire)).toBeInstanceOf(Uint8Array)
    try {
      box.decrypt(wire)
      expect.unreachable('the same frame must not be accepted twice')
    } catch (err) {
      expect((err as NoiseError).code).toBe('E_NOISE_REPLAY')
    }
  })

  it('rejects an old frame replayed after the stream has moved on', async () => {
    const { app, box } = await connect()
    const first = app.encrypt(tick())
    box.decrypt(first)

    for (let i = 0; i < 10; i++) box.decrypt(app.encrypt(delta({ 2: i })))

    expect(() => box.decrypt(first)).toThrow(/already accepted/)
  })

  it('accepts frames that arrive out of order inside the window', async () => {
    // A DataChannel may reorder. Dropping a late frame would cost a reading
    // for no reason, so the window forgives it.
    const { app, box } = await connect()
    const wire = Array.from({ length: 5 }, (_, i) => app.encrypt(delta({ 2: i })))

    box.decrypt(wire[4]!)
    for (const i of [0, 1, 2, 3]) expect(box.decrypt(wire[i]!)).toBeInstanceOf(Uint8Array)
  })

  it('rejects a frame older than the window', async () => {
    const { app, box } = await connect()
    const first = app.encrypt(tick())

    for (let i = 0; i <= REPLAY_WINDOW; i++) app.encrypt(delta({ 2: i }))
    box.decrypt(app.encrypt(delta({ 2: 99 })))

    expect(() => box.decrypt(first)).toThrow(/outside the replay window/)
  })

  it('does not let an injected frame burn sequence numbers', async () => {
    // If a failed decryption moved the window, anyone able to write to the
    // carrier could push it far ahead and lock the real box out.
    const { app, box } = await connect()
    const forged = new Uint8Array(TRANSPORT_OVERHEAD + 512)
    forged[SEQ_BYTES - 1] = 200

    expect(() => box.decrypt(forged)).toThrow(NoiseError)

    const frame = tick()
    expect(box.decrypt(app.encrypt(frame))).toEqual(frame)
  })
})

describe('exhaustion and close', () => {
  it('throws instead of reusing a nonce', async () => {
    const send = new CipherState(new Uint8Array(32).fill(3))
    const recv = new CipherState(new Uint8Array(32).fill(4))
    send.setNonce(MAX_NONCE - 1n)

    const transport = new NoiseTransport({
      send,
      recv,
      handshakeHash: new Uint8Array(32),
      remoteStatic: new Uint8Array(32),
    })

    transport.encrypt(tick())
    try {
      transport.encrypt(tick())
      expect.unreachable('the counter must not wrap')
    } catch (err) {
      expect((err as NoiseError).code).toBe('E_NOISE_NONCE_EXHAUSTED')
    }
  })

  it('is unusable after close', async () => {
    const { app } = await connect()
    app.close()

    expect(() => app.encrypt(tick())).toThrow(/closed/)
    expect(() => app.decrypt(new Uint8Array(600))).toThrow(/closed/)
  })

  it('exposes the box static key the handshake authenticated', async () => {
    const boxKey = generateKeyPair()
    const initiator = HandshakeState.initiator({ staticKey: generateKeyPair(), remoteStatic: boxKey.publicKey })
    const responder = HandshakeState.responder({ staticKey: boxKey })
    await responder.readMessage(await initiator.writeMessage())
    await initiator.readMessage(await responder.writeMessage())

    expect(new NoiseTransport(initiator.split()).remoteStatic).toEqual(boxKey.publicKey)
  })
})

describe('a passive observer learns only that a frame went by', () => {
  // The relay sees every byte. What it must not be able to do is tell a house
  // at full tilt from a house asleep. Padding makes the lengths equal; this is
  // the other half of the claim — that nothing else in the bytes separates
  // them either.
  const busy = delta({ 2: 11400, 3: 6200, 4: -4200, 5: 875, 6: 13400 })
  const quiet = tick()

  it('emits the same length for two different frames of the same length', async () => {
    expect(busy.length).toBe(quiet.length)

    const { app } = await connect()
    expect(app.encrypt(busy).length).toBe(app.encrypt(quiet).length)
  })

  it('emits a different ciphertext each time the same frame is sent', async () => {
    const { app } = await connect()
    const a = app.encrypt(busy)
    const b = app.encrypt(busy)

    // Only the counter matches, and the counter is a counter.
    expect(a.subarray(SEQ_BYTES)).not.toEqual(b.subarray(SEQ_BYTES))
  })

  it('leaves no trace of a highly structured frame', async () => {
    const { app } = await connect()
    const zeros = new Uint8Array(512)
    const body = app.encrypt(zeros).subarray(SEQ_BYTES)

    let run = 0
    let longest = 0
    for (const byte of body) {
      run = byte === 0 ? run + 1 : 0
      longest = Math.max(longest, run)
    }

    // 512 identical input bytes; a run of 8 zeros out of ChaCha has
    // probability around 2^-58.
    expect(longest).toBeLessThan(8)
  })

  it('produces transcripts an observer cannot tell apart', async () => {
    // The observer's whole view: the bytes on the wire. Take every summary it
    // could compute cheaply over many sessions and show the two plaintexts
    // land in the same place. Tolerances are set around fourteen and five
    // standard deviations, so this fails on a real leak, not on luck.
    const trials = 128
    const measure = async (frame: Uint8Array) => {
      let sum = 0
      let zeros = 0
      const lengths = new Set<number>()

      for (let i = 0; i < trials; i++) {
        const { app } = await connect()
        const body = app.encrypt(frame).subarray(SEQ_BYTES)
        lengths.add(body.length)
        for (const byte of body) {
          sum += byte
          if (byte === 0) zeros++
        }
      }

      return { mean: sum / (trials * 512), zeros, lengths }
    }

    const a = await measure(busy)
    const b = await measure(quiet)

    expect(a.lengths).toEqual(b.lengths)
    expect(Math.abs(a.mean - b.mean)).toBeLessThan(4)
    expect(Math.abs(a.zeros - b.zeros)).toBeLessThan(120)
    // A sweep, not a unit: 256 sessions of real crypto. On a busy CI runner
    // it brushes the default five seconds, and a timeout here would say
    // "slow machine", never "leak".
  }, 30_000)
})
