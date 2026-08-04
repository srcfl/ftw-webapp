/* Rate limiting that keeps no record of who was limited.
 *
 * The ordinary way to limit a service is a table keyed by client address. That
 * table is a log of who connected and when — the exact thing this relay exists
 * not to have. So there are two mechanisms here, and neither one is a table.
 *
 * TokenBucket lives on the socket it limits and is collected with it. Nothing
 * is keyed by anything; a closed connection leaves no trace.
 *
 * AttemptCounter has to outlive the socket, because a flood is many short
 * connections rather than one loud one. It stores counts in a fixed array of
 * slots indexed by a keyed hash of the caller's address. The key is drawn from
 * the OS at the start of each window and thrown away with the counts at the
 * end, so the array cannot be turned back into a list of addresses and does
 * not survive the window. Slots collide, which means a heavy caller shares a
 * limit with whoever hashes alongside them. That is the price of not keeping
 * the list, and it is paid deliberately.
 */

import { createHmac, randomBytes } from 'node:crypto'

/** Per-socket allowance. Refills continuously; state dies with the socket. */
export class TokenBucket {
  #tokens: number
  #capacity: number
  #perMs: number
  #lastMs: number

  constructor(capacity: number, perSecond: number, nowMs: number) {
    this.#capacity = capacity
    this.#tokens = capacity
    this.#perMs = perSecond / 1000
    this.#lastMs = nowMs
  }

  /** True when the cost was affordable. False means the caller is over. */
  take(cost: number, nowMs: number): boolean {
    this.#tokens = Math.min(this.#capacity, this.#tokens + (nowMs - this.#lastMs) * this.#perMs)
    this.#lastMs = nowMs
    if (this.#tokens < cost) return false
    this.#tokens -= cost
    return true
  }
}

export interface AttemptCounterOptions {
  /** Connection attempts allowed per slot per window. */
  limit: number
  windowMs: number
  /** More slots means fewer collisions and a larger array. 1024 is 2 kB. */
  slots?: number
}

/**
 * Connection attempts per window, counted without keeping addresses.
 *
 * Deliberately not a sketch with several rows: extra rows buy accuracy by
 * making the structure a better index of who was here, which is the wrong
 * direction for this component.
 */
export class AttemptCounter {
  #limit: number
  #windowMs: number
  #counts: Uint16Array
  #key: Uint8Array
  #windowEndsAtMs: number

  constructor(opts: AttemptCounterOptions, nowMs: number) {
    this.#limit = opts.limit
    this.#windowMs = opts.windowMs
    this.#counts = new Uint16Array(opts.slots ?? 1024)
    this.#key = randomBytes(32)
    this.#windowEndsAtMs = nowMs + opts.windowMs
  }

  /** True when the attempt is allowed. */
  allow(address: string, nowMs: number): boolean {
    if (nowMs >= this.#windowEndsAtMs) this.#roll(nowMs)

    const slot = this.#slot(address)
    const count = this.#counts[slot]!
    if (count >= this.#limit) return false
    this.#counts[slot] = count + 1
    return true
  }

  #roll(nowMs: number): void {
    this.#counts.fill(0)
    // A fresh key as well as fresh counts: without it the mapping from address
    // to slot would be stable for the life of the process, and a stable
    // mapping is a pseudonym.
    this.#key = randomBytes(32)
    this.#windowEndsAtMs = nowMs + this.#windowMs
  }

  #slot(address: string): number {
    const digest = createHmac('sha256', this.#key).update(address).digest()
    return digest.readUInt32BE(0) % this.#counts.length
  }
}
