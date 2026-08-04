/* Rendezvous handles.
 *
 * A handle is the name the box and the app both use to find each other on the
 * relay. It is the one piece of metadata the relay unavoidably sees, so what
 * it is made of decides how much the relay learns.
 *
 * A stable handle — say a hash of the box's static key — would work perfectly
 * and quietly hand the relay operator a household identifier good for years.
 * Every connection, every outage, every holiday, all joined up under one
 * string. docs/architecture.md promises the relay knows only "some opaque
 * handle is online", and a permanent handle turns that into a life history.
 *
 * So the handle is derived from the epoch:
 *
 *   handle = HKDF-SHA256(secret, info = "ftw/rendezvous/v1/<epoch>")[0..16]
 *
 * The secret is shared optically at enrollment, in the QR fragment, and never
 * travels through Sourceful. HKDF-Expand is a PRF, so without the secret the
 * handles of two epochs are two unrelated random strings: there is no function
 * the relay can compute that links them.
 *
 * How the client learns the next handle without the relay linking the epochs:
 * it does not learn it, it derives it. The relay is not in that loop at all.
 * The only thing it contributes is the epoch *number*, which it announces to
 * everyone equally and already knows, because it is its own clock. That is why
 * the derivation lives here and not in relay/ — the relay cannot compute a
 * handle even if it wanted to, and the directory listing proves it.
 *
 * What this does not hide: at a rotation the relay sees one handle go quiet
 * and another appear a moment later, so a relay watching the clock can
 * correlate across a single boundary by timing. Peers rejoin after a random
 * delay to blur that, and the honest claim is the one worth making — the relay
 * cannot follow a household across months from an identifier we handed it.
 */

import { hkdf } from '@noble/hashes/hkdf.js'
import { sha256 } from '@noble/hashes/sha2.js'
import { bytesToHex } from '@noble/hashes/utils.js'

/**
 * How long a handle lives.
 *
 * An hour is short enough that a handle is not a household identifier and long
 * enough that rotations are rare next to the reconnects a phone does anyway.
 * The relay holds the same number; they disagreeing costs one round trip, not
 * correctness, because the relay corrects a wrong guess. See relay/src/epoch.ts.
 */
export const EPOCH_MS = 3_600_000

/** 128 bits. Long enough that handles never collide, short enough for a URL. */
export const HANDLE_BYTES = 16

/** Hex, so a handle is `HANDLE_BYTES * 2` characters. */
export const HANDLE_CHARS = HANDLE_BYTES * 2

/**
 * The epoch a peer will guess from its own clock.
 *
 * A guess, not an answer: the relay is the authority and says so in the close
 * reason when this is wrong. A box with a dead RTC reads 1970, guesses epoch 0
 * and is corrected on its first connect.
 */
export function currentEpoch(nowMs: number = Date.now()): number {
  return Math.floor(nowMs / EPOCH_MS)
}

export function rendezvousHandle(secret: Uint8Array, epoch: number): string {
  if (secret.length < 16) {
    throw new Error('rendezvous secret is too short to be a secret')
  }
  const info = new TextEncoder().encode(`ftw/rendezvous/v1/${epoch}`)
  return bytesToHex(hkdf(sha256, secret, undefined, info, HANDLE_BYTES))
}
