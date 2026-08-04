/* The local projection.
 *
 * Browser storage is a cache, never the original. The box holds the record;
 * this exists so the app can paint in the first frame instead of waiting for
 * a network round trip. If a browser evicts it, the app is slower on the next
 * start and nothing is lost.
 *
 * Sealed with a non-extractable AES-GCM key that is deliberately NOT behind
 * the passkey. Gating reads on Face ID would mean a cold start shows nothing
 * until the user authenticates, which is exactly the experience this whole
 * app exists to avoid. See docs/architecture.md — the honest claim is that
 * this resists offline disk reads and code on other origins, not an attacker
 * holding the unlocked device.
 */

import { openDB, type DBSchema, type IDBPDatabase } from 'idb'

const DB_NAME = 'ftw'
const DB_VERSION = 1

export interface StoredSnapshot {
  siteId: string
  /** Wall-clock time this was written. Only ever used to show the user how
   *  old a cached view is — never for protocol freshness, which uses the
   *  box's uptime. */
  savedAtMs: number
  /** Box uptime at capture, so ages stay correct across a reload. */
  uptimeMs: number
  fields: Record<string, number>
  sources: Record<string, unknown>
  dispatchBlockedBy: string[]
  dict: Record<string, unknown>
  controlRev: number
}

export interface StoredSite {
  siteId: string
  label: string
  /** Box's static Noise key, pinned optically at enrollment. */
  boxStaticKey: Uint8Array
  addedAtMs: number
  lastSeenAtMs: number
}

interface FtwSchema extends DBSchema {
  meta: {
    key: string
    value: unknown
  }
  /** Non-extractable CryptoKeys. IndexedDB can store these without ever
   *  exposing their bytes to script, which is the whole reason they live
   *  here rather than in localStorage. */
  keys: {
    key: string
    value: CryptoKey
  }
  sites: {
    key: string
    value: StoredSite
  }
  snapshot: {
    key: string
    value: StoredSnapshot
  }
  /** History tiles, keyed siteId:res:tileId. Immutable once closed. */
  tiles: {
    key: string
    value: {
      key: string
      siteId: string
      res: string
      tileId: string
      etag: string
      startMs: number
      stepMs: number
      series: string[]
      data: Uint8Array
      savedAtMs: number
    }
  }
  /** UI preferences. Plaintext on purpose — nothing here is private, and
   *  encrypting it would put a decrypt on the first-frame path. */
  prefs: {
    key: string
    value: unknown
  }
}

export type FtwDB = IDBPDatabase<FtwSchema>

let dbPromise: Promise<FtwDB> | null = null

/**
 * Open the database. Idempotent, and started as early as possible — the open
 * itself costs a few milliseconds that are better spent before the bundle
 * finishes evaluating than after.
 */
export function db(): Promise<FtwDB> {
  dbPromise ??= openDB<FtwSchema>(DB_NAME, DB_VERSION, {
    upgrade(database) {
      database.createObjectStore('meta')
      database.createObjectStore('keys')
      database.createObjectStore('sites', { keyPath: 'siteId' })
      database.createObjectStore('snapshot', { keyPath: 'siteId' })
      database.createObjectStore('tiles', { keyPath: 'key' })
      database.createObjectStore('prefs')
    },
    blocked() {
      // Another tab holds an older version open. Nothing to do but wait; the
      // user sees the app they already have, which is the right outcome.
      console.warn('ftw: database upgrade blocked by another tab')
    },
  })

  return dbPromise
}

/** Test seam. Not used in the app. */
export function resetDbForTests(): void {
  dbPromise = null
}

/**
 * Ask the browser to keep this data.
 *
 * Best effort by definition — the browser decides. On iOS, script-writable
 * storage is evicted after seven days of inactivity unless the app was added
 * to the home screen, which is why enrollment pushes for that before writing
 * any key.
 */
export async function requestPersistence(): Promise<boolean> {
  if (!navigator.storage?.persist) return false
  try {
    return await navigator.storage.persist()
  } catch {
    return false
  }
}
