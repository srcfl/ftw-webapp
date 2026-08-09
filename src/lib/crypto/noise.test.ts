import { describe, it, expect } from 'vitest'
import { hexToBytes, bytesToHex } from '@noble/hashes/utils.js'
import {
  HandshakeState,
  CipherState,
  NoiseError,
  generateKeyPair,
  keyPairFromSecret,
  MAX_NONCE,
  MESSAGE_1_OVERHEAD,
  MESSAGE_2_OVERHEAD,
  PROTOCOL_NAME,
  type KeyPair,
} from './noise'

/**
 * The Cacophony vector for this exact protocol, copied verbatim from the
 * reference suite the other implementations test against
 * (snow: tests/vectors/cacophony.txt).
 *
 * Round-trip tests only prove this file agrees with itself. This proves it
 * agrees with every other Noise implementation — including the Go one on the
 * box, which is the pair that has to work.
 */
const VECTOR = {
  protocol_name: 'Noise_IK_25519_ChaChaPoly_SHA256',
  init_prologue: '4a6f686e2047616c74',
  init_static: 'e61ef9919cde45dd5f82166404bd08e38bceb5dfdfded0a34c8df7ed542214d1',
  init_ephemeral: '893e28b9dc6ca8d611ab664754b8ceb7bac5117349a4439a6b0569da977c464a',
  init_remote_static: '31e0303fd6418d2f8c0e78b91f22e8caed0fbe48656dcf4767e4834f701b8f62',
  resp_prologue: '4a6f686e2047616c74',
  resp_static: '4a3acbfdb163dec651dfa3194dece676d437029c62a408b4c5ea9114246e4893',
  resp_ephemeral: 'bbdb4cdbd309f1a1f2e1456967fe288cadd6f712d65dc7b7793d5e63da6b375b',
  handshake_hash: '0b0f68fb0c27e03ce9b97565995ed4838cc0581b762ef72b062f6a546419fad7',
  messages: [
    {
      payload: '4c756477696720766f6e204d69736573',
      ciphertext:
        'ca35def5ae56cec33dc2036731ab14896bc4c75dbb07a61f879f8e3afa4c7944718da798efbcd91528520204f904b9bd6c7413dccdc214d951e15253e39987f18146e8cd0873654207148333479d4d16c289f0294b29960a72f48e0b7bba2e89083169825e59642148d492020664ccf7',
    },
    {
      payload: '4d757272617920526f746862617264',
      ciphertext:
        '95ebc60d2b1fa672c1f46a8aa265ef51bfe38e7ccb39ec5be34069f1448088435361e70b2ed446e6c9ec387d1d6b3b840f194e373979d241b203c4acafccf5',
    },
    { payload: '462e20412e20486179656b', ciphertext: '050e9f3c8fac16b68dbce8f8c4bfbf6617c897f9ada4aa29aa19c8' },
    { payload: '4361726c204d656e676572', ciphertext: '344233a6cabb7141d80f3da2fedc311d9646bbb0f505afe403a667' },
    {
      payload: '4a65616e2d426170746973746520536179',
      ciphertext: '62cdeeb172ad7ade7aa7d9e069da5790f12331bfa00177787a1d0810c67dc3b2b4',
    },
    {
      payload: '457567656e2042f6686d20766f6e2042617765726b',
      ciphertext: '029bead1b40992327044d409d9a1f3ad8f36c3c452775d557e18bbeb2e8dfcead32d514024',
    },
  ],
} as const

/** jsdom's TextEncoder yields a Uint8Array from another realm, which vitest
 *  refuses to compare structurally. Keeping bytes in one realm avoids it. */
const utf8 = (s: string): Uint8Array => Uint8Array.from(new TextEncoder().encode(s))

function pair(): { app: KeyPair; box: KeyPair } {
  return { app: generateKeyPair(), box: generateKeyPair() }
}

/** Runs a full IK exchange and hands back both ends' split keys. */
async function connect(app: KeyPair, box: KeyPair) {
  const initiator = HandshakeState.initiator({ staticKey: app, remoteStatic: box.publicKey })
  const responder = HandshakeState.responder({ staticKey: box })

  await responder.readMessage(await initiator.writeMessage())
  await initiator.readMessage(await responder.writeMessage())

  return { initiator: initiator.split(), responder: responder.split() }
}

describe('Cacophony vector', () => {
  it('names the protocol the vector names', async () => {
    expect(PROTOCOL_NAME).toBe(VECTOR.protocol_name)
  })

  it('reproduces both handshake messages byte for byte', async () => {
    const initiator = HandshakeState.initiator({
      staticKey: keyPairFromSecret(hexToBytes(VECTOR.init_static)),
      remoteStatic: hexToBytes(VECTOR.init_remote_static),
      prologue: hexToBytes(VECTOR.init_prologue),
      ephemeral: keyPairFromSecret(hexToBytes(VECTOR.init_ephemeral)),
    })
    const responder = HandshakeState.responder({
      staticKey: keyPairFromSecret(hexToBytes(VECTOR.resp_static)),
      prologue: hexToBytes(VECTOR.resp_prologue),
      ephemeral: keyPairFromSecret(hexToBytes(VECTOR.resp_ephemeral)),
    })

    const m1 = await initiator.writeMessage(hexToBytes(VECTOR.messages[0].payload))
    expect(bytesToHex(m1)).toBe(VECTOR.messages[0].ciphertext)
    expect(bytesToHex(await responder.readMessage(m1))).toBe(VECTOR.messages[0].payload)

    const m2 = await responder.writeMessage(hexToBytes(VECTOR.messages[1].payload))
    expect(bytesToHex(m2)).toBe(VECTOR.messages[1].ciphertext)
    expect(bytesToHex(await initiator.readMessage(m2))).toBe(VECTOR.messages[1].payload)

    const a = initiator.split()
    const b = responder.split()

    expect(bytesToHex(a.handshakeHash)).toBe(VECTOR.handshake_hash)
    expect(bytesToHex(b.handshakeHash)).toBe(VECTOR.handshake_hash)

    // Each end learns the other's static key from the handshake rather than
    // taking it on trust.
    expect(bytesToHex(a.remoteStatic)).toBe(VECTOR.init_remote_static)
    expect(bytesToHex(b.remoteStatic)).toBe(bytesToHex(keyPairFromSecret(hexToBytes(VECTOR.init_static)).publicKey))

    // Transport messages alternate, starting with the initiator.
    const rest = VECTOR.messages.slice(2)
    rest.forEach((msg, i) => {
      const fromInitiator = i % 2 === 0
      const sender = fromInitiator ? a.send : b.send
      const receiver = fromInitiator ? b.recv : a.recv
      const ciphertext = sender.encryptWithAd(new Uint8Array(0), hexToBytes(msg.payload))

      expect(bytesToHex(ciphertext)).toBe(msg.ciphertext)
      expect(bytesToHex(receiver.decryptWithAd(new Uint8Array(0), ciphertext))).toBe(msg.payload)
    })
  })
})

describe('handshake', () => {
  it('agrees on keys, hash and each other identity', async () => {
    const { app, box } = pair()
    const { initiator, responder } = await connect(app, box)

    expect(bytesToHex(initiator.handshakeHash)).toBe(bytesToHex(responder.handshakeHash))
    expect(bytesToHex(initiator.remoteStatic)).toBe(bytesToHex(box.publicKey))
    expect(bytesToHex(responder.remoteStatic)).toBe(bytesToHex(app.publicKey))

    const message = utf8('grid_w=-4200')
    const ad = new Uint8Array(0)
    expect(bytesToHex(initiator.recv.decryptWithAd(ad, responder.send.encryptWithAd(ad, message)))).toBe(
      bytesToHex(message)
    )
    expect(bytesToHex(responder.recv.decryptWithAd(ad, initiator.send.encryptWithAd(ad, message)))).toBe(
      bytesToHex(message)
    )
  })

  it('carries payloads in both handshake messages', async () => {
    const { app, box } = pair()
    const initiator = HandshakeState.initiator({ staticKey: app, remoteStatic: box.publicKey })
    const responder = HandshakeState.responder({ staticKey: box })

    const pairingCode = utf8('QR-8842')
    const m1 = await initiator.writeMessage(pairingCode)
    expect(m1.length).toBe(MESSAGE_1_OVERHEAD + pairingCode.length)
    expect(bytesToHex(await responder.readMessage(m1))).toBe(bytesToHex(pairingCode))

    const greeting = utf8('boot=ok')
    const m2 = await responder.writeMessage(greeting)
    expect(m2.length).toBe(MESSAGE_2_OVERHEAD + greeting.length)
    expect(bytesToHex(await initiator.readMessage(m2))).toBe(bytesToHex(greeting))
  })

  it('is a fresh session every time, so a recording is worth nothing later', async () => {
    const { app, box } = pair()
    const first = await connect(app, box)
    const second = await connect(app, box)

    expect(bytesToHex(first.initiator.handshakeHash)).not.toBe(bytesToHex(second.initiator.handshakeHash))
  })
})

describe('a relay cannot present itself as a box', () => {
  // The whole reason the pattern is IK. The app pinned the box static key off
  // the QR code, so a relay standing in the middle has no key that satisfies
  // the first decryption.
  it('fails when the app pinned somebody else static key', async () => {
    const { app, box } = pair()
    const impostor = generateKeyPair()

    const initiator = HandshakeState.initiator({ staticKey: app, remoteStatic: impostor.publicKey })
    const responder = HandshakeState.responder({ staticKey: box })

    await expect(responder.readMessage(await initiator.writeMessage())).rejects.toThrow(NoiseError)
  })

  it('reports authentication failure and nothing more specific', async () => {
    const { app, box } = pair()
    const initiator = HandshakeState.initiator({ staticKey: app, remoteStatic: generateKeyPair().publicKey })
    const responder = HandshakeState.responder({ staticKey: box })

    try {
      await responder.readMessage(await initiator.writeMessage())
      expect.unreachable('handshake should have failed')
    } catch (err) {
      expect((err as NoiseError).code).toBe('E_NOISE_AUTH')
    }
  })

  it('fails when the two ends disagree about the prologue', async () => {
    const { app, box } = pair()
    const initiator = HandshakeState.initiator({
      staticKey: app,
      remoteStatic: box.publicKey,
      prologue: utf8('site-A'),
    })
    const responder = HandshakeState.responder({
      staticKey: box,
      prologue: utf8('site-B'),
    })

    await expect(responder.readMessage(await initiator.writeMessage())).rejects.toThrow(NoiseError)
  })

  it('fails when the first message was altered in flight', async () => {
    const { app, box } = pair()
    const initiator = HandshakeState.initiator({ staticKey: app, remoteStatic: box.publicKey })
    const responder = HandshakeState.responder({ staticKey: box })

    const m1 = await initiator.writeMessage()
    m1[40] = m1[40]! ^ 0x01

    await expect(responder.readMessage(m1)).rejects.toThrow(NoiseError)
  })

  it('fails when the reply was altered in flight', async () => {
    const { app, box } = pair()
    const initiator = HandshakeState.initiator({ staticKey: app, remoteStatic: box.publicKey })
    const responder = HandshakeState.responder({ staticKey: box })

    await responder.readMessage(await initiator.writeMessage())
    const m2 = await responder.writeMessage()
    m2[m2.length - 1] = m2[m2.length - 1]! ^ 0x01

    await expect(initiator.readMessage(m2)).rejects.toThrow(NoiseError)
  })
})

describe('a stray frame cannot poison a waiting handshake', () => {
  // The relay broadcasts every uplink frame to all streams in a room, and
  // message 2 is exactly 48 bytes — two phones connecting at once read each
  // other's replies. A reply that fails to authenticate must leave the
  // handshake exactly as it was, or the genuine reply can never open it.
  it('completes on the genuine message 2 after rejecting somebody else’s', async () => {
    const { app, box } = pair()
    const initiator = HandshakeState.initiator({ staticKey: app, remoteStatic: box.publicKey })
    const responder = HandshakeState.responder({ staticKey: box })

    await responder.readMessage(await initiator.writeMessage())
    const m2 = await responder.writeMessage()

    // Another household's valid message 2: right shape, wrong session.
    const otherBox = generateKeyPair()
    const otherInitiator = HandshakeState.initiator({
      staticKey: generateKeyPair(),
      remoteStatic: otherBox.publicKey,
    })
    const otherResponder = HandshakeState.responder({ staticKey: otherBox })
    await otherResponder.readMessage(await otherInitiator.writeMessage())
    const stray = await otherResponder.writeMessage()

    await expect(initiator.readMessage(stray)).rejects.toThrow(NoiseError)

    // The genuine reply still opens the session, and a transport frame
    // round-trips under the split keys.
    await initiator.readMessage(m2)
    const a = initiator.split()
    const b = responder.split()
    const ad = new Uint8Array(0)
    const frame = utf8('grid_w=1200')
    expect(bytesToHex(b.recv.decryptWithAd(ad, a.send.encryptWithAd(ad, frame)))).toBe(bytesToHex(frame))
    expect(bytesToHex(a.recv.decryptWithAd(ad, b.send.encryptWithAd(ad, frame)))).toBe(bytesToHex(frame))
  })

  it('completes on the genuine message 1 after rejecting somebody else’s', async () => {
    const { app, box } = pair()
    const initiator = HandshakeState.initiator({ staticKey: app, remoteStatic: box.publicKey })
    const responder = HandshakeState.responder({ staticKey: box })
    const m1 = await initiator.writeMessage()

    // A message 1 aimed at some other box. Its first decryption cannot
    // authenticate here, and it must not move the responder either.
    const strayInitiator = HandshakeState.initiator({
      staticKey: generateKeyPair(),
      remoteStatic: generateKeyPair().publicKey,
    })
    await expect(responder.readMessage(await strayInitiator.writeMessage())).rejects.toThrow(NoiseError)

    await responder.readMessage(m1)
    await initiator.readMessage(await responder.writeMessage())
    expect(initiator.isComplete).toBe(true)
    expect(responder.isComplete).toBe(true)
    expect(bytesToHex(initiator.split().handshakeHash)).toBe(bytesToHex(responder.split().handshakeHash))
  })
})

describe('state machine', () => {
  it('refuses to write out of turn', async () => {
    const { app, box } = pair()
    const initiator = HandshakeState.initiator({ staticKey: app, remoteStatic: box.publicKey })
    await initiator.writeMessage()
    await expect(initiator.writeMessage()).rejects.toThrow(/cannot write/)
  })

  it('refuses to read out of turn', async () => {
    const { app, box } = pair()
    const responder = HandshakeState.responder({ staticKey: box })
    await expect(responder.readMessage(new Uint8Array(MESSAGE_1_OVERHEAD))).rejects.toThrow(NoiseError)
    expect(HandshakeState.initiator({ staticKey: app, remoteStatic: box.publicKey }).isComplete).toBe(false)
  })

  it('refuses to split before the pattern is done', async () => {
    const { box } = pair()
    expect(() => HandshakeState.responder({ staticKey: box }).split()).toThrow(/handshake is at step/)
  })

  it('rejects a truncated handshake message instead of reading past its end', async () => {
    const { app, box } = pair()
    const initiator = HandshakeState.initiator({ staticKey: app, remoteStatic: box.publicKey })
    const responder = HandshakeState.responder({ staticKey: box })

    const truncated = (await initiator.writeMessage()).subarray(0, 40)
    await expect(responder.readMessage(truncated)).rejects.toThrow(/message 1 is 40 bytes/)
  })

  it('rejects a static key of the wrong size rather than deriving from it', async () => {
    expect(() => keyPairFromSecret(new Uint8Array(16))).toThrow(/need 32/)
  })
})

describe('nonce exhaustion', () => {
  // ChaCha20-Poly1305 fails catastrophically on nonce reuse: the observer gets
  // the XOR of two plaintexts and the authenticator becomes forgeable. So the
  // counter throws at the end rather than wrapping.
  it('throws instead of rolling over', async () => {
    const cipher = new CipherState(new Uint8Array(32).fill(7))
    cipher.setNonce(MAX_NONCE - 1n)

    expect(() => cipher.encryptWithAd(new Uint8Array(0), new Uint8Array(8))).not.toThrow()
    expect(cipher.nonce).toBe(MAX_NONCE)

    try {
      cipher.encryptWithAd(new Uint8Array(0), new Uint8Array(8))
      expect.unreachable('the reserved nonce must never encrypt')
    } catch (err) {
      expect((err as NoiseError).code).toBe('E_NOISE_NONCE_EXHAUSTED')
    }
  })

  it('refuses to be set to the reserved value', async () => {
    const cipher = new CipherState(new Uint8Array(32).fill(7))
    expect(() => cipher.setNonce(MAX_NONCE)).toThrow(/out of range/)
    expect(() => cipher.setNonce(-1n)).toThrow(/out of range/)
  })

  it('throws rather than emitting plaintext once destroyed', async () => {
    const { app, box } = pair()
    const { initiator } = await connect(app, box)

    initiator.send.destroy()
    expect(initiator.send.hasKey).toBe(false)
    expect(() => initiator.send.encryptWithAd(new Uint8Array(0), new Uint8Array(8))).toThrow(/destroyed/)
  })
})
