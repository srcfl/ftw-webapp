/* The carrier abstraction.
 *
 * A carrier moves opaque frames and nothing else. It does not know what a
 * watt is, cannot read a frame, and has no opinion about the protocol. That
 * is the point: the WebRTC LAN shortcut can be added later as one more
 * implementation, without a line changing above this interface.
 *
 * Three implementations are planned:
 *   relay   — default, and the only remote path
 *   cache   — reads the local projection when nothing reaches the box
 *   webrtc  — opportunistic LAN shortcut, deferred behind a measurement
 *
 * Cache is a carrier, not a failure state. Treating "we cannot reach the box"
 * as an error is what makes apps show a spinner instead of the readings they
 * already have.
 *
 * See docs/architecture.md.
 */

import type { CarrierState } from '$lib/protocol/types'

export type CarrierStatus =
  | { phase: 'connecting' }
  | { phase: 'open'; sinceMs: number }
  | { phase: 'closed'; reason: string; retryable: boolean }

export interface Carrier {
  readonly kind: CarrierState

  /** Round-trip estimate in ms, or null before one is known. */
  readonly rttMs: number | null

  readonly status: CarrierStatus

  send(frame: Uint8Array): void

  /** Returns an unsubscribe function. */
  onFrame(handler: (frame: Uint8Array) => void): () => void
  onStatus(handler: (status: CarrierStatus) => void): () => void

  /**
   * Recheck the live path after the app or network wakes.
   *
   * Frames are never replayed. A carrier that supports this starts a fresh
   * connection now instead of waiting for a stale socket or retry timer.
   */
  wake?(): void

  close(reason?: string): void
}

/**
 * Minimal listener bookkeeping, shared by every implementation.
 *
 * A handler that throws must not stop the others from running, or one bad
 * view could silently deafen the whole app to a carrier.
 */
export class CarrierBase {
  #frameHandlers = new Set<(frame: Uint8Array) => void>()
  #statusHandlers = new Set<(status: CarrierStatus) => void>()

  onFrame(handler: (frame: Uint8Array) => void): () => void {
    this.#frameHandlers.add(handler)
    return () => this.#frameHandlers.delete(handler)
  }

  onStatus(handler: (status: CarrierStatus) => void): () => void {
    this.#statusHandlers.add(handler)
    return () => this.#statusHandlers.delete(handler)
  }

  protected emitFrame(frame: Uint8Array): void {
    for (const h of this.#frameHandlers) {
      try {
        h(frame)
      } catch (err) {
        console.error('carrier frame handler threw', err)
      }
    }
  }

  protected emitStatus(status: CarrierStatus): void {
    for (const h of this.#statusHandlers) {
      try {
        h(status)
      } catch (err) {
        console.error('carrier status handler threw', err)
      }
    }
  }

  protected clearHandlers(): void {
    this.#frameHandlers.clear()
    this.#statusHandlers.clear()
  }
}
