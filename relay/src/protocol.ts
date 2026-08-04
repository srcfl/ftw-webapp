/* The relay's wire contract: three numbers and two words.
 *
 * Everything the relay ever says to a peer is in this file. Close codes carry
 * the reason a socket ended, and the two control words say whether the other
 * side of the room is present. There is no relay message with a body, which is
 * why the routing path never has to interpret anything.
 *
 * The carrier holds its own copy of these rather than importing them, so the
 * relay can be deployed and audited without the app beside it.
 * tests/relay-contract.test.ts fails if the two copies drift.
 */

/** Malformed join path, text on a binary channel, or an oversize message. */
export const CLOSE_BAD_JOIN = 4400

/** The join named the wrong epoch. The reason carries the right one. */
export const CLOSE_EPOCH = 4409

/** The epoch turned over. The reason carries the new one. */
export const CLOSE_ROTATED = 4410

/** Rate limited, room occupied, or the process is at its ceiling. */
export const CLOSE_BUSY = 4429

/** The other side of the room is present; a session can start. */
export const CTRL_READY = 'ready'

/** The other side left. The socket stays up and waits for it to come back. */
export const CTRL_GONE = 'gone'

/** A rendezvous handle is 128 bits in hex. See src/lib/carrier/rendezvous.ts. */
export const HANDLE_CHARS = 32
