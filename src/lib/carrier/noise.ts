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
import { DH_BYTES, TAG_BYTES, HandshakeState, NoiseError, type StaticKey, type KeyPair } from '$lib/crypto/noise'
import { NoiseTransport } from '$lib/crypto/transport'

/**
 * How long a handshake may go unanswered before it is retried.
 *
 * The box answers a refused handshake with silence rather than a rejection,
 * so this is the only thing that distinguishes "not yet" from "never".
 */
const HANDSHAKE_DEADLINE_MS = 12_000

/**
 * Retry pacing for a handshake that timed out on a healthy socket.
 *
 * The inner carrier redials a dead socket on its own, but it never re-emits
 * 'open' on one that stayed up — and a box rebooting through an update says
 * nothing while its socket stands. Without a retry here, one silent handshake
 * would leave the app closed until the epoch rotates. Full jitter, like the
 * relay's dial backoff, and capped so a revoked phone — deliberate silence,
 * forever — costs one 48-byte message a minute at worst.
 */
const HANDSHAKE_BACKOFF_BASE_MS = 3_000
const HANDSHAKE_BACKOFF_CAP_MS = 60_000

/**
 * Message 2 of Noise_IK: the responder's ephemeral public key and one AEAD
 * tag over an empty payload. Fixed by the pattern, so anything else on the
 * wire is somebody else's frame.
 */
const MESSAGE_2_BYTES = DH_BYTES + TAG_BYTES

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
  #deadline: ReturnType<typeof setTimeout> | undefined
  #retry: ReturnType<typeof setTimeout> | undefined
  #attempt = 0
  #log: ((line: string) => void) | undefined

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

    clearTimeout(this.#deadline)
    this.#clearRetry()
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
      this.#attempt = 0
      this.#clearRetry()
      this.#beginHandshake()
      return
    }

    // The inner carrier reconnects on its own, but a Noise session cannot
    // survive the gap: its keys are bound to one handshake and its counters
    // to one stream. So a drop restarts the handshake rather than resuming,
    // which is also why split() must never be called twice. A pending retry
    // is cancelled too — its socket is gone, and the reconnect ends in an
    // 'open' that starts a fresh handshake at once.
    this.#transport?.close()
    this.#transport = null
    this.#awaitingReply = false
    this.#clearRetry()
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

    // A box that refuses a handshake answers with silence, on purpose: a
    // reply would confirm a box is on this handle. So silence needs its own
    // ending, or a revoked phone sits on "Reaching your box" forever with the
    // socket wide open and no reconnect ever firing.
    clearTimeout(this.#deadline)
    this.#deadline = setTimeout(() => {
      if (this.#closed || !this.#awaitingReply) return
      this.#fail('the box did not answer', true)
    }, HANDSHAKE_DEADLINE_MS)

    this.#handshake
      .writeMessage(this.#payload)
      .then((msg) => this.#inner.send(msg))
      .catch((err) => this.#fail(err instanceof NoiseError ? err.message : 'handshake failed'))
  }

  #onInnerFrame(bytes: Uint8Array): void {
    if (this.#closed) return

    if (this.#awaitingReply) {
      // Only something the right shape is offered to the handshake.
      //
      // The relay broadcasts the box's frames to every stream in the room, so
      // a second phone in the same house starts its handshake into a running
      // 1 Hz telemetry stream. Those frames are not message 2, and feeding
      // them to readMessage used to kill the carrier outright — a household
      // where the first phone works and the second never can. It also handed
      // anyone who can write to the socket a one-packet kill switch.
      if (bytes.length === MESSAGE_2_BYTES) this.#completeHandshake(bytes)
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
        this.#attempt = 0
        this.#setStatus({ phase: 'open', sinceMs: Date.now() })
      })
      .catch((err) => {
        // Still not fatal, even at the right length: on a shared room another
        // phone's transport frame can match by coincidence. A frame that does
        // not open is a frame addressed to somebody else — drop it and keep
        // waiting. The deadline below is what ends a handshake that is truly
        // going nowhere, and it ends it retryably.
        if (this.#closed || this.#handshake !== handshake) return
        this.#log?.(err instanceof NoiseError ? err.message : 'handshake frame ignored')
      })
  }

  #setStatus(s: CarrierStatus): void {
    this.#status = s
    this.emitStatus(s)
  }

  #fail(reason: string, retryable = true): void {
    if (this.#closed) return
    this.#transport?.close()
    this.#transport = null
    this.#awaitingReply = false
    this.#setStatus({ phase: 'closed', reason, retryable })

    // A retryable failure on a socket that still stands is retried from here,
    // because nowhere else will: nothing above consumes `retryable`, and the
    // inner carrier only re-emits 'open' after an actual reconnect. Between
    // attempts the status stays closed-and-retryable, which is the truth.
    if (!retryable || this.#inner.status.phase !== 'open') return
    this.#clearRetry()
    const ceiling = Math.min(HANDSHAKE_BACKOFF_CAP_MS, HANDSHAKE_BACKOFF_BASE_MS * 2 ** this.#attempt)
    this.#attempt = Math.min(this.#attempt + 1, 16)
    this.#retry = setTimeout(() => {
      this.#retry = undefined
      this.#beginHandshake()
    }, Math.random() * ceiling)
  }

  #clearRetry(): void {
    clearTimeout(this.#retry)
    this.#retry = undefined
  }
}
