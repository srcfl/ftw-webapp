/* The carrier that makes every other carrier private.
 *
 * Wraps an inner carrier — relay today, a WebRTC DataChannel later — and runs
 * the Noise IK handshake across it before a single application frame moves.
 * Everything above sees an ordinary Carrier; everything below sees opaque
 * bytes. That is the whole reason the relay can be blind without the session
 * layer knowing a relay exists.
 *
 * The box's static key is pinned optically from the QR code at enrollment,
 * which is what IK needs and what stops the relay presenting itself as a box:
 * it has no key that satisfies the first decryption.
 *
 * Nothing here is on the first-frame path. The handshake is two carrier round
 * trips and runs behind cached readings that are already on screen.
 */

import { CarrierBase, type Carrier, type CarrierStatus } from './carrier'
import type { CarrierState } from '$lib/protocol/types'
import { HandshakeState, NoiseError, type StaticKey, type KeyPair } from '$lib/crypto/noise'
import { NoiseTransport } from '$lib/crypto/transport'

export interface NoiseCarrierOptions {
  /** The transport to wrap. Its lifetime becomes ours. */
  inner: Carrier
  /**
   * This device's long-lived static.
   *
   * A StaticKey rather than raw bytes, so a non-extractable WebCrypto handle
   * works — see $lib/identity/vault.
   */
  staticKey: StaticKey | KeyPair
  /** The box's static public key, pinned from the QR at enrollment. */
  remoteStatic: Uint8Array
  /**
   * Sent in handshake message 1, encrypted.
   *
   * This is where the single-use pairing code belongs, so the box can decide
   * whether to accept a device it has never seen. Until the box checks it,
   * authentication is one-way: the app knows the box, the box knows nobody.
   */
  handshakePayload?: Uint8Array
  /**
   * Bound into the handshake hash; both ends must agree byte for byte.
   *
   * Binding the session to its enrollment context is what stops a captured
   * handshake being replayed into a different one.
   */
  prologue?: Uint8Array
}

export class NoiseCarrier extends CarrierBase implements Carrier {
  #inner: Carrier
  #handshake: HandshakeState | null
  #transport: NoiseTransport | null = null
  #status: CarrierStatus = { phase: 'connecting' }
  #unsub: (() => void)[] = []
  #closed = false
  /** True once message 1 is out and we are waiting for the reply. */
  #awaitingReply = false

  /** Kept so each reconnection can start a fresh handshake from the same input. */
  #seed: { staticKey: StaticKey | KeyPair; remoteStatic: Uint8Array; prologue?: Uint8Array }
  #payload: Uint8Array

  constructor(opts: NoiseCarrierOptions) {
    super()
    this.#inner = opts.inner
    this.#seed = {
      staticKey: opts.staticKey,
      remoteStatic: opts.remoteStatic,
      ...(opts.prologue ? { prologue: opts.prologue } : {}),
    }
    this.#payload = opts.handshakePayload ?? new Uint8Array(0)
    this.#handshake = null

    this.#unsub.push(
      opts.inner.onFrame((bytes) => this.#onInnerFrame(bytes)),
      opts.inner.onStatus((s) => this.#onInnerStatus(s))
    )

    if (opts.inner.status.phase === 'open') this.#beginHandshake()
  }

  get kind(): CarrierState {
    return this.#inner.kind
  }

  get rttMs(): number | null {
    return this.#inner.rttMs
  }

  get status(): CarrierStatus {
    return this.#status
  }

  send(frame: Uint8Array): void {
    // Before the handshake completes there is no key, and sending in the clear
    // to keep a caller happy would be worse than dropping. The session resends
    // after the carrier reports open.
    if (!this.#transport || this.#status.phase !== 'open') return

    try {
      this.#inner.send(this.#transport.encrypt(frame))
    } catch (err) {
      // Nonce exhaustion or a destroyed cipher. Neither is recoverable on this
      // session, and continuing would risk reusing a (key, nonce) pair.
      this.#fail(err instanceof NoiseError ? err.message : 'encryption failed')
    }
  }

  close(reason = 'closed by client'): void {
    if (this.#closed) return
    this.#closed = true

    for (const u of this.#unsub) u()
    this.#unsub = []

    this.#transport?.close()
    this.#transport = null
    this.#handshake = null

    this.#inner.close(reason)
    this.#setStatus({ phase: 'closed', reason, retryable: false })
    this.clearHandlers()
  }

  #onInnerStatus(s: CarrierStatus): void {
    if (this.#closed) return

    if (s.phase === 'open') {
      this.#beginHandshake()
      return
    }

    // The inner carrier reconnects on its own, but a Noise session cannot
    // survive the gap: its keys are bound to one handshake and its counters
    // to one stream. So a drop restarts the handshake rather than resuming,
    // which is also why split() must never be called twice.
    this.#transport?.close()
    this.#transport = null
    this.#awaitingReply = false
    this.#setStatus(s)
  }

  #beginHandshake(): void {
    if (this.#closed || this.#awaitingReply || this.#transport) return

    // A fresh handshake per connection. Reusing the old one would mint a
    // second cipher pair from the same chaining key — the same key at nonce
    // zero twice, which breaks ChaCha20-Poly1305 outright.
    this.#handshake = HandshakeState.initiator(this.#seed)

    this.#awaitingReply = true
    this.#setStatus({ phase: 'connecting' })

    this.#handshake
      .writeMessage(this.#payload)
      .then((msg) => this.#inner.send(msg))
      .catch((err) => this.#fail(err instanceof NoiseError ? err.message : 'handshake failed'))
  }

  #onInnerFrame(bytes: Uint8Array): void {
    if (this.#closed) return

    if (this.#awaitingReply) {
      this.#completeHandshake(bytes)
      return
    }

    if (!this.#transport) return

    const frame = this.#transport.decrypt(bytes)
    // A frame that fails to authenticate is dropped, not fatal. Anyone can
    // write to a relay socket, and letting a junk frame tear down a working
    // session would hand them a denial of service for free.
    if (frame) this.emitFrame(frame)
  }

  #completeHandshake(bytes: Uint8Array): void {
    const handshake = this.#handshake
    if (!handshake) return

    handshake
      .readMessage(bytes)
      .then(() => {
        // Guard against a close landing while the DH was in flight.
        if (this.#closed || this.#handshake !== handshake) return
        this.#transport = new NoiseTransport(handshake.split())
        this.#awaitingReply = false
        this.#handshake = null
        this.#setStatus({ phase: 'open', sinceMs: Date.now() })
      })
      .catch((err) => {
        // The commonest cause is the pinned key not matching what answered —
        // which is exactly the check working. Not retryable: dialling again
        // would meet the same wrong peer.
        this.#fail(err instanceof NoiseError ? err.message : 'handshake rejected', false)
      })
  }

  #setStatus(s: CarrierStatus): void {
    this.#status = s
    this.emitStatus(s)
  }

  #fail(reason: string, retryable = true): void {
    this.#transport?.close()
    this.#transport = null
    this.#awaitingReply = false
    this.#setStatus({ phase: 'closed', reason, retryable })
  }
}
