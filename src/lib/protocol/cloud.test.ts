import { describe, it, expect } from 'vitest'
import { HandshakeState, keyPairFromSecret } from '$lib/crypto/noise'
import { NoiseTransport } from '$lib/crypto/transport'
import { cloudFrame, cloudPrologue, readCloudFrame, readCloudSnapshot, readTunnel, unsigned, pairingHash } from './cloud'
import vectors from '../../../tests/fixtures/cloud-app-vectors.json'

const bytes = (hex: string) => Uint8Array.from(hex.match(/../g) ?? [], x => parseInt(x, 16))
const hex = (value: Uint8Array) => [...value].map(x => x.toString(16).padStart(2, '0')).join('')

describe('FTW Cloud vectors from srcfl/ftw go/protocol/cloudwire', () => {
  it('matches the Go and Swift handshake and both transport directions', async () => {
    const hs = HandshakeState.initiator({
      staticKey: keyPairFromSecret(bytes(vectors.phoneStatic)),
      remoteStatic: bytes(vectors.servicePublic),
      ephemeral: keyPairFromSecret(bytes(vectors.phoneEphemeral)),
      prologue: cloudPrologue(vectors.home),
    })
    expect(hex(unsigned('now', { hz: 1 }))).toBe(vectors.msg1Payload)
    expect(hex(await hs.writeMessage(bytes(vectors.msg1Payload)))).toBe(vectors.msg1)
    const snapshot = await hs.readMessage(bytes(vectors.msg2))
    expect(hex(snapshot)).toBe(vectors.msg2Payload)
    readCloudSnapshot(snapshot)
    const transport = new NoiseTransport(hs.split())
    expect(hex(transport.handshakeHash)).toBe(vectors.handshakeHash)
    for (const message of vectors.transport) {
      const frame = bytes(message.frame)
      if (message.from === 'phone') expect(hex(transport.encrypt(frame))).toBe(message.message)
      else expect(hex(transport.decrypt(bytes(message.message)))).toBe(message.frame)
      const envelope = readCloudFrame(frame)
      if (envelope.t === 'tun') {
        const tun = readTunnel(envelope.b)
        expect(hex(cloudFrame(unsigned('tun', tun)))).toBe(message.frame)
      }
    }
    transport.close()
  })

  it('matches the pending-pairing proof and piggybacked box handshake', () => {
    const pair = pairingHash(vectors.home, bytes(vectors.pairing.code))
    expect(hex(pair)).toBe(vectors.pairing.hash)
    expect(hex(unsigned('now', { hz: 1, pair }))).toBe(vectors.pairing.msg1Now)
    expect(hex(unsigned('now', { hz: 1, pair, tun: { sid: 1, d: new Uint8Array(112).fill(0x9b) } }))).toBe(vectors.pairing.msg1NowTun)
  })

  it('rejects flags, padding, lane 0 and oversized tunnels', () => {
    const frame = cloudFrame(unsigned('tun', { sid: 1, d: new Uint8Array() }))
    for (const index of [0, 1, 2, 3, 5]) {
      const wrong = frame.slice(); wrong[index] = wrong[index]! ^ 1
      expect(() => readCloudFrame(wrong)).toThrow()
    }
    expect(() => readCloudFrame(new Uint8Array([...frame, 0]))).toThrow()
    expect(() => readTunnel(readCloudFrame(cloudFrame(unsigned('tun', { sid: 0, d: new Uint8Array() }))).b)).toThrow()
    expect(() => readTunnel(readCloudFrame(cloudFrame(unsigned('tun', { sid: 1, d: new Uint8Array(16409) }))).b)).toThrow()
    expect(() => cloudPrologue('../other-home')).toThrow()
  })
})
