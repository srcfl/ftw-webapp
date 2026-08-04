/* The epoch clock.
 *
 * The relay is the authority on which epoch it is, and that is the whole of
 * its involvement in rendezvous. Peers guess the epoch from their own clock
 * and put the guess in the join path; a wrong guess is answered with the right
 * number in the close reason. Disagreement therefore costs one round trip and
 * never correctness — which matters, because a box on a Pi reads 1970 until
 * NTP answers.
 *
 * Note what is not in this directory: the handle derivation. The relay cannot
 * compute a handle, because that needs the secret the box and the app swapped
 * optically at enrollment. Keeping it out is not tidiness, it is the argument.
 * See src/lib/carrier/rendezvous.ts and relay/README.md.
 *
 * The constant is duplicated from src/lib/carrier/rendezvous.ts rather than
 * imported, so this server has no dependency on the app. A test asserts the
 * two agree.
 */

export const EPOCH_MS = 3_600_000

export function currentEpoch(nowMs: number): number {
  return Math.floor(nowMs / EPOCH_MS)
}
