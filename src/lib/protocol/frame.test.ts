import { describe, it, expect } from 'vitest'
import {
  encodeFrame,
  decodeFrame,
  bulkBucketFor,
  isTruncated,
  FrameError,
  FRAME_VERSION,
  HEADER_BYTES,
  LANE_CONTROL,
  LANE_BULK,
  FLAG_TRUNC,
  type Frame,
} from './frame'

const ctl = (envelope: Frame['envelope'], flags = 0): Frame => ({
  lane: LANE_CONTROL,
  flags,
  envelope,
})

describe('frame round trip', () => {
  it('preserves type, id and body', () => {
    const frame = ctl({ t: 'cmd.ack', id: 42, b: { leaseId: 'x', expiresAtMs: 1000 } })
    const decoded = decodeFrame(encodeFrame(frame, 512))

    expect(decoded.envelope.t).toBe('cmd.ack')
    expect(decoded.envelope.id).toBe(42)
    expect(decoded.envelope.b).toEqual({ leaseId: 'x', expiresAtMs: 1000 })
    expect(decoded.lane).toBe(LANE_CONTROL)
  })

  it('writes the declared header', () => {
    const bytes = encodeFrame(ctl({ t: 'tick' }), 512)
    expect(bytes[0]).toBe(FRAME_VERSION)
    expect(bytes[1]).toBe(LANE_CONTROL)
    expect(bytes[3]).toBe(0) // reserved
  })

  it('carries the truncation flag', () => {
    const decoded = decodeFrame(encodeFrame(ctl({ t: 'delta' }, FLAG_TRUNC), 512))
    expect(isTruncated(decoded)).toBe(true)
    expect(isTruncated(decodeFrame(encodeFrame(ctl({ t: 'delta' }), 512)))).toBe(false)
  })
})

describe('padding is constant regardless of content', () => {
  // This is the product claim, not a formatting detail. A 1 Hz stream whose
  // frame size tracks what changed leaks the household's load pattern to the
  // relay operator through otherwise perfect encryption.
  it('emits identical byte lengths for wildly different payloads', () => {
    const payloads = [
      { t: 'tick' },
      { t: 'delta', b: { seq: 1, fields: {} } },
      { t: 'delta', b: { seq: 2, fields: { 2: 11400, 3: 6200, 4: -4200, 5: 875, 6: 13400 } } },
      { t: 'delta', b: { seq: 3, fields: Object.fromEntries(Array.from({ length: 30 }, (_, i) => [i, i * 137])) } },
    ]

    const lengths = new Set(payloads.map((p) => encodeFrame(ctl(p), 512).length))
    expect(lengths).toEqual(new Set([512]))
  })

  it('pads with zeros so no residue from earlier frames leaks', () => {
    const bytes = encodeFrame(ctl({ t: 'tick' }), 512)
    const declared = (bytes[4]! << 8) | bytes[5]!
    const padding = bytes.subarray(HEADER_BYTES + declared)

    expect(padding.length).toBeGreaterThan(0)
    expect(padding.every((b) => b === 0)).toBe(true)
  })

  it('refuses to grow the bucket rather than silently defeating the padding', () => {
    const huge = { t: 'snap', b: { fields: Object.fromEntries(Array.from({ length: 400 }, (_, i) => [i, i])) } }
    expect(() => encodeFrame(ctl(huge), 512)).toThrow(FrameError)

    try {
      encodeFrame(ctl(huge), 512)
    } catch (e) {
      expect((e as FrameError).code).toBe('E_FRAME_EXCEEDS_BUCKET')
    }
  })
})

describe('forward and backward compatibility', () => {
  // A service worker can pin a bundle for a long time. A hard version wall
  // turns that into a white screen, so unknown things are ignored, not fatal.
  it('ignores unknown envelope keys instead of rejecting the frame', () => {
    const bytes = encodeFrame(
      ctl({ t: 'delta', b: { seq: 1 }, futureField: 'from a newer box' } as Frame['envelope']),
      512
    )
    const decoded = decodeFrame(bytes)

    expect(decoded.envelope.t).toBe('delta')
    expect(decoded.envelope.b).toEqual({ seq: 1 })
  })

  it('decodes a message type it has never heard of', () => {
    const decoded = decodeFrame(encodeFrame(ctl({ t: 'some.future.type', b: { x: 1 } }), 512))
    expect(decoded.envelope.t).toBe('some.future.type')
  })

  it('rejects a frame version it cannot parse', () => {
    const bytes = encodeFrame(ctl({ t: 'tick' }), 512)
    bytes[0] = 99
    expect(() => decodeFrame(bytes)).toThrow(/unsupported frame version/)
  })
})

describe('malformed input', () => {
  it('rejects a frame shorter than its header', () => {
    expect(() => decodeFrame(new Uint8Array(3))).toThrow(/need at least/)
  })

  it('rejects a declared length that overruns the frame', () => {
    const bytes = encodeFrame(ctl({ t: 'tick' }), 512)
    new DataView(bytes.buffer).setUint16(4, 600, false)
    expect(() => decodeFrame(bytes)).toThrow(/overruns/)
  })

  it('rejects a payload that is not CBOR', () => {
    const bytes = new Uint8Array(512)
    bytes[0] = FRAME_VERSION
    new DataView(bytes.buffer).setUint16(4, 4, false)
    bytes.set([0xff, 0xff, 0xff, 0xff], HEADER_BYTES)
    expect(() => decodeFrame(bytes)).toThrow(FrameError)
  })

  it('rejects an envelope without a string type', () => {
    // Hand-built: a CBOR map {"t": 1}, which is structurally valid but useless.
    const bytes = new Uint8Array(512)
    bytes[0] = FRAME_VERSION
    const payload = new Uint8Array([0xa1, 0x61, 0x74, 0x01])
    new DataView(bytes.buffer).setUint16(4, payload.length, false)
    bytes.set(payload, HEADER_BYTES)

    expect(() => decodeFrame(bytes)).toThrow(/missing a string type/)
  })

  it('rejects an envelope that is an array rather than a map', () => {
    const bytes = new Uint8Array(512)
    bytes[0] = FRAME_VERSION
    const payload = new Uint8Array([0x82, 0x01, 0x02]) // [1, 2]
    new DataView(bytes.buffer).setUint16(4, payload.length, false)
    bytes.set(payload, HEADER_BYTES)

    expect(() => decodeFrame(bytes)).toThrow(/must be a CBOR map/)
  })
})

describe('bulkBucketFor', () => {
  it('picks the smallest bucket that fits the header too', () => {
    expect(bulkBucketFor(100)).toBe(1024)
    expect(bulkBucketFor(1018)).toBe(1024)
    expect(bulkBucketFor(1019)).toBe(4096) // 1019 + 6 > 1024
    expect(bulkBucketFor(5000)).toBe(16384)
  })

  it('returns null rather than a bucket that cannot hold the payload', () => {
    expect(bulkBucketFor(20000)).toBeNull()
  })

  it('round trips a large snapshot on the bulk lane', () => {
    const snap = {
      t: 'snap',
      b: { fields: Object.fromEntries(Array.from({ length: 200 }, (_, i) => [i, i * 31])) },
    }
    const payloadSize = 4000
    const bucket = bulkBucketFor(payloadSize)!
    const decoded = decodeFrame(encodeFrame({ lane: LANE_BULK, flags: 0, envelope: snap }, bucket))

    expect(decoded.lane).toBe(LANE_BULK)
    expect(Object.keys(decoded.envelope.b as object)).toContain('fields')
  })
})
