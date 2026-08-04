/* The encrypted channel, once the handshake is done.
 *
 * One frame in, one transport message out:
 *
 *   offset  field       note
 *   0       seq   u64BE  cleartext, authenticated as associated data
 *   8       body        ChaCha20-Poly1305 over the frame, tag included
 *
 * Why a sequence number is on the wire at all: Noise's own counter is implicit
 * and assumes an ordered, lossless carrier. The relay is a WebSocket and gives
 * us that, but the LAN carrier is a WebRTC DataChannel, which may reorder and
 * may drop. Carrying the counter lets the receiver set the nonce for whatever
 * actually arrived, so the same code serves both carriers and a lost frame
 * costs one frame instead of the session.
 *
 * The eight bytes are a monotonic counter and nothing else. Frame size stays
 * constant, which is the property lane 0 depends on.
 *
 * Where the asynchronous boundary is: nothing in this file waits. encrypt and
 * decrypt are pure CPU, microseconds each. The waiting is in the carrier, and
 * a handshake is two carrier round trips — which is why it can run behind
 * already-painted cached readings instead of in front of them. Nothing here
 * belongs on the first-frame path.
 */

import { CipherState, NoiseError, TAG_BYTES, type HandshakeResult } from './noise'

export const SEQ_BYTES = 8
export const TRANSPORT_OVERHEAD = SEQ_BYTES + TAG_BYTES

/**
 * How far out of order a frame may arrive and still be accepted.
 *
 * At 1 Hz on lane 0, 64 frames is a minute of tolerance — far beyond any
 * reordering a DataChannel produces, and small enough that the window is one
 * machine word.
 */
export const REPLAY_WINDOW = 64

const WINDOW = BigInt(REPLAY_WINDOW)
const WINDOW_MASK = (1n << WINDOW) - 1n

function writeSeq(seq: bigint): Uint8Array {
  const out = new Uint8Array(SEQ_BYTES)
  let v = seq
  for (let i = SEQ_BYTES - 1; i >= 0; i--) {
    out[i] = Number(v & 0xffn)
    v >>= 8n
  }
  return out
}

function readSeq(bytes: Uint8Array): bigint {
  let v = 0n
  for (let i = 0; i < SEQ_BYTES; i++) v = (v << 8n) | BigInt(bytes[i]!)
  return v
}

/**
 * A live Noise session: two directional keys, a counter, and a replay window.
 *
 * This is what NoiseCarrier wraps. It knows nothing about frames beyond their
 * being bytes, so the frame codec and this can change independently.
 */
export class NoiseTransport {
  readonly handshakeHash: Uint8Array
  /** The box's static key as authenticated by the handshake, not as claimed. */
  readonly remoteStatic: Uint8Array

  #send: CipherState
  #recv: CipherState
  #highestSeq = -1n
  #seen = 0n
  #closed = false

  constructor(result: HandshakeResult) {
    this.#send = result.send
    this.#recv = result.recv
    this.handshakeHash = result.handshakeHash
    this.remoteStatic = result.remoteStatic
  }

  /** Sequence number the next outgoing frame will carry. */
  get nextSeq(): bigint {
    return this.#send.nonce
  }

  encrypt(frame: Uint8Array): Uint8Array {
    this.#assertOpen()
    const seq = writeSeq(this.#send.nonce)
    // Throws rather than wrapping the counter. See CipherState.
    const body = this.#send.encryptWithAd(seq, frame)

    const out = new Uint8Array(SEQ_BYTES + body.length)
    out.set(seq, 0)
    out.set(body, SEQ_BYTES)
    return out
  }

  decrypt(bytes: Uint8Array): Uint8Array {
    this.#assertOpen()
    if (bytes.length < TRANSPORT_OVERHEAD) {
      throw new NoiseError(`transport message is ${bytes.length} bytes`, 'E_NOISE_MESSAGE')
    }

    const seqBytes = bytes.subarray(0, SEQ_BYTES)
    const seq = readSeq(seqBytes)
    this.#checkReplay(seq)

    this.#recv.setNonce(seq)
    // Authenticates the sequence number along with the frame, so an attacker
    // cannot renumber a captured message into the acceptable window.
    const frame = this.#recv.decryptWithAd(seqBytes, bytes.subarray(SEQ_BYTES))

    // Only a frame that authenticated moves the window. Otherwise anyone able
    // to inject bytes could burn sequence numbers and lock out the real box.
    this.#markSeen(seq)
    return frame
  }

  /** Drop both keys. After this the session is unusable, which is the point. */
  close(): void {
    this.#closed = true
    this.#send.destroy()
    this.#recv.destroy()
  }

  #assertOpen(): void {
    if (this.#closed) throw new NoiseError('session is closed', 'E_NOISE_CLOSED')
  }

  #checkReplay(seq: bigint): void {
    if (seq > this.#highestSeq) return

    const behind = this.#highestSeq - seq
    if (behind >= WINDOW) {
      throw new NoiseError(`sequence ${seq} is outside the replay window`, 'E_NOISE_REPLAY')
    }
    if ((this.#seen >> behind) & 1n) {
      throw new NoiseError(`sequence ${seq} was already accepted`, 'E_NOISE_REPLAY')
    }
  }

  #markSeen(seq: bigint): void {
    if (seq > this.#highestSeq) {
      const shift = seq - this.#highestSeq
      this.#seen = shift >= WINDOW ? 1n : ((this.#seen << shift) | 1n) & WINDOW_MASK
      this.#highestSeq = seq
      return
    }
    this.#seen |= 1n << (this.#highestSeq - seq)
  }
}
