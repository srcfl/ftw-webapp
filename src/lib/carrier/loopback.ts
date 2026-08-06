/* Loopback carrier — connects the app to a SimBox in the same process.
 *
 * Used for development, tests and demos. It implements the same interface as
 * the relay carrier, so nothing above it can tell the difference, which is
 * the point: if the app works here it works over the wire, because it is the
 * same wire.
 *
 * `latencyMs` is not decoration. At zero latency every response arrives
 * before the UI has painted the pending state, so the whole optimistic path
 * — sending, ack, confirmed, unconfirmed — goes untested and looks perfect.
 */

import { CarrierBase, type Carrier, type CarrierStatus } from './carrier'
import type { CarrierState } from '$lib/protocol/types'
import type { SimBox } from '$lib/sim/box'

export interface LoopbackOptions {
  /** One-way delay. The relay in production sits around 100–300 ms. */
  latencyMs?: number
  /** What the app should believe it is connected over. */
  kind?: CarrierState
}

export class LoopbackCarrier extends CarrierBase implements Carrier {
  readonly kind: CarrierState

  #box: SimBox
  #latencyMs: number
  #status: CarrierStatus = { phase: 'connecting' }
  #unsubscribe: (() => void) | null = null
  #timers = new Set<ReturnType<typeof setTimeout>>()

  constructor(box: SimBox, opts: LoopbackOptions = {}) {
    super()
    this.#box = box
    this.#latencyMs = opts.latencyMs ?? 120
    this.kind = opts.kind ?? 'relay'

    this.#listen()
    this.#open()
  }

  get rttMs(): number | null {
    return this.#status.phase === 'open' ? this.#latencyMs * 2 : null
  }

  get status(): CarrierStatus {
    return this.#status
  }

  send(frame: Uint8Array): void {
    if (this.#status.phase === 'closed') return
    this.#defer(() => this.#box.receive(frame))
  }

  close(reason = 'closed by client'): void {
    if (this.#status.phase === 'closed') return

    this.#cut(reason, false)
    this.clearHandlers()
  }

  /**
   * Lose the wire without tearing the carrier down.
   *
   * This is how a connection goes away in the field, and it is a different
   * event from `close()`. Something drops the socket; the carrier reports
   * `closed` with `retryable` set, keeps its handlers, and comes back on its
   * own — `RelayCarrier.#onClose` in one line. `close()` is the app shutting
   * the whole thing down on purpose, and nothing comes back from it.
   *
   * Frames in flight are lost, as they are over a real socket, and `send`
   * drops whatever is handed to it while the wire is down.
   */
  drop(reason = 'wire dropped'): void {
    if (this.#status.phase === 'closed') return
    this.#cut(reason, true)
  }

  /** The wire comes back. The session re-handshakes over it, as in the field. */
  restore(): void {
    if (this.#status.phase !== 'closed') return
    // A carrier the app closed has no handlers left to talk to, so there is
    // nothing here to bring back.
    if (!this.#status.retryable) return

    this.#listen()
    this.#open()
  }

  #listen(): void {
    this.#unsubscribe = this.#box.onFrame((frame) => {
      this.#defer(() => this.emitFrame(frame))
    })
  }

  #open(): void {
    this.#defer(() => {
      this.#status = { phase: 'open', sinceMs: Date.now() }
      this.emitStatus(this.#status)
    })
  }

  #cut(reason: string, retryable: boolean): void {
    this.#unsubscribe?.()
    this.#unsubscribe = null

    for (const t of this.#timers) clearTimeout(t)
    this.#timers.clear()

    this.#status = { phase: 'closed', reason, retryable }
    this.emitStatus(this.#status)
  }

  #defer(fn: () => void): void {
    const t = setTimeout(() => {
      this.#timers.delete(t)
      fn()
    }, this.#latencyMs)
    this.#timers.add(t)
  }
}
