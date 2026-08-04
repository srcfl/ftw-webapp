/* Sealing the local projection.
 *
 * One AES-GCM key, generated on first run, non-extractable, kept in
 * IndexedDB. Script can use it but never read its bytes; nothing outside this
 * origin can reach it at all.
 *
 * It is deliberately not derived from the passkey. Deriving it would put a
 * WebAuthn ceremony on the cold-start path, so pressing the icon would show
 * a Face ID sheet before it showed a single watt. That trade buys protection
 * only against an attacker who already has the device unlocked — and costs
 * the one property the whole app is built around.
 *
 * What this actually protects against, stated plainly:
 *   - reading the profile off disk later, on a lost or discarded device
 *   - any other origin, which cannot touch this key or this database
 * What it does not protect against:
 *   - an attacker using the unlocked device
 *   - anyone who can run code on this origin
 */

import { db } from './db'

const CACHE_KEY_ID = 'cache.v1'
const IV_BYTES = 12

/**
 * Get the cache key, generating it on first use.
 *
 * Racing callers are fine: a duplicate generate is cheap, and the last write
 * wins consistently because both would be unreachable anyway if the first
 * had already sealed something.
 */
export async function cacheKey(): Promise<CryptoKey> {
  const database = await db()

  const existing = await database.get('keys', CACHE_KEY_ID)
  if (existing) return existing

  const key = await crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, false, [
    'encrypt',
    'decrypt',
  ])

  await database.put('keys', key, CACHE_KEY_ID)
  return key
}

/**
 * Bytes backed by a plain ArrayBuffer.
 *
 * WebCrypto will not take a view over a SharedArrayBuffer, and since
 * TypeScript 5.7 `Uint8Array` is generic over its buffer, so the distinction
 * is now visible in the types. Being explicit here beats casting at each of
 * the four call sites.
 */
export type Bytes = Uint8Array<ArrayBuffer>

export async function seal(key: CryptoKey, plaintext: Bytes): Promise<Bytes> {
  const iv = crypto.getRandomValues(new Uint8Array(IV_BYTES))
  const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, plaintext)

  const out = new Uint8Array(IV_BYTES + ct.byteLength) as Bytes
  out.set(iv, 0)
  out.set(new Uint8Array(ct), IV_BYTES)
  return out
}

/**
 * Open a sealed blob. Returns null rather than throwing when it cannot.
 *
 * A cache that fails to open is not an error worth surfacing: the app drops
 * to its empty state and refetches, which is what it would do on a first run
 * anyway. Throwing here would turn a stale key into a broken app.
 */
export async function unseal(key: CryptoKey, sealed: Bytes): Promise<Bytes | null> {
  if (sealed.length <= IV_BYTES) return null

  try {
    const iv = sealed.subarray(0, IV_BYTES)
    const ct = sealed.subarray(IV_BYTES)
    const pt = await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, key, ct)
    return new Uint8Array(pt) as Bytes
  } catch {
    return null
  }
}

const encoder = new TextEncoder()
const decoder = new TextDecoder()

export async function sealJson(key: CryptoKey, value: unknown): Promise<Bytes> {
  return seal(key, encoder.encode(JSON.stringify(value)) as Bytes)
}

export async function unsealJson<T>(key: CryptoKey, sealed: Bytes): Promise<T | null> {
  const pt = await unseal(key, sealed)
  if (!pt) return null
  try {
    return JSON.parse(decoder.decode(pt)) as T
  } catch {
    return null
  }
}
