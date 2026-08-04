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

import { encodeBase64url, decodeBase64url } from './base64url'

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
} as const

export type PrfPurpose = keyof typeof PRF_SALTS

/** Where a wrapping key came from. The UI states this; it never hides it. */
export type WrappingSource = 'prf' | 'local'

export interface WrappingKey {
  /** base64url credential id, or LOCAL_CREDENTIAL_ID on the fallback path. */
  credentialId: string
  source: WrappingSource
  /** AES-GCM 256, non-extractable, encrypt/decrypt only. */
  key: CryptoKey
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
      rp: { id: rpId, name: opts.rpName ?? 'FTW' },
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
  return globalThis.location?.hostname ?? ''
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

async function toWrappingKey(
  credentialId: string,
  prfOutput: BufferSource,
  purpose: PrfPurpose
): Promise<WrappingKey> {
  const material = await crypto.subtle.importKey('raw', prfOutput, 'HKDF', false, ['deriveKey'])
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
  return { credentialId, source: 'prf', key }
}
