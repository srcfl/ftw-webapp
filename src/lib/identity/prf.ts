/* The passkey as a key derivation function.
 *
 * There is no account, no server-side WebAuthn ceremony and nothing that
 * verifies the assertion signature. The credential exists for one reason: the
 * PRF extension hands back a secret that only appears after the user verifies,
 * and that secret unlocks the vault. Face ID is the gate; PRF is the key.
 *
 * The RP ID defaults to the app's own hostname, which is the subdomain, never
 * the registrable domain. PRF output is bound to the RP ID rather than the
 * origin, so the RP ID's scope decides which origins can derive the key. The
 * box is never an origin, so a wider scope buys nothing and costs the
 * guarantee. See docs/architecture.md.
 *
 * PRF is not everywhere. Where it is missing this returns null and the vault
 * falls back to a key held in IndexedDB — genuinely weaker, and the UI says so
 * rather than pretending the two are the same.
 */

import { ed25519 } from '@noble/curves/ed25519.js'
import { encodeBase64url, decodeBase64url } from './base64url'
import { currentRpId, RP_NAME } from './origin'

/**
 * One fixed salt per purpose, forever.
 *
 * Changing a salt changes the derived key, which strands every device that has
 * already wrapped its vault under the old one. A new purpose gets a new entry;
 * an existing purpose never gets a new salt, and two purposes never share one.
 */
export const PRF_SALTS = {
  /** Wraps the device key at enrollment and before a privileged command. */
  vault: 'ftw.prf.v1.vault',
  /**
   * Separates the two things the escrow needs from everything that stays here.
   *
   * Unlike `vault` this is not a second thing to ask the authenticator for. It
   * is an HKDF salt, and the authenticator is only ever asked for the vault
   * salt: one ceremony, one prompt, and HKDF makes the keys that cannot stand
   * in for each other. A second PRF evaluation in the same assertion would be
   * one more thing a platform can leave unanswered, and it would separate them
   * no better.
   *
   * See $lib/identity/escrow for what comes out of it and what it costs.
   */
  escrow: 'ftw.prf.v1.escrow',
} as const

export type PrfPurpose = keyof typeof PRF_SALTS

/**
 * What the escrow needs, both derived from the PRF output of one ceremony.
 *
 * Siblings, never one derived from the other: the id Sourceful holds says
 * nothing about the key that opens what sits under it. They are separated by
 * their `info` strings under the shared escrow salt.
 */
export interface EscrowKeys {
  /** base64url of 32 bytes. The only name the service ever learns. */
  lookupId: string
  /** AES-GCM 256, non-extractable. Seals the recovery blob. */
  sealKey: CryptoKey
  /**
   * Ed25519 public key, 32 bytes. What proves a write is this household's.
   *
   * Reading the escrow is the id alone, because a fresh install has a passkey
   * and nothing else. Writing is not: the service pins this key the first time
   * it sees it and refuses every later write that presents another, so knowing
   * an id no longer lets a stranger overwrite a household's spare copy.
   */
  writeKey: Uint8Array
  /** Signs one write. The private half never leaves this closure. */
  sign(message: Uint8Array): Uint8Array
}

const ESCROW_ID_INFO = 'ftw.escrow.id.v1'
const ESCROW_KEY_INFO = 'ftw.escrow.key.v1'
const ESCROW_WRITE_INFO = 'ftw.escrow.write.v1'

/** Where a wrapping key came from. The UI states this; it never hides it. */
export type WrappingSource = 'prf' | 'local'

export interface WrappingKey {
  /** base64url credential id, or LOCAL_CREDENTIAL_ID on the fallback path. */
  credentialId: string
  source: WrappingSource
  /** AES-GCM 256, non-extractable, encrypt/decrypt only. */
  key: CryptoKey
  /**
   * The id and the key for a sealed copy kept off this device.
   *
   * Derived from the same PRF output as `key`, so every ceremony that yields
   * one yields both and no path pays a second prompt for it. Absent on the
   * local fallback, where there is no PRF output to derive anything from —
   * and therefore nothing that may leave this device. That is not a gap: a
   * copy sealed under a key sitting unwrapped in IndexedDB would be a copy
   * anyone holding the phone could upload and later open.
   */
  escrow?: EscrowKeys
}

/** Whether this browser can speak WebAuthn at all. */
export function webAuthnAvailable(): boolean {
  return Boolean(globalThis.PublicKeyCredential) && Boolean(navigator.credentials?.create)
}

/**
 * Whether PRF is available.
 *
 * 'unknown' is a real answer, not a hedge: browsers without
 * `getClientCapabilities` only reveal PRF support by being asked for it, so
 * the caller registers and looks at what comes back.
 */
export async function prfCapability(): Promise<'yes' | 'no' | 'unknown'> {
  if (!webAuthnAvailable()) return 'no'
  if (typeof globalThis.PublicKeyCredential.getClientCapabilities !== 'function') return 'unknown'
  try {
    const caps = await globalThis.PublicKeyCredential.getClientCapabilities()
    const prf = caps['extension:prf']
    return prf === undefined ? 'unknown' : prf ? 'yes' : 'no'
  } catch {
    return 'unknown'
  }
}

export interface RegisterOptions {
  /** Defaults to the app's own hostname, which is the only correct scope. */
  rpId?: string
  rpName?: string
  /** Shown in the platform's passkey list. There is no account behind it. */
  label?: string
  /** Stable per install, so re-registering replaces rather than duplicates. */
  userHandle: Uint8Array<ArrayBuffer>
  excludeCredentialIds?: readonly string[]
  purpose?: PrfPurpose
  signal?: AbortSignal
}

export interface Registration {
  credentialId: string
  /** Null when the platform registered the passkey but delivered no PRF. */
  wrapping: WrappingKey | null
}

export interface AssertOptions {
  rpId?: string
  /** Empty means "any discoverable credential for this RP". */
  credentialIds?: readonly string[]
  purpose?: PrfPurpose
  signal?: AbortSignal
}

export async function registerPasskey(opts: RegisterOptions): Promise<Registration> {
  const purpose = opts.purpose ?? 'vault'
  const rpId = opts.rpId ?? defaultRpId()
  const label = opts.label ?? 'FTW'

  const credential = (await navigator.credentials.create({
    publicKey: {
      challenge: randomChallenge(),
      rp: { id: rpId, name: opts.rpName ?? RP_NAME },
      user: { id: opts.userHandle, name: label, displayName: label },
      pubKeyCredParams: [
        { type: 'public-key', alg: -7 },
        { type: 'public-key', alg: -257 },
      ],
      authenticatorSelection: { residentKey: 'required', userVerification: 'required' },
      attestation: 'none',
      excludeCredentials: (opts.excludeCredentialIds ?? []).map(toDescriptor),
      extensions: { prf: { eval: { first: saltFor(purpose) } } },
    },
    ...(opts.signal ? { signal: opts.signal } : {}),
  })) as PublicKeyCredential | null

  if (!credential) throw new Error('the authenticator returned no credential')

  const credentialId = encodeBase64url(new Uint8Array(credential.rawId))
  const prf = credential.getClientExtensionResults().prf
  const first = prf?.results?.first

  if (first) {
    return { credentialId, wrapping: await toWrappingKey(credentialId, first, purpose) }
  }

  if (prf?.enabled) {
    // Some platforms report PRF at registration but only evaluate it on an
    // assertion. That costs a second prompt, right now, while the user is
    // still looking at the screen — worse than one tap, better than a vault
    // that cannot be unlocked later.
    const wrapping = await assertWrappingKey({
      rpId,
      credentialIds: [credentialId],
      purpose,
      ...(opts.signal ? { signal: opts.signal } : {}),
    })
    return { credentialId, wrapping }
  }

  return { credentialId, wrapping: null }
}

/** Null means the passkey answered but this platform has no PRF to give. */
export async function assertWrappingKey(opts: AssertOptions = {}): Promise<WrappingKey | null> {
  const purpose = opts.purpose ?? 'vault'

  const assertion = (await navigator.credentials.get({
    publicKey: {
      challenge: randomChallenge(),
      rpId: opts.rpId ?? defaultRpId(),
      allowCredentials: (opts.credentialIds ?? []).map(toDescriptor),
      userVerification: 'required',
      extensions: { prf: { eval: { first: saltFor(purpose) } } },
    },
    ...(opts.signal ? { signal: opts.signal } : {}),
  })) as PublicKeyCredential | null

  if (!assertion) return null

  const first = assertion.getClientExtensionResults().prf?.results?.first
  if (!first) return null

  return toWrappingKey(encodeBase64url(new Uint8Array(assertion.rawId)), first, purpose)
}

/**
 * Did the user decline, rather than the platform fail?
 *
 * The two need different answers: a decline is a choice to respect quietly,
 * a failure is something to recover from.
 */
export function isUserCancelled(err: unknown): boolean {
  return err instanceof DOMException && (err.name === 'NotAllowedError' || err.name === 'AbortError')
}

// ---------------------------------------------------------------------------

function defaultRpId(): string {
  return currentRpId()
}

function saltFor(purpose: PrfPurpose): Uint8Array<ArrayBuffer> {
  return new TextEncoder().encode(PRF_SALTS[purpose])
}

/**
 * The challenge is random and nobody checks it.
 *
 * That reads like a bug and is not one: a challenge stops an assertion being
 * replayed against a verifier, and there is no verifier here. The output we
 * want is the PRF secret, which the authenticator only produces after user
 * verification.
 */
function randomChallenge(): Uint8Array<ArrayBuffer> {
  return crypto.getRandomValues(new Uint8Array(32))
}

function toDescriptor(id: string): PublicKeyCredentialDescriptor {
  return { type: 'public-key', id: decodeBase64url(id) }
}

/**
 * PRF output to wrapping key.
 *
 * Exported because a recovery runs its own assertion — it needs the escrow id
 * and the PRF secret from one ceremony — and a second spelling of this
 * derivation would be a vault nothing can open.
 */
export async function toWrappingKey(
  credentialId: string,
  prfOutput: BufferSource,
  purpose: PrfPurpose
): Promise<WrappingKey> {
  const material = await crypto.subtle.importKey('raw', prfOutput, 'HKDF', false, [
    'deriveKey',
    'deriveBits',
  ])
  const key = await crypto.subtle.deriveKey(
    {
      name: 'HKDF',
      hash: 'SHA-256',
      salt: saltFor(purpose),
      info: new TextEncoder().encode('ftw.wrap.v1'),
    },
    material,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt']
  )
  return { credentialId, source: 'prf', key, escrow: await escrowKeys(material) }
}

/**
 * The escrow's id, sealing key and write key, from PRF output already had.
 *
 * All three under PRF_SALTS.escrow and told apart by their info strings, so no
 * one of them is a function of another and none can be produced from the vault
 * key. The id is 32 bytes, which is what makes guessing one pointless — the
 * service has no listing and there is nothing else to go on.
 *
 * The write key is the third because reading and writing are not the same
 * right. A fresh install can read with the passkey alone, which is the whole
 * point of the escrow; writing has to prove it is the household, or anyone who
 * learns an id can overwrite their spare copy. Deriving it here means the same
 * one prompt yields it and it costs the household nothing.
 */
async function escrowKeys(material: CryptoKey): Promise<EscrowKeys> {
  const encoder = new TextEncoder()
  const salt = encoder.encode(PRF_SALTS.escrow)
  const idBits = await crypto.subtle.deriveBits(
    { name: 'HKDF', hash: 'SHA-256', salt, info: encoder.encode(ESCROW_ID_INFO) },
    material,
    256
  )
  const sealKey = await crypto.subtle.deriveKey(
    { name: 'HKDF', hash: 'SHA-256', salt, info: encoder.encode(ESCROW_KEY_INFO) },
    material,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt']
  )
  // @noble rather than WebCrypto, and not for taste: Ed25519 in WebCrypto is
  // recent enough that a phone in the field can be without it, and a household
  // that cannot sign is a household that cannot save. The curve is already in
  // the bundle for Noise.
  const writeSeed = new Uint8Array(
    await crypto.subtle.deriveBits(
      { name: 'HKDF', hash: 'SHA-256', salt, info: encoder.encode(ESCROW_WRITE_INFO) },
      material,
      256
    )
  )
  return {
    lookupId: encodeBase64url(new Uint8Array(idBits)),
    sealKey,
    writeKey: ed25519.getPublicKey(writeSeed),
    sign: (message: Uint8Array) => ed25519.sign(message, writeSeed),
  }
}
