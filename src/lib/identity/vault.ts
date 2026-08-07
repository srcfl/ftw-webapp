/* The key hierarchy.
 *
 * Four keys, and the difference between them is most of the architecture:
 *
 *   device key    X25519 static for Noise. Stored AES-GCM wrapped, once per
 *                 registered credential. An Apple passkey and an Android
 *                 passkey derive different PRF output, so the same key is
 *                 wrapped N times rather than derived N ways — classic key
 *                 wrapping, for the plain reason that nothing else works
 *                 across two platforms.
 *   wrapping key  derived from WebAuthn PRF at enrollment and before a
 *                 privileged command. Never stored, never at rest.
 *   escrow keys   an id and a sealing key, from the same PRF output as the
 *                 wrapping key and held apart from it by an HKDF salt. They
 *                 exist only where PRF does, because they are what lets a copy
 *                 leave this device. Both derivations live in ./prf.
 *   cache key     AES-GCM, non-extractable, sitting in IndexedDB unwrapped.
 *
 * A copy of the device key can leave this device, and only if the household
 * asks for it. exportDeviceSecret below hands the raw scalar to
 * $lib/identity/escrow, which seals it and gives it to Sourceful to hold. That
 * is what lets a home-screen install, whose storage starts empty, come back
 * without a pairing code, and it is why the passkey's own vendor now sits
 * inside the trust boundary for the households that opt in. The trade was
 * weighed and taken; docs/architecture.md, "The escrow, and the boundary it
 * moves", is where it is written down.
 *
 * The cache key is deliberately not PRF-wrapped. A cold start must paint the
 * last readings before any Face ID prompt — that is the point of the app — and
 * a prompt in front of the cache would trade that away for a guarantee we
 * cannot make anyway. The honest claim: it resists an offline read of the disk
 * and code running on another origin. It does not resist an attacker holding
 * the unlocked device, who can simply open the app and look.
 *
 * See docs/architecture.md, "Identity".
 */

import { openDB, type IDBPDatabase } from 'idb'
import { x25519 } from '@noble/curves/ed25519.js'
import { encodeBase64url } from './base64url'
import {
  assertWrappingKey,
  isUserCancelled,
  registerPasskey,
  webAuthnAvailable,
  type WrappingKey,
  type WrappingSource,
} from './prf'

export type { WrappingKey, WrappingSource } from './prf'

/** Stands in for a credential id on the no-PRF path. */
export const LOCAL_CREDENTIAL_ID = 'local'

export type VaultErrorCode =
  | 'E_VAULT_EMPTY'
  | 'E_VAULT_LOCKED'
  | 'E_VAULT_NO_COPY'
  | 'E_VAULT_LAST_COPY'
  | 'E_VAULT_OTHER_KEY'

export class VaultError extends Error {
  constructor(
    message: string,
    readonly code: VaultErrorCode,
    /** What the user does now. Never what broke inside. */
    readonly help: string
  ) {
    super(message)
    this.name = 'VaultError'
  }
}

// ---------------------------------------------------------------------------
// Storage
// ---------------------------------------------------------------------------

export interface VaultStore {
  get(key: string): Promise<unknown>
  put(key: string, value: unknown): Promise<void>
  del(key: string): Promise<void>
}

const DB_NAME = 'ftw-identity'
const DB_STORE = 'keys'

const K_VAULT = 'device-key'
const K_LOCAL_WRAP = 'local-wrap-key'
const K_USER_HANDLE = 'user-handle'

export function openVaultStore(): VaultStore {
  let db: Promise<IDBPDatabase> | null = null
  const conn = () =>
    (db ??= openDB(DB_NAME, 1, {
      upgrade(d) {
        d.createObjectStore(DB_STORE)
      },
    }))

  return {
    async get(key) {
      return (await conn()).get(DB_STORE, key)
    },
    async put(key, value) {
      await (await conn()).put(DB_STORE, value, key)
    },
    async del(key) {
      await (await conn()).delete(DB_STORE, key)
    },
  }
}

/**
 * In-memory store, for tests and the box simulator.
 *
 * jsdom has no IndexedDB, and the alternative is a shim dependency that ships
 * with nothing.
 */
export function memoryVaultStore(): VaultStore {
  const map = new Map<string, unknown>()
  return {
    async get(key) {
      return map.get(key)
    },
    async put(key, value) {
      map.set(key, value)
    },
    async del(key) {
      map.delete(key)
    },
  }
}

// ---------------------------------------------------------------------------
// What is stored
// ---------------------------------------------------------------------------

export interface WrappedCopy {
  credentialId: string
  source: WrappingSource
  iv: Uint8Array<ArrayBuffer>
  ct: Uint8Array<ArrayBuffer>
}

export interface VaultRecord {
  /** Raw X25519 public key: the Noise static this app presents to the box. */
  publicKey: Uint8Array
  copies: WrappedCopy[]
}

/**
 * The device key, as everything above it needs to see it.
 *
 * Deliberately not a CryptoKey: on browsers with WebCrypto X25519 the private
 * key is non-extractable and this is a handle to it, and where that is missing
 * it is bytes held by @noble. Noise needs exactly one operation on the static,
 * so exposing exactly that keeps both cases identical to the caller.
 */
export interface DeviceKey {
  readonly publicKey: Uint8Array
  /** Noise's DH over the static. Throws on a low-order peer key. */
  diffieHellman(peerPublic: Uint8Array): Promise<Uint8Array>
}

// ---------------------------------------------------------------------------
// Reads that never prompt
// ---------------------------------------------------------------------------

export async function isEnrolled(store: VaultStore): Promise<boolean> {
  return (await readVault(store)) !== null
}

/** The Noise static, readable without unwrapping anything. */
export async function deviceStaticPublic(store: VaultStore): Promise<Uint8Array | null> {
  return (await readVault(store))?.publicKey ?? null
}

export async function enrolledCredentialIds(store: VaultStore): Promise<string[]> {
  return (await readVault(store))?.copies.map((c) => c.credentialId) ?? []
}

/**
 * Only the copies a passkey stands behind.
 *
 * The local copy is deliberately not one: it exists so that reading never
 * costs a prompt, and asking an authenticator for a credential id that is not
 * an authenticator's would either fail or, worse, silently succeed with no
 * ceremony. See stepup.ts.
 */
export async function passkeyCredentialIds(store: VaultStore): Promise<string[]> {
  const record = await readVault(store)
  return record?.copies.filter((c) => c.source === 'prf').map((c) => c.credentialId) ?? []
}

/**
 * The name this device answers to on the box's list of paired phones.
 *
 * The box names a row by the first eight characters of the base64url of the
 * static key it authenticated — appenroll.deviceID in srcfl/ftw. It is a
 * prefix, not a key: enough to find the row and remove it, not enough to
 * impersonate anyone. Computed here rather than asked for, because someone
 * signing out needs it exactly when the box is out of reach.
 */
export async function deviceIdOnBox(store: VaultStore): Promise<string | null> {
  const publicKey = await deviceStaticPublic(store)
  return publicKey ? encodeBase64url(publicKey).slice(0, BOX_DEVICE_ID_CHARS) : null
}

/** appenroll.deviceID's prefix length. A test pins the two together. */
export const BOX_DEVICE_ID_CHARS = 8

// ---------------------------------------------------------------------------
// The device key
// ---------------------------------------------------------------------------

/**
 * The device key for this install, created on first use.
 *
 * It is the device's identity, not the box's, so pairing a second box reuses
 * it rather than rotating — rotating would silently orphan the first box.
 */
export async function deviceKey(store: VaultStore, wrapping: WrappingKey): Promise<DeviceKey> {
  const record = await readVault(store)
  if (!record) return createDeviceKey(store, wrapping)

  const copy = record.copies.find((c) => c.credentialId === wrapping.credentialId)
  if (!copy) throw noCopy(wrapping.credentialId)

  const pkcs8 = await unseal(wrapping.key, copy)
  try {
    return await importDeviceKey(pkcs8, record.publicKey)
  } finally {
    pkcs8.fill(0)
  }
}

/**
 * The Noise static as raw bytes, for the one caller allowed to copy it off
 * this device.
 *
 * Everything else in this file hands out a DeviceKey, which can do a Diffie-
 * Hellman and nothing else, precisely so no layer above can read the scalar by
 * accident. This is the deliberate hole in that: a recovery copy has to carry
 * the key itself, because a key the box already trusts is what lets a fresh
 * install come back without a pairing code.
 *
 * The caller zeroes what it gets. See $lib/identity/escrow for what is done
 * with it and what that costs.
 */
export async function exportDeviceSecret(
  store: VaultStore,
  wrapping: WrappingKey
): Promise<Uint8Array<ArrayBuffer>> {
  const record = await readVault(store)
  if (!record) throw emptyVault()

  const copy = record.copies.find((c) => c.credentialId === wrapping.credentialId)
  if (!copy) throw noCopy(wrapping.credentialId)

  const pkcs8 = await unseal(wrapping.key, copy)
  try {
    return pkcs8.slice(PKCS8_X25519_PREFIX.length)
  } finally {
    pkcs8.fill(0)
  }
}

/**
 * Put back a device key that came from outside this install.
 *
 * Every other path in here mints a key; this one is handed the scalar a sealed
 * copy was carrying, and writing it rather than generating a new one is the
 * point — it is the Noise static the box already trusts, so the phone is
 * paired again without a code the box would refuse.
 *
 * It refuses to sit on top of a different identity. An install that already
 * has a device key is not the install this is for, and overwriting one would
 * orphan whatever it is paired to.
 */
export async function restoreDeviceKey(
  store: VaultStore,
  wrapping: WrappingKey,
  scalar: Uint8Array
): Promise<DeviceKey> {
  const publicKey = x25519.getPublicKey(scalar)
  const existing = await readVault(store)
  if (existing && !sameBytes(existing.publicKey, publicKey)) {
    throw new VaultError(
      'a different device key is already stored',
      'E_VAULT_OTHER_KEY',
      'This phone is already set up for a home. Sign out of it first.'
    )
  }

  const pkcs8 = new Uint8Array(PKCS8_X25519_PREFIX.length + 32)
  pkcs8.set(PKCS8_X25519_PREFIX)
  pkcs8.set(scalar, PKCS8_X25519_PREFIX.length)
  try {
    const sealed = await seal(wrapping.key, pkcs8)
    const copies = (existing?.copies ?? []).filter((c) => c.credentialId !== wrapping.credentialId)
    copies.push({ credentialId: wrapping.credentialId, source: wrapping.source, ...sealed })
    await store.put(K_VAULT, { publicKey, copies } satisfies VaultRecord)
    return await importDeviceKey(pkcs8, publicKey)
  } finally {
    pkcs8.fill(0)
  }
}

/**
 * Wrap the existing device key under a second credential.
 *
 * `current` must already open the vault; that is the whole security argument
 * for adding a credential — you prove you can unlock before you widen access.
 */
export async function addCredential(
  store: VaultStore,
  current: WrappingKey,
  next: WrappingKey
): Promise<void> {
  const record = await readVault(store)
  if (!record) throw emptyVault()

  const copy = record.copies.find((c) => c.credentialId === current.credentialId)
  if (!copy) throw noCopy(current.credentialId)

  const pkcs8 = await unseal(current.key, copy)
  try {
    const sealed = await seal(next.key, pkcs8)
    const copies = record.copies.filter((c) => c.credentialId !== next.credentialId)
    copies.push({ credentialId: next.credentialId, source: next.source, ...sealed })
    await store.put(K_VAULT, { publicKey: record.publicKey, copies } satisfies VaultRecord)
  } finally {
    pkcs8.fill(0)
  }
}

/** Refuses the last copy: dropping it would strand the device key for good. */
export async function removeCredential(store: VaultStore, credentialId: string): Promise<void> {
  const record = await readVault(store)
  if (!record) throw emptyVault()

  const copies = record.copies.filter((c) => c.credentialId !== credentialId)
  if (copies.length === record.copies.length) return
  if (copies.length === 0) {
    throw new VaultError(
      'refusing to remove the only wrapped copy',
      'E_VAULT_LAST_COPY',
      'That is the only passkey that can unlock this device. Add another one first.'
    )
  }

  await store.put(K_VAULT, { publicKey: record.publicKey, copies } satisfies VaultRecord)
}

/**
 * Forget this device's identity.
 *
 * Identity only — the sealed snapshot and the key that opens it live in the
 * projection store, not here, and clearing one without the other is how a
 * phone gets handed on with the previous household's readings still able to
 * paint on the first frame. Callers wanting a true reset use
 * forgetEverything() in $lib/store/reset, which covers both.
 */
export async function resetIdentity(store: VaultStore): Promise<void> {
  await store.del(K_VAULT)
  await store.del(K_LOCAL_WRAP)
  await store.del(K_USER_HANDLE)
}

// ---------------------------------------------------------------------------
// Getting a wrapping key — the part the user experiences
// ---------------------------------------------------------------------------

export interface PasskeyOptions {
  rpId?: string
  rpName?: string
  label?: string
  signal?: AbortSignal
}

/**
 * A wrapping key for a device enrolling now: one prompt, no questions.
 *
 * Where PRF is missing this still returns a key, backed by a non-extractable
 * key in IndexedDB. Refusing to enrol would be technically purer and would
 * leave the user holding a phone that cannot be told why. The weaker guarantee
 * travels with the key as `source`, and the UI says it plainly.
 */
export async function enrollWrappingKey(
  store: VaultStore,
  opts: PasskeyOptions = {}
): Promise<WrappingKey> {
  if (!webAuthnAvailable()) return localWrappingKey(store)

  try {
    const registration = await registerPasskey({
      ...opts,
      userHandle: await userHandle(store),
      excludeCredentialIds: await enrolledCredentialIds(store),
    })
    return registration.wrapping ?? (await localWrappingKey(store))
  } catch (err) {
    // A decline is an answer; anything else is this platform failing at
    // something the user cannot fix, so we carry on rather than dead-end.
    if (isUserCancelled(err)) throw err
    return localWrappingKey(store)
  }
}

/** The wrapping key for a device already enrolled. One prompt, no questions. */
export async function unlockWrappingKey(
  store: VaultStore,
  opts: PasskeyOptions = {}
): Promise<WrappingKey> {
  const record = await readVault(store)
  if (!record) throw emptyVault()

  const passkeyIds = record.copies.filter((c) => c.source === 'prf').map((c) => c.credentialId)
  if (passkeyIds.length > 0 && webAuthnAvailable()) {
    try {
      const wrapping = await assertWrappingKey({ ...opts, credentialIds: passkeyIds })
      if (wrapping) return wrapping
    } catch (err) {
      // A decline stays a decline. Answering it with "set this device up
      // again" would tell someone whose only mistake was tapping cancel to
      // throw away a device that is working perfectly.
      if (isUserCancelled(err)) throw err
    }
  }

  if (record.copies.some((c) => c.credentialId === LOCAL_CREDENTIAL_ID)) {
    return localWrappingKey(store)
  }

  throw new VaultError(
    'no wrapping key could be obtained for any stored copy',
    'E_VAULT_LOCKED',
    'This device can no longer unlock its key. Scan the code on your box to set it up again.'
  )
}

/**
 * The wrapping key for connecting, without a prompt — or null.
 *
 * Reading is not a privilege. The invariant is that nothing stands before the
 * first frame — not a network round trip, not a passkey sheet — and a Face ID
 * prompt on every reconnect taught people that opening the app costs a
 * ceremony. So connecting unlocks with the local copy, silently.
 *
 * PRF still guards what it was always for: enrolling this device, and the
 * privileged commands that will demand a fresh assertion. The honest claim
 * for the local copy is the cache key's claim — it resists an offline disk
 * read and other origins, not someone holding the unlocked phone. That
 * person can already read the house by opening the app.
 *
 * Null means only PRF copies exist (a device enrolled before the local copy
 * existed). The caller prompts once and calls ensureLocalCopy, and every
 * start after that is silent.
 */
export async function silentWrappingKey(store: VaultStore): Promise<WrappingKey | null> {
  const record = await readVault(store)
  if (!record) throw emptyVault()

  if (record.copies.some((c) => c.credentialId === LOCAL_CREDENTIAL_ID)) {
    return localWrappingKey(store)
  }
  return null
}

/**
 * Add the local copy, so the next start never prompts.
 *
 * The self-healing half of the migration: a device enrolled when PRF wrapped
 * the only copy pays one last prompt, and this turns it into the layout new
 * enrollments get from the start.
 */
export async function ensureLocalCopy(store: VaultStore, current: WrappingKey): Promise<void> {
  const record = await readVault(store)
  if (!record) throw emptyVault()
  if (record.copies.some((c) => c.credentialId === LOCAL_CREDENTIAL_ID)) return

  await addCredential(store, current, await localWrappingKey(store))
}

/**
 * The fallback wrapping key: non-extractable, in IndexedDB, no user
 * verification in front of it.
 *
 * It protects the device key against an offline read of the disk and against
 * code on another origin. It does not protect it against someone holding the
 * unlocked phone. That is the same claim the cache key makes, and it is the
 * most that can be said without PRF.
 */
export async function localWrappingKey(store: VaultStore): Promise<WrappingKey> {
  const existing = await store.get(K_LOCAL_WRAP)
  if (existing) {
    return { credentialId: LOCAL_CREDENTIAL_ID, source: 'local', key: existing as CryptoKey }
  }

  const key = await crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, false, [
    'encrypt',
    'decrypt',
  ])
  await store.put(K_LOCAL_WRAP, key)
  return { credentialId: LOCAL_CREDENTIAL_ID, source: 'local', key }
}

// ---------------------------------------------------------------------------

async function createDeviceKey(store: VaultStore, wrapping: WrappingKey): Promise<DeviceKey> {
  const { pkcs8, publicKey } = await generatePrivate()
  try {
    const sealed = await seal(wrapping.key, pkcs8)
    const record: VaultRecord = {
      publicKey,
      copies: [{ credentialId: wrapping.credentialId, source: wrapping.source, ...sealed }],
    }
    await store.put(K_VAULT, record)
    return await importDeviceKey(pkcs8, publicKey)
  } finally {
    pkcs8.fill(0)
  }
}

async function readVault(store: VaultStore): Promise<VaultRecord | null> {
  const record = (await store.get(K_VAULT)) as VaultRecord | undefined
  return record ?? null
}

async function userHandle(store: VaultStore): Promise<Uint8Array<ArrayBuffer>> {
  const existing = await store.get(K_USER_HANDLE)
  if (existing) return existing as Uint8Array<ArrayBuffer>

  // Stable per install, so registering a second passkey replaces the first in
  // the platform's list instead of stacking up identical-looking entries.
  const handle = crypto.getRandomValues(new Uint8Array(16))
  await store.put(K_USER_HANDLE, handle)
  return handle
}

function sameBytes(a: Uint8Array, b: Uint8Array): boolean {
  return a.length === b.length && a.every((byte, i) => byte === b[i])
}

function noCopy(credentialId: string): VaultError {
  return new VaultError(
    `no wrapped copy for credential ${credentialId}`,
    'E_VAULT_NO_COPY',
    'This passkey has not been given access yet. Unlock with the one you set up first.'
  )
}

function emptyVault(): VaultError {
  return new VaultError(
    'no device key has been created',
    'E_VAULT_EMPTY',
    'Scan the code on your box to set this device up.'
  )
}

async function seal(
  key: CryptoKey,
  plain: Uint8Array<ArrayBuffer>
): Promise<{ iv: Uint8Array<ArrayBuffer>; ct: Uint8Array<ArrayBuffer> }> {
  const iv = crypto.getRandomValues(new Uint8Array(12))
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, plain))
  return { iv, ct }
}

async function unseal(key: CryptoKey, copy: WrappedCopy): Promise<Uint8Array<ArrayBuffer>> {
  try {
    return new Uint8Array(
      await crypto.subtle.decrypt({ name: 'AES-GCM', iv: copy.iv }, key, copy.ct)
    )
  } catch {
    throw new VaultError(
      `the wrapping key does not open the copy for ${copy.credentialId}`,
      'E_VAULT_LOCKED',
      'This device can no longer unlock its key. Scan the code on your box to set it up again.'
    )
  }
}

// ---------------------------------------------------------------------------
// X25519, two ways
//
// WebCrypto is preferred: its private key is non-extractable, so nothing above
// this file can read the Noise static even by accident. Chrome only shipped
// X25519 in 133 and PRF long before it, so a phone can have passkeys and no
// curve — falling back to @noble there is the difference between the app
// working and the app explaining itself.
// ---------------------------------------------------------------------------

/** DER header for a PKCS#8 X25519 private key. The scalar is the last 32 B. */
const PKCS8_X25519_PREFIX = new Uint8Array([
  0x30, 0x2e, 0x02, 0x01, 0x00, 0x30, 0x05, 0x06, 0x03, 0x2b, 0x65, 0x6e, 0x04, 0x22, 0x04, 0x20,
])

let x25519Probe: Promise<boolean> | null = null

function webcryptoHasX25519(): Promise<boolean> {
  x25519Probe ??= crypto.subtle.generateKey({ name: 'X25519' }, true, ['deriveBits']).then(
    () => true,
    () => false
  )
  return x25519Probe
}

async function generatePrivate(): Promise<{
  pkcs8: Uint8Array<ArrayBuffer>
  publicKey: Uint8Array
}> {
  if (await webcryptoHasX25519()) {
    const pair = (await crypto.subtle.generateKey({ name: 'X25519' }, true, [
      'deriveBits',
    ])) as CryptoKeyPair
    return {
      pkcs8: new Uint8Array(await crypto.subtle.exportKey('pkcs8', pair.privateKey)),
      publicKey: new Uint8Array(await crypto.subtle.exportKey('raw', pair.publicKey)),
    }
  }

  const pair = x25519.keygen()
  const pkcs8 = new Uint8Array(PKCS8_X25519_PREFIX.length + 32)
  pkcs8.set(PKCS8_X25519_PREFIX)
  pkcs8.set(pair.secretKey, PKCS8_X25519_PREFIX.length)
  return { pkcs8, publicKey: pair.publicKey }
}

/** Copies whatever it keeps, so the caller can zero `pkcs8` straight after. */
async function importDeviceKey(
  pkcs8: Uint8Array<ArrayBuffer>,
  publicKey: Uint8Array
): Promise<DeviceKey> {
  if (await webcryptoHasX25519()) {
    const priv = await crypto.subtle.importKey('pkcs8', pkcs8, { name: 'X25519' }, false, [
      'deriveBits',
    ])
    return {
      publicKey,
      async diffieHellman(peerPublic) {
        // Copied rather than cast: WebCrypto refuses a view whose buffer
        // TypeScript thinks might be shared, and 32 bytes is cheap.
        const peer = await crypto.subtle.importKey(
          'raw',
          new Uint8Array(peerPublic),
          { name: 'X25519' },
          false,
          []
        )
        return new Uint8Array(
          await crypto.subtle.deriveBits({ name: 'X25519', public: peer }, priv, 256)
        )
      },
    }
  }

  // The scalar lives in JS memory for as long as this handle does. Stated, not
  // hidden: it is the cost of the browsers that have no curve to hold it in.
  const secret = pkcs8.slice(PKCS8_X25519_PREFIX.length)
  return {
    publicKey,
    async diffieHellman(peerPublic) {
      return x25519.getSharedSecret(secret, peerPublic)
    },
  }
}
