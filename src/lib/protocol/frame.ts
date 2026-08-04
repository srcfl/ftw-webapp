/* Frame codec.
 *
 * Each Noise transport message carries exactly one frame:
 *
 *   offset  field    type     note
 *   0       ver      u8       frame layout version
 *   1       lane     u8       0 = telemetry/control, 1 = bulk
 *   2       flags    u8       0x02 TRUNC
 *   3       rsvd     u8       0
 *   4       len      u16 BE   payload bytes
 *   6       payload  u8[len]  CBOR
 *   6+len   pad      u8[]     zeros to the bucket size
 *
 * Padding is a privacy control, not alignment. A 1 Hz power stream whose
 * frame length varies with what happened in the house leaks the load
 * pattern — when people wake, cook, leave, come home — straight to the
 * relay operator, through otherwise perfect encryption. So lane 0 frames
 * are always exactly one bucket and never fragment, whether or not
 * anything changed.
 *
 * See docs/protocol.md.
 */

import { encode as cborEncode, decode as cborDecode } from 'cbor2'

export const FRAME_VERSION = 1
export const HEADER_BYTES = 6
export const MAX_PAYLOAD = 0xffff

export const LANE_CONTROL = 0
export const LANE_BULK = 1

/** The delta did not fit its bucket; the rest follows next tick. */
export const FLAG_TRUNC = 0x02

/**
 * Lane 0 is one fixed size for the life of a session. Lane 1 steps, because
 * bulk already leaks that a transfer is happening — which is unavoidable and
 * harmless. What must not leak is the telemetry stream.
 */
export const CONTROL_BUCKETS = [256, 512] as const
export const BULK_BUCKETS = [1024, 4096, 16384] as const

export type ControlBucket = (typeof CONTROL_BUCKETS)[number]
export type BulkBucket = (typeof BULK_BUCKETS)[number]

export interface Envelope {
  /** Message type. Stable string; see docs/protocol.md. */
  t: string
  /** Request id, u32. Replies echo it. */
  id?: number
  b?: unknown
}

export interface Frame {
  lane: number
  flags: number
  envelope: Envelope
}

export class FrameError extends Error {
  constructor(
    message: string,
    readonly code: string
  ) {
    super(message)
    this.name = 'FrameError'
  }
}

/** Smallest bulk bucket that fits, or null when the payload is too large. */
export function bulkBucketFor(payloadBytes: number): BulkBucket | null {
  const needed = payloadBytes + HEADER_BYTES
  return BULK_BUCKETS.find((b) => b >= needed) ?? null
}

/**
 * Encode one frame, zero-padded to `bucket`.
 *
 * Throws rather than growing the bucket: silently emitting a larger frame
 * would defeat the padding entirely, and a caller that overruns lane 0 has a
 * bug worth surfacing at the point it happens.
 */
export function encodeFrame(frame: Frame, bucket: number): Uint8Array {
  const payload = cborEncode(frame.envelope)

  if (payload.length > MAX_PAYLOAD) {
    throw new FrameError(`payload ${payload.length} exceeds u16 length field`, 'E_FRAME_TOO_LARGE')
  }

  const needed = HEADER_BYTES + payload.length
  if (needed > bucket) {
    throw new FrameError(
      `frame needs ${needed} bytes, bucket is ${bucket}`,
      'E_FRAME_EXCEEDS_BUCKET'
    )
  }

  const out = new Uint8Array(bucket) // zero-filled, which is the padding
  out[0] = FRAME_VERSION
  out[1] = frame.lane
  out[2] = frame.flags
  out[3] = 0
  new DataView(out.buffer).setUint16(4, payload.length, false)
  out.set(payload, HEADER_BYTES)

  return out
}

/**
 * Decode one frame. Everything past `len` is ignored without inspection —
 * the padding is already covered by AEAD, so validating it would only add a
 * way to reject a frame that is fine.
 */
export function decodeFrame(bytes: Uint8Array): Frame {
  if (bytes.length < HEADER_BYTES) {
    throw new FrameError(`frame is ${bytes.length} bytes, need at least ${HEADER_BYTES}`, 'E_FRAME_SHORT')
  }

  const ver = bytes[0]!
  if (ver !== FRAME_VERSION) {
    throw new FrameError(`unsupported frame version ${ver}`, 'E_FRAME_VERSION')
  }

  const lane = bytes[1]!
  const flags = bytes[2]!
  const len = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint16(4, false)

  if (HEADER_BYTES + len > bytes.length) {
    throw new FrameError(
      `declared length ${len} overruns the ${bytes.length}-byte frame`,
      'E_FRAME_TRUNCATED'
    )
  }

  const payload = bytes.subarray(HEADER_BYTES, HEADER_BYTES + len)

  let envelope: unknown
  try {
    envelope = cborDecode(payload)
  } catch (cause) {
    throw new FrameError(`payload is not valid CBOR: ${String(cause)}`, 'E_FRAME_CBOR')
  }

  if (typeof envelope !== 'object' || envelope === null || Array.isArray(envelope)) {
    throw new FrameError('envelope must be a CBOR map', 'E_FRAME_ENVELOPE')
  }

  const env = envelope as Record<string, unknown>
  if (typeof env['t'] !== 'string') {
    throw new FrameError('envelope is missing a string type', 'E_FRAME_ENVELOPE')
  }

  // Unknown keys are carried through, not rejected. This is what lets a newer
  // box talk to an app pinned in a service worker, and the reverse.
  const out: Frame = {
    lane,
    flags,
    envelope: { t: env['t'], ...(typeof env['id'] === 'number' ? { id: env['id'] } : {}), b: env['b'] },
  }

  return out
}

/** Does this frame's payload continue in a later one? */
export function isTruncated(frame: Frame): boolean {
  return (frame.flags & FLAG_TRUNC) !== 0
}
