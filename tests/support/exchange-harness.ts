/* Test rig for the watch exchange: a box's exchange socket and a watch, both
 * played by the test, across a real relay.
 *
 * Core's side is ADR 0009 step 5 in srcfl/ftw, and the watch is Swift. This
 * stand-in follows docs/watch-exchange.md: IK with the prologue
 * `ftw.exchange.v1:` and the box's static key, `hello_ok` in a 1 KiB bulk
 * bucket, a lane 0 frame in every other message, and two transport messages
 * in every answer after the handshake. What the relay may learn does not
 * depend on which side wrote the bytes, only on their being sealed and on
 * their sizes.
 */

import { HandshakeState, generateKeyPair, type KeyPair } from '$lib/crypto/noise'
import { NoiseTransport } from '$lib/crypto/transport'
import { decodeFrame, encodeFrame, LANE_BULK, LANE_CONTROL, type Envelope } from '$lib/protocol/frame'
import { EXCHANGE_ID_BYTES } from '../../relay/src/protocol.ts'
import { TestPeer } from './relay-harness.ts'

/** Every frame but `hello_ok` is one lane 0 bucket. */
export const LANE0 = 512
export const HELLO_OK_BUCKET = 1024
/** A transport message: 8 bytes of sequence, one lane 0 frame, a 16-byte tag. */
export const TRANSPORT_BYTES = 536

/** The exchange's prologue, so a stream handshake can never stand in for one. */
export function exchangePrologue(boxStatic: Uint8Array): Uint8Array {
  const label = new TextEncoder().encode('ftw.exchange.v1:')
  const out = new Uint8Array(label.length + boxStatic.length)
  out.set(label)
  out.set(boxStatic, label.length)
  return out
}

export function lane0(envelope: Envelope): Uint8Array {
  return encodeFrame({ lane: LANE_CONTROL, flags: 0, envelope }, LANE0)
}

export function concat(parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0))
  let at = 0
  for (const p of parts) {
    out.set(p, at)
    at += p.length
  }
  return out
}

/** How the box answers a command. `tick` means it has not settled in 3 s. */
export type Outcome = 'applied' | 'rejected' | 'unconfirmed' | 'tick'

/** The charger the house has, as the box names it. */
export const CHARGER = { src: 'charger.easee', name: 'Easee carport' }

/**
 * Now, as the box would send it: frozen fields, source states and the
 * charger. Every reading is well clear of zero, so the blindness test has
 * something worth hunting for.
 */
export const HOUSE_NOW = {
  fields: { 1: 3, 2: 3456, 3: -4210, 4: -1234, 5: 640, 6: 2187, 10: 7360 },
  src: { 'meter.p1': 'live', 'inverter.sungrow': 'live', [CHARGER.src]: 'live' },
  lp: [{ src: CHARGER.src, name: CHARGER.name, plug: 'connected', soc: 640, w: 7360, controlRev: 41 }],
}

/** The readings in HOUSE_NOW, for a detector to look for. */
export const HOUSE_READINGS = [3456, -4210, -1234, 640, 2187, 7360]

/**
 * A box's exchange socket. It answers each message the way ADR 0009 says
 * Core will, without Core's checks: what it answers is up to `outcome`.
 */
export class ExchangeBox {
  readonly keys: KeyPair = generateKeyPair()
  readonly peer: TestPeer
  /** Each message as it reached the box: the relay's id, then the body. */
  readonly seen: Uint8Array[] = []
  /** Each answer as it left: the same id, then the sealed reply. */
  readonly answered: Uint8Array[] = []
  outcome: Outcome = 'applied'
  /** When false the box reads and answers nothing, as a box that hung would. */
  answering = true

  #sessions: NoiseTransport[] = []
  #uptimeMs = 3_600_000

  constructor(relayUrl: string, epoch: number, handle: string) {
    this.peer = new TestPeer(relayUrl, epoch, handle, 'exchange')
    this.peer.onBinary((message) => void this.#onMessage(message))
  }

  async #onMessage(message: Uint8Array): Promise<void> {
    this.seen.push(message)
    if (!this.answering) return

    const id = message.subarray(0, EXCHANGE_ID_BYTES)
    const body = message.subarray(EXCHANGE_ID_BYTES)
    const reply = body.length === TRANSPORT_BYTES ? this.#exchange(body) : await this.#open(body)
    if (!reply) return

    const out = concat([id, reply])
    this.answered.push(out)
    this.peer.send(out)
  }

  /** X1: IK message 1 in, message 2 out with `hello_ok`. */
  async #open(message1: Uint8Array): Promise<Uint8Array | null> {
    const responder = HandshakeState.responder({
      staticKey: this.keys,
      prologue: exchangePrologue(this.keys.publicKey),
    })
    try {
      const hello = decodeFrame(await responder.readMessage(message1)).envelope
      if (hello.t !== 'hello') return null
    } catch {
      return null // a stranger gets no reply
    }

    const helloOk: Envelope = {
      t: 'hello_ok',
      b: {
        proto: 1,
        role: 'watch',
        scopes: ['ftw.live.read', 'ftw.plan.read', 'ftw.events.read', 'ftw.dispatch.write'],
        clock: { uptimeMs: this.#uptimeMs, boot: 'boot-7c1d' },
        rev: 41,
      },
    }
    const message2 = await responder.writeMessage(
      encodeFrame({ lane: LANE_BULK, flags: 0, envelope: helloOk }, HELLO_OK_BUCKET)
    )
    this.#sessions.push(new NoiseTransport(responder.split()))
    return message2
  }

  /** `cmd` or `now` in, two transport messages out. */
  #exchange(message: Uint8Array): Uint8Array | null {
    for (const session of this.#sessions) {
      let envelope: Envelope
      try {
        envelope = decodeFrame(session.decrypt(message)).envelope
      } catch {
        continue // another session's
      }
      const [first, second] = this.#answerTo(envelope)
      return concat([session.encrypt(lane0(first)), session.encrypt(lane0(second))])
    }
    return null
  }

  #answerTo(envelope: Envelope): [Envelope, Envelope] {
    this.#uptimeMs += 1_000
    const tick: Envelope = { t: 'tick', b: { seq: 1, uptimeMs: this.#uptimeMs } }
    if (envelope.t === 'now') return [{ t: 'now', b: HOUSE_NOW }, tick]

    const cmdId = (envelope.b as { cmdId: string }).cmdId
    const ack: Envelope = {
      t: 'cmd.ack',
      b: { cmdId, leaseId: 'lease-0c9e', expiresAtMs: this.#uptimeMs + 30_000 },
    }
    const result = (state: string, extra: object = {}): Envelope => ({
      t: 'cmd.result',
      b: { cmdId, state, ...extra },
    })

    switch (this.outcome) {
      case 'applied':
        return [ack, result('applied', { observed: { value: 7360, src: CHARGER.src, uptimeMs: this.#uptimeMs } })]
      case 'unconfirmed':
        return [ack, result('unconfirmed')]
      case 'rejected':
        return [result('rejected', { error: { code: 'E_SCOPE_DENIED' } }), tick]
      case 'tick':
        return [ack, tick]
    }
  }
}

export interface Posted {
  status: number
  body: Uint8Array
  headers: Headers
}

/** POST one body to `/x/<epoch>/<handle>`, as a watch's URLSession would. */
export async function postExchange(
  relayUrl: string,
  epoch: number,
  handle: string,
  body: Uint8Array,
  headers: Record<string, string> = { 'content-type': 'application/octet-stream' }
): Promise<Posted> {
  const res = await fetch(`${relayUrl.replace(/^ws/, 'http')}/x/${epoch}/${handle}`, {
    method: 'POST',
    headers,
    // A copy on its own ArrayBuffer, which is the type fetch takes.
    body: new Uint8Array(body),
  })
  return { status: res.status, body: new Uint8Array(await res.arrayBuffer()), headers: res.headers }
}

/** A watch: its own key, the box's static key, and one session at a time. */
export class Watch {
  readonly keys: KeyPair = generateKeyPair()
  /** Every body it posted and every answer it got, as the relay carried them. */
  readonly wire: Uint8Array[] = []
  /** The same exchanges unsealed, for a detector's control. */
  readonly plain: Uint8Array[] = []
  epoch: number

  #relayUrl: string
  #boxStatic: Uint8Array
  #handle: string
  #transport: NoiseTransport | null = null

  constructor(relayUrl: string, boxStatic: Uint8Array, epoch: number, handle: string) {
    this.#relayUrl = relayUrl
    this.#boxStatic = boxStatic
    this.epoch = epoch
    this.#handle = handle
  }

  async post(body: Uint8Array): Promise<Posted> {
    this.wire.push(body)
    const answer = await postExchange(this.#relayUrl, this.epoch, this.#handle, body)
    this.wire.push(answer.body)
    return answer
  }

  /** X1. The pairing code rides in message 1, sealed. */
  async open(code = 'watch-code-7f3a9c'): Promise<Posted & { helloOk?: Envelope }> {
    const initiator = HandshakeState.initiator({
      staticKey: this.keys,
      remoteStatic: this.#boxStatic,
      prologue: exchangePrologue(this.#boxStatic),
    })
    const hello: Envelope = {
      t: 'hello',
      b: { proto: { min: 1, max: 1 }, app: { build: 'watch-test', ua: 'watch' }, code },
    }
    this.plain.push(lane0(hello))
    const answer = await this.post(await initiator.writeMessage(lane0(hello)))
    if (answer.status !== 200) return answer

    const opened = await initiator.readMessage(answer.body)
    this.plain.push(opened)
    const helloOk = decodeFrame(opened).envelope
    this.#transport = new NoiseTransport(initiator.split())
    return { ...answer, helloOk }
  }

  /** One `cmd` or `now`, and the two envelopes that come back. */
  async ask(envelope: Envelope): Promise<Posted & { envelopes: Envelope[] }> {
    if (!this.#transport) throw new Error('open the exchange first')
    this.plain.push(lane0(envelope))
    const answer = await this.post(this.#transport.encrypt(lane0(envelope)))
    if (answer.status !== 200) return { ...answer, envelopes: [] }

    const envelopes: Envelope[] = []
    for (let at = 0; at < answer.body.length; at += TRANSPORT_BYTES) {
      const frame = this.#transport.decrypt(answer.body.subarray(at, at + TRANSPORT_BYTES))
      this.plain.push(frame)
      envelopes.push(decodeFrame(frame).envelope)
    }
    return { ...answer, envelopes }
  }
}

/** A `cmd` envelope as the watch builds it, with an id the watch minted. */
export function command(op: string, args: Record<string, unknown>, n: number): Envelope {
  return {
    t: 'cmd',
    b: {
      cmdId: `0192f0c4-7e1a-7000-8000-${String(n).padStart(12, '0')}`,
      op,
      args,
      notValidAfterMs: 3_630_000,
      expect: { rev: 41, guards: [] },
    },
  }
}
