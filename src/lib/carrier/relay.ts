/* The relay carrier.
 *
 * A WebSocket to Sourceful's blind relay, wrapped so that nothing above it
 * ever learns the network went away. There is no reconnect button anywhere in
 * this app, and there is no place to put one: a lost connection is this file's
 * problem, and the only thing the user sees is the freshness stamp slipping
 * behind while it is being solved.
 *
 * Two rules do most of the work.
 *
 * Frames are never queued across a reconnect. A frame held through an outage
 * and delivered afterwards is an old instruction arriving as if it were new,
 * which is the failure `notValidAfterMs` exists to prevent — so `send` on a
 * carrier that is not open drops the frame and says nothing. The session above
 * re-handshakes when the carrier comes back, and asks again for whatever it
 * still wants.
 *
 * The socket outlives the peer. When the box drops off the relay, the socket
 * stays up and the carrier reports `closed` — the honest state, since no frame
 * is reaching us — and goes back to `open` the moment the relay says the box
 * is back. A box that is offline for an hour therefore costs one connection,
 * not sixty.
 *
 * See relay/README.md for what sits at the other end.
 */

import { CarrierBase, type Carrier, type CarrierStatus } from './carrier'
import { currentEpoch, rendezvousHandle } from './rendezvous'
import type { CarrierState } from '$lib/protocol/types'

/**
 * The relay's close codes and control words.
 *
 * Held here rather than imported from relay/ so the app builds without the
 * server beside it. tests/relay-contract.test.ts fails if they drift.
 */
export const CLOSE_BAD_JOIN = 4400
export const CLOSE_EPOCH = 4409
export const CLOSE_ROTATED = 4410
export const CLOSE_BUSY = 4429
export const CTRL_READY = 'ready'
export const CTRL_GONE = 'gone'

/** First retry lands somewhere in the first half second. */
export const BACKOFF_BASE_MS = 500

/** A phone in a tunnel should not hammer, and should not sulk either. */
export const BACKOFF_CAP_MS = 60_000

/**
 * Spread over which peers rejoin after an epoch turns over.
 *
 * The relay closes both ends at once, so without this it would watch one
 * handle go quiet and another appear in the same millisecond, and could link
 * the two epochs by timing alone. This does not make that impossible; it makes
 * it unreliable, which is the most a rotation can honestly claim.
 */
export const ROTATE_JITTER_MS = 3_000

/** Consecutive epoch corrections before we stop retrying immediately. */
const CORRECTION_LIMIT = 2

/**
 * How far the relay may move our epoch, in epochs.
 *
 * One hour either way covers a phone whose clock drifted or that woke across
 * a boundary — the cases a correction genuinely exists for. It does not cover
 * a relay steering us onto handles of its choosing.
 */
const MAX_EPOCH_CORRECTION = 1

export interface RelayCarrierOptions {
  /** Relay origin, e.g. `wss://relay.sourceful.energy`. No path. */
  url: string
  /** Shared with the box optically at enrollment. Never sent anywhere. */
  secret: Uint8Array
  /** Injected by tests. Defaults to the platform WebSocket. */
  WebSocketImpl?: typeof WebSocket
  now?: () => number
  random?: () => number
}

export class RelayCarrier extends CarrierBase implements Carrier {
  readonly kind: CarrierState = 'relay'

  #url: string
  #secret: Uint8Array
  #WS: typeof WebSocket
  #now: () => number
  #random: () => number

  #ws: WebSocket | null = null
  #status: CarrierStatus = { phase: 'connecting' }
  #rttMs: number | null = null
  #dialledAtMs = 0
  #attempt = 0
  #corrections = 0
  /**
   * Epochs between the relay's clock and ours, learned from a correction.
   *
   * An offset rather than a remembered epoch number, so it stays right as time
   * passes instead of going stale the moment the hour turns. A device with a
   * working clock carries zero here for its whole life.
   */
  #epochOffset = 0
  #retry: ReturnType<typeof setTimeout> | null = null
  #shutdown = false

  constructor(opts: RelayCarrierOptions) {
    super()
    this.#url = opts.url.replace(/\/+$/, '')
    this.#secret = opts.secret
    this.#WS = opts.WebSocketImpl ?? globalThis.WebSocket
    this.#now = opts.now ?? (() => Date.now())
    this.#random = opts.random ?? Math.random

    globalThis.addEventListener?.('online', this.#wake)
    globalThis.addEventListener?.('visibilitychange', this.#wake)

    this.#dial()
  }

  /**
   * Time to reach the relay, not to reach the box.
   *
   * Measuring the far leg would mean adding a message to the wire for a number
   * no screen shows. Freshness comes from source timestamps, never from this.
   */
  get rttMs(): number | null {
    return this.#rttMs
  }

  get status(): CarrierStatus {
    return this.#status
  }

  send(frame: Uint8Array): void {
    if (this.#status.phase !== 'open') return
    const ws = this.#ws
    if (!ws || ws.readyState !== 1) return
    ws.send(frame)
  }

  close(reason = 'closed by client'): void {
    if (this.#shutdown) return
    this.#shutdown = true

    globalThis.removeEventListener?.('online', this.#wake)
    globalThis.removeEventListener?.('visibilitychange', this.#wake)

    if (this.#retry !== null) clearTimeout(this.#retry)
    this.#retry = null

    this.#drop()
    this.#setStatus({ phase: 'closed', reason, retryable: false })
    this.clearHandlers()
  }

  #dial(): void {
    if (this.#shutdown) return

    const epoch = currentEpoch(this.#now()) + this.#epochOffset
    const handle = rendezvousHandle(this.#secret, epoch)

    this.#setStatus({ phase: 'connecting' })
    this.#dialledAtMs = this.#now()

    const ws = new this.#WS(`${this.#url}/r/${epoch}/${handle}/app`)
    ws.binaryType = 'arraybuffer'
    this.#ws = ws

    ws.onopen = () => {
      this.#rttMs = this.#now() - this.#dialledAtMs
    }
    ws.onmessage = (ev: MessageEvent) => this.#onMessage(ev)
    ws.onclose = (ev: CloseEvent) => this.#onClose(ws, ev.code, ev.reason)
    // Every error is followed by a close, which is where recovery lives. A
    // handler is attached anyway so the event is not reported as unhandled.
    ws.onerror = () => {}
  }

  #onMessage(ev: MessageEvent): void {
    if (typeof ev.data === 'string') {
      if (ev.data === CTRL_READY) {
        this.#attempt = 0
        this.#corrections = 0
        this.#setStatus({ phase: 'open', sinceMs: this.#now() })
      } else if (ev.data === CTRL_GONE) {
        // The box left. Keep the socket; the relay will say when it is back.
        this.#setStatus({ phase: 'closed', reason: 'box offline', retryable: true })
      }
      return
    }

    if (this.#status.phase !== 'open') return
    this.emitFrame(new Uint8Array(ev.data as ArrayBuffer))
  }

  #onClose(ws: WebSocket, code: number, reason: string): void {
    if (this.#shutdown || ws !== this.#ws) return
    this.#ws = null
    this.#rttMs = null

    let delayMs: number
    if (code === CLOSE_ROTATED) {
      this.#adoptEpoch(reason)
      // Rejoin at a random point in the window rather than the instant the
      // relay closed us, so the old handle and the new one are harder to line
      // up by timing alone.
      delayMs = this.#random() * ROTATE_JITTER_MS
    } else if (code === CLOSE_EPOCH) {
      this.#adoptEpoch(reason)
      this.#corrections += 1
      // Straight back with the right number. Backing off only once the relay
      // keeps rejecting, which means something is wrong rather than stale.
      delayMs = this.#corrections > CORRECTION_LIMIT ? this.#backoff() : 0
    } else {
      delayMs = this.#backoff()
    }

    this.#setStatus({ phase: 'closed', reason: closeReason(code), retryable: true })
    this.#schedule(delayMs)
  }

  /**
   * Take the relay's announced epoch as a clock correction, never as an order.
   *
   * The handle is derived from the epoch, so a relay that can name any epoch
   * can make us compute and publish handle(secret, N) for every N it likes —
   * building a table of this household's future handles that survives any
   * later fix, because the secret cannot be rotated remotely. Worse,
   * Number('') is 0: a single close with an empty reason would pin us to one
   * handle forever, which is precisely the permanent identifier rotation
   * exists to prevent.
   *
   * So: parse strictly, and only accept a correction small enough to be a real
   * clock difference. Anything larger is the relay asking for something it has
   * no business asking for, and we keep our own epoch instead.
   */
  #adoptEpoch(announced: string): void {
    // Number('') is 0 and Number(' 3 ') is 3; neither is an epoch.
    if (!/^-?\d+$/.test(announced.trim())) return

    const epoch = Number(announced.trim())
    if (!Number.isSafeInteger(epoch)) return

    const offset = epoch - currentEpoch(this.#now())
    if (Math.abs(offset) > MAX_EPOCH_CORRECTION) return

    this.#epochOffset = offset
  }

  /** Full jitter: the whole delay is random, so peers never resynchronise. */
  #backoff(): number {
    const ceiling = Math.min(BACKOFF_CAP_MS, BACKOFF_BASE_MS * 2 ** this.#attempt)
    this.#attempt = Math.min(this.#attempt + 1, 16)
    return this.#random() * ceiling
  }

  #schedule(delayMs: number): void {
    if (this.#retry !== null) clearTimeout(this.#retry)
    this.#retry = setTimeout(() => {
      this.#retry = null
      this.#dial()
    }, delayMs)
  }

  /**
   * The network came back, or the user opened the app.
   *
   * Waiting out a sixty-second backoff after the phone leaves a tunnel is the
   * difference between an app that feels alive and one the user reloads.
   *
   * A hidden document is left alone. Nobody is looking, the backoff will get
   * there on its own, and the visibility handler beats it to the retry the
   * moment anyone does look.
   */
  #wake = (): void => {
    if (this.#shutdown || this.#retry === null) return
    if (typeof document !== 'undefined' && document.visibilityState === 'hidden') return
    clearTimeout(this.#retry)
    this.#retry = null
    this.#attempt = 0
    this.#dial()
  }

  #drop(): void {
    const ws = this.#ws
    this.#ws = null
    if (!ws) return
    ws.onopen = null
    ws.onmessage = null
    ws.onclose = null
    ws.onerror = null
    if (ws.readyState === 0 || ws.readyState === 1) ws.close()
  }

  #setStatus(status: CarrierStatus): void {
    if (status.phase === this.#status.phase) {
      if (status.phase !== 'closed') return
      if (this.#status.phase === 'closed' && this.#status.reason === status.reason) return
    }
    this.#status = status
    this.emitStatus(status)
  }
}

function closeReason(code: number): string {
  switch (code) {
    case CLOSE_EPOCH:
    case CLOSE_ROTATED:
      return 'rendezvous rotated'
    case CLOSE_BUSY:
      return 'relay is busy'
    case CLOSE_BAD_JOIN:
      return 'relay rejected the join'
    default:
      return 'connection lost'
  }
}
