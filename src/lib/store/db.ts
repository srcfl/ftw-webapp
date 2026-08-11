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
// 2 repairs the databases version 1 could leave behind. The launch probe in
// index.html used to create 'ftw' at version 1 with no object stores; an app
// opening the same version then got no upgrade callback and created none
// either, so every read and write failed for the life of the install. The
// probe no longer does that — but installs that already suffered it cannot be
// healed by prevention, only by a version they have not seen.
const DB_VERSION = 2

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
  /**
   * The rendezvous secret from the QR fragment. Optional only because rows
   * written before the v2 payload existed do not have one; a site without it
   * cannot derive a rotating handle and is re-paired rather than guessed at.
   */
  rendezvousSecret?: Uint8Array
  /**
   * The single-use code from the QR, kept so the first session can present it.
   *
   * It is not a second secret: it is on a sticker on the box. The box spends
   * it on the first handshake that carries it and remembers this device's key
   * instead, so a copy left here cannot pair anything a second time.
   */
  pairingCode?: Uint8Array
  /**
   * Whether Sourceful last confirmed that it holds a sealed copy of this home.
   *
   * Pairing tries to create one by default when the passkey supports it, but
   * this becomes true only after the service confirms the write. Only homes
   * marked here go into later copies, so one failed background save can never
   * turn into a false claim on the Box screen.
   *
   * See $lib/identity/escrow.
   */
  escrow?: boolean
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
      // Idempotent, so this doubles as the repair path: a database that was
      // created empty gets its stores, and one that already has them is
      // untouched. Data in an existing store is never rebuilt.
      type StoreName = 'meta' | 'keys' | 'sites' | 'snapshot' | 'tiles' | 'prefs'
      const ensure = (name: StoreName, options?: IDBObjectStoreParameters) => {
        if (!database.objectStoreNames.contains(name)) {
          database.createObjectStore(name, options)
        }
      }
      ensure('meta')
      ensure('keys')
      ensure('sites', { keyPath: 'siteId' })
      ensure('snapshot', { keyPath: 'siteId' })
      ensure('tiles', { keyPath: 'key' })
      ensure('prefs')
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
