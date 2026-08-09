/* Noise_IK_25519_ChaChaPoly_SHA256.
 *
 * IK is chosen for one reason: the initiator already knows the responder's
 * static key. The app reads it optically off the QR code on the box, so the
 * trust anchor never travels through Sourceful's cloud. A hostile or compelled
 * relay can drop frames, but it cannot present itself as a box — it would have
 * to produce a valid DH against a key it has never seen.
 *
 * The pattern:
 *
 *   IK:
 *     <- s
 *     ...
 *     -> e, es, s, ss
 *     <- e, ee, se
 *
 * The handshake is asynchronous; the transport that follows is not.
 *
 * That split is deliberate. The device's static key is a non-extractable
 * WebCrypto handle wherever the browser has X25519, so its scalar is never
 * readable by script — and its DH is therefore a promise. Paying that cost
 * here is free: a handshake is already two carrier round trips and is nowhere
 * near the first-frame path. encrypt and decrypt, which run once a second,
 * stay synchronous and touch no key material outside this process. See
 * transport.ts.
 *
 * Spec: https://noiseprotocol.org/noise.html §5, §7. Verified against the
 * Cacophony test vectors in noise.test.ts.
 */

import { x25519 } from '@noble/curves/ed25519.js'
import { chacha20poly1305 } from '@noble/ciphers/chacha.js'
import { sha256 } from '@noble/hashes/sha2.js'
import { extract, expand } from '@noble/hashes/hkdf.js'

export const PROTOCOL_NAME = 'Noise_IK_25519_ChaChaPoly_SHA256'

export const DH_BYTES = 32
export const KEY_BYTES = 32
export const HASH_BYTES = 32
export const TAG_BYTES = 16

/** 2^64 - 1 is reserved by the spec and must never encrypt. */
export const MAX_NONCE = (1n << 64n) - 1n

/**
 * Failures here are local: they never cross the wire, so their codes are not
 * in contract/registry.yaml. The carrier maps them to prose; this layer only
 * says which thing went wrong.
 */
export class NoiseError extends Error {
  constructor(
    message: string,
    readonly code: string
  ) {
    super(message)
    this.name = 'NoiseError'
  }
}

export interface KeyPair {
  secretKey: Uint8Array
  publicKey: Uint8Array
}

/**
 * A static key that can do Noise's one operation, however it holds itself.
 *
 * The device key is a non-extractable WebCrypto handle wherever the browser
 * has X25519, so its scalar is not readable by script at all — and its DH is
 * therefore asynchronous. Accepting this shape rather than raw bytes is what
 * lets the strongest available storage be used instead of the weakest common
 * one. Ephemerals stay raw: they are generated here, used twice and dropped.
 */
export interface StaticKey {
  readonly publicKey: Uint8Array
  diffieHellman(peerPublic: Uint8Array): Promise<Uint8Array>
}

/** Wraps raw bytes in the StaticKey shape. */
export function staticFromKeyPair(pair: KeyPair): StaticKey {
  return {
    publicKey: pair.publicKey,
    async diffieHellman(peerPublic) {
      return dh(pair.secretKey, peerPublic)
    },
  }
}

/**
 * Accept either form.
 *
 * A caller holding raw bytes — the box, a test, a browser without X25519 in
 * WebCrypto — should not have to wrap them, and a caller holding a
 * non-extractable handle cannot unwrap them. Normalising here keeps that
 * choice where it belongs: with whoever owns the key.
 */
function asStaticKey(key: StaticKey | KeyPair): StaticKey {
  return 'secretKey' in key ? staticFromKeyPair(key) : key
}

export function generateKeyPair(): KeyPair {
  return x25519.keygen()
}

export function keyPairFromSecret(secretKey: Uint8Array): KeyPair {
  if (secretKey.length !== DH_BYTES) {
    throw new NoiseError(`static key is ${secretKey.length} bytes, need ${DH_BYTES}`, 'E_NOISE_KEY')
  }
  return { secretKey, publicKey: x25519.getPublicKey(secretKey) }
}

/**
 * Noise HKDF: one extract over the chaining key, then expand with empty info.
 * Splitting `outputs * 32` off a single expand is byte-identical to the
 * spec's chained HMAC construction.
 */
function hkdfN(chainingKey: Uint8Array, ikm: Uint8Array, outputs: 2 | 3): Uint8Array[] {
  const prk = extract(sha256, ikm, chainingKey)
  const okm = expand(sha256, prk, undefined, outputs * HASH_BYTES)
  const out: Uint8Array[] = []
  for (let i = 0; i < outputs; i++) out.push(okm.subarray(i * HASH_BYTES, (i + 1) * HASH_BYTES))
  return out
}

function dh(secretKey: Uint8Array, publicKey: Uint8Array): Uint8Array {
  // noble rejects an all-zero shared secret. The Noise spec permits accepting
  // it; rejecting is strictly safer and only fires on a low-order point, which
  // an honest peer never sends.
  try {
    return x25519.getSharedSecret(secretKey, publicKey)
  } catch (cause) {
    throw new NoiseError(`X25519 failed: ${String(cause)}`, 'E_NOISE_DH')
  }
}

function concat(...parts: Uint8Array[]): Uint8Array {
  let n = 0
  for (const p of parts) n += p.length
  const out = new Uint8Array(n)
  let at = 0
  for (const p of parts) {
    out.set(p, at)
    at += p.length
  }
  return out
}

/**
 * ChaChaPoly's 96-bit nonce, Noise-encoded: four zero bytes, then the 64-bit
 * counter little-endian.
 */
function nonceBytes(n: bigint): Uint8Array {
  const out = new Uint8Array(12)
  let v = n
  for (let i = 4; i < 12; i++) {
    out[i] = Number(v & 0xffn)
    v >>= 8n
  }
  return out
}

/**
 * One direction's key and counter.
 *
 * The counter never wraps. Reusing a (key, nonce) pair under ChaCha20-Poly1305
 * hands an observer the XOR of two plaintexts and, worse, forges the
 * authenticator — so exhaustion throws and the session dies. Rekey is where
 * that limit is lifted, and it is not in v1: at 1 Hz on lane 0, 2^64 frames is
 * longer than the universe has run. If a bulk lane ever gets close, `rekey()`
 * belongs here, applying `k = ENCRYPT(k, 2^64-1, zerolen, zeros[32])` and
 * resetting n to 0 — and it needs a wire signal, because both ends must turn
 * the crank on the same frame.
 */
export class CipherState {
  #key: Uint8Array | null
  #nonce = 0n
  #destroyed = false

  constructor(key: Uint8Array | null = null) {
    this.#key = key
  }

  get hasKey(): boolean {
    return this.#key !== null
  }

  /** Next counter value. Also the sequence number transport.ts puts on the wire. */
  get nonce(): bigint {
    return this.#nonce
  }

  /**
   * Jump the counter, for a carrier that may reorder or drop. Only ever moves
   * to the sequence number actually received; replay protection lives in
   * transport.ts, which owns the decision about which numbers are acceptable.
   */
  setNonce(n: bigint): void {
    if (n < 0n || n >= MAX_NONCE) {
      throw new NoiseError(`nonce ${n} is out of range`, 'E_NOISE_NONCE_EXHAUSTED')
    }
    this.#nonce = n
  }

  encryptWithAd(ad: Uint8Array, plaintext: Uint8Array): Uint8Array {
    this.#assertUsable()
    // Before the first mixKey there is no key and the spec passes data
    // through. That is a handshake-only state and can never be reached after
    // split(), which is why destroy() is a separate flag rather than a null
    // key — a destroyed cipher must never quietly emit plaintext.
    if (this.#key === null) return plaintext
    const n = this.#take()
    return chacha20poly1305(this.#key, nonceBytes(n), ad).encrypt(plaintext)
  }

  decryptWithAd(ad: Uint8Array, ciphertext: Uint8Array): Uint8Array {
    this.#assertUsable()
    if (this.#key === null) return ciphertext
    const n = this.#take()
    try {
      return chacha20poly1305(this.#key, nonceBytes(n), ad).decrypt(ciphertext)
    } catch {
      // Never say more than this. Which check failed is exactly what a
      // chosen-ciphertext attacker is probing for.
      throw new NoiseError('authentication failed', 'E_NOISE_AUTH')
    }
  }

  /**
   * An independent copy: same key bytes, same counter, on its own buffer so
   * destroying one cannot wipe the other. Exists for the handshake's
   * commit-on-success reads; a transport cipher is never cloned.
   */
  clone(): CipherState {
    const copy = new CipherState(this.#key?.slice() ?? null)
    copy.#nonce = this.#nonce
    copy.#destroyed = this.#destroyed
    return copy
  }

  /** Wipe the key. A closed session must not leave one reachable. */
  destroy(): void {
    this.#key?.fill(0)
    this.#key = null
    this.#destroyed = true
  }

  #assertUsable(): void {
    if (this.#destroyed) throw new NoiseError('cipher was destroyed', 'E_NOISE_CLOSED')
  }

  #take(): bigint {
    if (this.#nonce >= MAX_NONCE) {
      throw new NoiseError('nonce space exhausted', 'E_NOISE_NONCE_EXHAUSTED')
    }
    return this.#nonce++
  }
}

/** Chaining key, handshake hash, and the cipher that protects handshake payloads. */
class SymmetricState {
  ck: Uint8Array
  h: Uint8Array
  cipher = new CipherState()

  constructor() {
    const name = new TextEncoder().encode(PROTOCOL_NAME)
    // The name is exactly HASH_BYTES long, so it is used verbatim; a longer
    // one would be hashed. Kept general because the pattern name is the thing
    // most likely to change.
    this.h = name.length <= HASH_BYTES ? concat(name, new Uint8Array(HASH_BYTES - name.length)) : sha256(name)
    this.ck = this.h.slice()
  }

  mixHash(data: Uint8Array): void {
    this.h = sha256(concat(this.h, data))
  }

  mixKey(ikm: Uint8Array): void {
    const [ck, tempK] = hkdfN(this.ck, ikm, 2)
    this.ck = ck!
    this.cipher = new CipherState(tempK!.slice())
  }

  encryptAndHash(plaintext: Uint8Array): Uint8Array {
    const ciphertext = this.cipher.encryptWithAd(this.h, plaintext)
    this.mixHash(ciphertext)
    return ciphertext
  }

  decryptAndHash(ciphertext: Uint8Array): Uint8Array {
    const plaintext = this.cipher.decryptWithAd(this.h, ciphertext)
    this.mixHash(ciphertext)
    return plaintext
  }

  /** A copy to run a candidate message against. See the readMessage pair. */
  clone(): SymmetricState {
    const copy = new SymmetricState()
    copy.ck = this.ck.slice()
    copy.h = this.h.slice()
    copy.cipher = this.cipher.clone()
    return copy
  }

  split(): [CipherState, CipherState] {
    const [k1, k2] = hkdfN(this.ck, new Uint8Array(0), 2)
    return [new CipherState(k1!.slice()), new CipherState(k2!.slice())]
  }
}

export interface HandshakeResult {
  /** Encrypts what we send. */
  send: CipherState
  /** Decrypts what we receive. */
  recv: CipherState
  /** Bind an external channel to this session with it; also a session id. */
  handshakeHash: Uint8Array
  /** The peer's static key, now authenticated rather than merely claimed. */
  remoteStatic: Uint8Array
}

export interface HandshakeOptions {
  staticKey: StaticKey | KeyPair
  /** Mixed in before anything else. Both ends must agree byte for byte. */
  prologue?: Uint8Array
  /**
   * Fixed ephemeral. Only for test vectors — generating it is the whole
   * source of forward secrecy, so production must never pass this.
   */
  ephemeral?: KeyPair
}

export interface InitiatorOptions extends HandshakeOptions {
  /** The box's static key, pinned optically from the QR code. */
  remoteStatic: Uint8Array
}

/** 'split' is terminal: the keys have been handed over and cannot be minted again. */
type Step = 'write1' | 'read1' | 'write2' | 'read2' | 'done' | 'split'

/**
 * The IK state machine. Drive it with writeMessage/readMessage in the order
 * the role dictates; anything else throws rather than silently producing a
 * message the peer cannot read.
 */
export class HandshakeState {
  #sym = new SymmetricState()
  #s: StaticKey
  #e: KeyPair | null = null
  #rs: Uint8Array | null = null
  #re: Uint8Array | null = null
  #initiator: boolean
  #fixedEphemeral: KeyPair | null
  #step: Step

  private constructor(initiator: boolean, opts: HandshakeOptions, remoteStatic?: Uint8Array) {
    this.#initiator = initiator
    this.#s = asStaticKey(opts.staticKey)
    this.#fixedEphemeral = opts.ephemeral ?? null
    this.#step = initiator ? 'write1' : 'read1'

    this.#sym.mixHash(opts.prologue ?? new Uint8Array(0))

    // IK's pre-message `<- s`: both ends hash the responder's static key
    // before the first byte moves. That is what makes a relay substituting its
    // own key fail at the first decryption instead of at some later layer.
    if (initiator) {
      if (!remoteStatic || remoteStatic.length !== DH_BYTES) {
        throw new NoiseError('IK needs the responder static key up front', 'E_NOISE_KEY')
      }
      this.#rs = remoteStatic
      this.#sym.mixHash(remoteStatic)
    } else {
      this.#sym.mixHash(this.#s.publicKey)
    }
  }

  static initiator(opts: InitiatorOptions): HandshakeState {
    return new HandshakeState(true, opts, opts.remoteStatic)
  }

  static responder(opts: HandshakeOptions): HandshakeState {
    return new HandshakeState(false, opts)
  }

  get isComplete(): boolean {
    return this.#step === 'done'
  }

  /**
   * Asynchronous because the static key's DH may live behind WebCrypto.
   *
   * The transport that follows is synchronous and stays that way: a handshake
   * is two carrier round trips and is nowhere near the first-frame path,
   * whereas encrypt and decrypt run once a second.
   */
  async writeMessage(payload: Uint8Array = new Uint8Array(0)): Promise<Uint8Array> {
    if (this.#initiator && this.#step === 'write1') return this.#writeMessage1(payload)
    if (!this.#initiator && this.#step === 'write2') return this.#writeMessage2(payload)
    throw new NoiseError(`cannot write at step ${this.#step}`, 'E_NOISE_STATE')
  }

  async readMessage(message: Uint8Array): Promise<Uint8Array> {
    if (!this.#initiator && this.#step === 'read1') return this.#readMessage1(message)
    if (this.#initiator && this.#step === 'read2') return this.#readMessage2(message)
    throw new NoiseError(`cannot read at step ${this.#step}`, 'E_NOISE_STATE')
  }

  /**
   * Valid once the pattern is done. Ends the handshake and hands over the keys.
   *
   * Consumes the handshake: a second call throws. Splitting twice would mint
   * two send ciphers holding the same key, both starting at nonce 0, so the
   * first frame of each would encrypt under an identical (key, nonce) pair —
   * which hands an observer the XOR of two plaintexts and makes Poly1305
   * authenticators forgeable. The obvious way to write reconnection is to keep
   * the handshake object and split again, so this has to be refused here
   * rather than remembered by every future caller.
   */
  split(): HandshakeResult {
    if (this.#step === 'split') {
      throw new NoiseError('handshake already split', 'E_NOISE_STATE')
    }
    if (this.#step !== 'done') {
      throw new NoiseError(`handshake is at step ${this.#step}`, 'E_NOISE_STATE')
    }

    const [c1, c2] = this.#sym.split()
    const result: HandshakeResult = {
      send: this.#initiator ? c1 : c2,
      recv: this.#initiator ? c2 : c1,
      handshakeHash: this.#sym.h,
      remoteStatic: this.#rs!,
    }

    this.#step = 'split'
    return result
  }

  // -> e, es, s, ss
  async #writeMessage1(payload: Uint8Array): Promise<Uint8Array> {
    this.#e = this.#fixedEphemeral ?? generateKeyPair()
    this.#sym.mixHash(this.#e.publicKey)
    this.#sym.mixKey(dh(this.#e.secretKey, this.#rs!))
    const encStatic = this.#sym.encryptAndHash(this.#s.publicKey)
    this.#sym.mixKey(await this.#s.diffieHellman(this.#rs!))
    const encPayload = this.#sym.encryptAndHash(payload)

    this.#step = 'read2'
    return concat(this.#e.publicKey, encStatic, encPayload)
  }

  async #readMessage1(message: Uint8Array): Promise<Uint8Array> {
    const encStaticEnd = DH_BYTES + DH_BYTES + TAG_BYTES
    if (message.length < encStaticEnd + TAG_BYTES) {
      throw new NoiseError(`handshake message 1 is ${message.length} bytes`, 'E_NOISE_MESSAGE')
    }

    // Commit on success, as in #readMessage2: a message that fails to
    // authenticate must leave no trace, or one stray frame ends every
    // handshake that was still waiting for the real one.
    const sym = this.#sym.clone()
    const re = message.subarray(0, DH_BYTES)
    sym.mixHash(re)
    sym.mixKey(await this.#s.diffieHellman(re))
    // Fails here when the initiator pinned somebody else's static key, which
    // is exactly the relay-impersonation case.
    const rs = sym.decryptAndHash(message.subarray(DH_BYTES, encStaticEnd))
    sym.mixKey(await this.#s.diffieHellman(rs))
    const payload = sym.decryptAndHash(message.subarray(encStaticEnd))

    this.#sym = sym
    this.#re = re
    this.#rs = rs
    this.#step = 'write2'
    return payload
  }

  // <- e, ee, se
  async #writeMessage2(payload: Uint8Array): Promise<Uint8Array> {
    this.#e = this.#fixedEphemeral ?? generateKeyPair()
    this.#sym.mixHash(this.#e.publicKey)
    this.#sym.mixKey(dh(this.#e.secretKey, this.#re!))
    this.#sym.mixKey(dh(this.#e.secretKey, this.#rs!))
    const encPayload = this.#sym.encryptAndHash(payload)

    this.#step = 'done'
    return concat(this.#e.publicKey, encPayload)
  }

  async #readMessage2(message: Uint8Array): Promise<Uint8Array> {
    if (message.length < DH_BYTES + TAG_BYTES) {
      throw new NoiseError(`handshake message 2 is ${message.length} bytes`, 'E_NOISE_MESSAGE')
    }

    // All mixing runs against a copy, which becomes the state only once the
    // tag verifies. The relay broadcasts every frame in the room, and message
    // 2 is exactly 48 bytes — two phones connecting at once read each other's
    // replies. Mixing a stray one into the live state before the tag check
    // would poison ck and h, and the genuine reply could never authenticate.
    const sym = this.#sym.clone()
    const re = message.subarray(0, DH_BYTES)
    sym.mixHash(re)
    sym.mixKey(dh(this.#e!.secretKey, re))
    sym.mixKey(await this.#s.diffieHellman(re))
    const payload = sym.decryptAndHash(message.subarray(DH_BYTES))

    this.#sym = sym
    this.#re = re
    this.#step = 'done'
    return payload
  }
}

/** Bytes on the wire for the first handshake message, before any payload. */
export const MESSAGE_1_OVERHEAD = DH_BYTES + DH_BYTES + TAG_BYTES + TAG_BYTES
/** Bytes on the wire for the second, before any payload. */
export const MESSAGE_2_OVERHEAD = DH_BYTES + TAG_BYTES
