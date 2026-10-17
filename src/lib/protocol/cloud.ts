// FTW Cloud's outer session. The box session inside tun keeps its own codec.
// Normative wire and vectors: srcfl/ftw go/protocol/cloudwire.
import { encode, decode } from 'cbor2'
import { sha256 } from '@noble/hashes/sha2.js'

export const CLOUD_URL = 'wss://cloud.ftw.energy/v1/app'
// Public X25519 keys, in the same rotation order as FTWKit/Identity/CloudKeys.swift.
export const CLOUD_KEYS = ['6-1WbbDzKvbwODSwhUN24MPemfLNRhcbMP2tpU_QAEk']
export const TUN_DATA_MAX = 16384 + 24
export interface CloudEnvelope { t: string; b: Uint8Array; sig: Uint8Array }
export interface TunnelMessage { sid: number; d: Uint8Array }

export function validHome(home: unknown): home is string {
  return typeof home === 'string' && /^[a-z2-7]{26}$/.test(home)
}

export function cloudPrologue(home: string): Uint8Array {
  if (!validHome(home)) throw new Error('invalid Cloud home')
  return new TextEncoder().encode(`ftw.cloud.v1:${home}`)
}

export function pairingHash(home: string, code: Uint8Array): Uint8Array {
  const tag = new TextEncoder().encode(`ftw.cloud.pair.v1\0${home}`)
  const input = new Uint8Array(tag.length + code.length)
  input.set(tag)
  input.set(code, tag.length)
  return sha256(input)
}

export function unsigned(t: string, body: unknown): Uint8Array {
  return encode({ t, b: encode(body, { cde: true }), sig: new Uint8Array() }, { cde: true })
}

export function cloudFrame(envelope: Uint8Array): Uint8Array {
  if (envelope.length > 65535) throw new Error('Cloud envelope too large')
  const frame = new Uint8Array(envelope.length + 6)
  frame.set([1, 1, 0, 0, envelope.length >> 8, envelope.length & 255])
  frame.set(envelope, 6)
  return frame
}

export function cloudBody(bytes: Uint8Array): Record<string, unknown> {
  const value: unknown = decode(bytes, { rejectDuplicateKeys: true })
  if (!value || typeof value !== 'object' || Array.isArray(value) || value instanceof Uint8Array || value instanceof Map) {
    throw new Error('invalid Cloud body')
  }
  return value as Record<string, unknown>
}

export function cloudEnvelope(bytes: Uint8Array): CloudEnvelope {
  const value = cloudBody(bytes)
  if (typeof value['t'] !== 'string' || !value['t'] || !(value['b'] instanceof Uint8Array) || !(value['sig'] instanceof Uint8Array)) {
    throw new Error('invalid Cloud envelope')
  }
  return { t: value['t'], b: value['b'], sig: value['sig'] }
}

export function readCloudFrame(frame: Uint8Array): CloudEnvelope {
  if (frame.length < 6 || frame[0] !== 1 || frame[1] !== 1 || frame[2] !== 0 || frame[3] !== 0 ||
      ((frame[4]! << 8) | frame[5]!) !== frame.length - 6) throw new Error('invalid Cloud frame')
  return cloudEnvelope(frame.subarray(6))
}

export function readTunnel(body: Uint8Array): TunnelMessage {
  const value = cloudBody(body)
  const sid = value['sid']
  const d = value['d']
  if (typeof sid !== 'number' || !Number.isInteger(sid) || sid <= 0 || sid > 0xffffffff ||
      !(d instanceof Uint8Array) || d.length > TUN_DATA_MAX) throw new Error('invalid tunnel message')
  return { sid, d }
}

export function readCloudSnapshot(payload: Uint8Array): void {
  const envelope = cloudEnvelope(payload)
  if (envelope.t !== 'snapshot' || envelope.sig.length !== 0) throw new Error('invalid Cloud snapshot')
  const body = cloudBody(envelope.b)
  if (!Array.isArray(body['envelopes']) || typeof body['online'] !== 'boolean' ||
      !Number.isSafeInteger(body['lastSeenMs']) || !Number.isSafeInteger(body['more']) || Number(body['more']) < 0) {
    throw new Error('invalid Cloud snapshot body')
  }
  // This carrier uses only the end-to-end box session. The readable copy is
  // not projected into UI state; its signatures and freshness need their own view.
}
