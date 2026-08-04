/* A simulated box that speaks Noise.
 *
 * SimBox knows the protocol; this puts an encrypted session in front of it, so
 * tests and development run the same path production will: handshake, then
 * sealed frames, over whatever carrier is underneath.
 *
 * Kept separate from box.ts on purpose. The box's job is to behave like a
 * house and misbehave on demand; the crypto belongs beside it, not inside it,
 * or every failure-mode test would have to set up a handshake first.
 */

import { HandshakeState, type KeyPair } from '$lib/crypto/noise'
import { NoiseTransport } from '$lib/crypto/transport'
import type { SimBox } from './box'

export interface NoiseBoxOptions {
  box: SimBox
  /** The box's long-lived key pair. Its public half goes in the QR. */
  staticKey: KeyPair
  /** Must match the app's byte for byte. */
  prologue?: Uint8Array
  /**
   * Called with the payload from handshake message 1.
   *
   * This is where the box gets to refuse a device it has never seen. Return
   * false and the handshake dies before any application frame moves. Today
   * nothing checks it, which is why the box authenticates nobody — see
   * docs/architecture.md, "What is not yet true".
   */
  acceptPairing?: (payload: Uint8Array) => boolean
}

/**
 * Wraps a SimBox in a Noise responder.
 *
 * One session at a time, which matches the relay: a room holds one box.
 */
export class NoiseBox {
  #box: SimBox
  #staticKey: KeyPair
  #prologue: Uint8Array | undefined
  #accept: (payload: Uint8Array) => boolean

  #handshake: HandshakeState | null = null
  #transport: NoiseTransport | null = null
  #out = new Set<(bytes: Uint8Array) => void>()
  #unsubBox: (() => void) | null = null

  constructor(opts: NoiseBoxOptions) {
    this.#box = opts.box
    this.#staticKey = opts.staticKey
    this.#prologue = opts.prologue
    this.#accept = opts.acceptPairing ?? (() => true)

    this.#unsubBox = this.#box.onFrame((frame) => {
      if (!this.#transport) return
      this.#emit(this.#transport.encrypt(frame))
    })
  }

  get established(): boolean {
    return this.#transport !== null
  }

  onFrame(handler: (bytes: Uint8Array) => void): () => void {
    this.#out.add(handler)
    return () => this.#out.delete(handler)
  }

  /** Deliver bytes from the app. */
  receive(bytes: Uint8Array): void {
    if (this.#transport) {
      const frame = this.#transport.decrypt(bytes)
      // Junk on the wire is dropped, never fatal — anyone can write to a relay
      // socket, and tearing down here would hand them a free denial of service.
      if (frame) this.#box.receive(frame)
      return
    }

    this.#onHandshake(bytes)
  }

  /** Forget the session. The next message 1 starts a new one. */
  reset(): void {
    this.#transport?.close()
    this.#transport = null
    this.#handshake = null
  }

  destroy(): void {
    this.reset()
    this.#unsubBox?.()
    this.#unsubBox = null
    this.#out.clear()
  }

  #onHandshake(bytes: Uint8Array): void {
    // A second message 1 means the app reconnected. Start over rather than
    // trying to resume: the keys belong to one handshake and the counters to
    // one stream.
    this.#handshake = HandshakeState.responder({
      staticKey: this.#staticKey,
      ...(this.#prologue ? { prologue: this.#prologue } : {}),
    })

    let payload: Uint8Array
    try {
      payload = this.#handshake.readMessage(bytes)
    } catch {
      // Wrong pinned key, tampered message, or noise. Silence is the right
      // answer: replying would tell an attacker which of those it was.
      this.#handshake = null
      return
    }

    if (!this.#accept(payload)) {
      this.#handshake = null
      return
    }

    try {
      this.#emit(this.#handshake.writeMessage())
      this.#transport = new NoiseTransport(this.#handshake.split())
    } catch {
      this.#transport = null
    } finally {
      this.#handshake = null
    }
  }

  #emit(bytes: Uint8Array): void {
    for (const h of this.#out) h(bytes)
  }
}
