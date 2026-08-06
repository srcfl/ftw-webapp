/* Signing out, and being interrupted while doing it.
 *
 * Two databases and one localStorage pointer hold a home on this phone, and
 * the order they are cleared in is the whole design. Every point this can be
 * killed at has to leave a device that either still works or is back at
 * pairing — never one holding a home it can no longer reach.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest'
import 'fake-indexeddb/auto'
import { db, type StoredSite } from './db'
import { forgetEverything, PROJECTION } from './reset'
import { currentSiteId } from '$lib/identity/pairing'
import {
  deviceKey,
  isEnrolled,
  localWrappingKey,
  memoryVaultStore,
} from '$lib/identity/vault'

const SITE_ID = 'sim-0001'

function siteRow(): StoredSite {
  return {
    siteId: SITE_ID,
    label: 'Home',
    boxStaticKey: new Uint8Array(32).fill(7),
    rendezvousSecret: new Uint8Array(32).fill(9),
    addedAtMs: Date.now(),
    lastSeenAtMs: Date.now(),
  }
}

/** A vault holding a real device key, as a paired phone has. */
async function pairedVault() {
  const vault = memoryVaultStore()
  await deviceKey(vault, await localWrappingKey(vault))
  return vault
}

/** Neither Node nor jsdom gives this environment a localStorage. */
function stubStorage(): Storage {
  const map = new Map<string, string>()
  return {
    get length() {
      return map.size
    },
    clear: () => map.clear(),
    getItem: (k: string) => map.get(k) ?? null,
    key: (i: number) => [...map.keys()][i] ?? null,
    removeItem: (k: string) => void map.delete(k),
    setItem: (k: string, v: string) => void map.set(k, v),
  }
}

describe('signing out', () => {
  beforeEach(async () => {
    vi.restoreAllMocks()
    vi.stubGlobal('localStorage', stubStorage())
    const database = await db()
    for (const store of ['sites', 'snapshot', 'tiles', 'meta', 'keys'] as const) {
      await database.clear(store)
    }
  })

  it('leaves nothing pointing at a home that is gone', async () => {
    const database = await db()
    await database.put('sites', siteRow())
    // The pointer the inline boot script reads before the bundle is parsed.
    // Left behind, the next launch names a home whose row no longer exists —
    // and the app opens on an empty house with no way back to pairing.
    localStorage.setItem('ftw.site', SITE_ID)

    await forgetEverything(await pairedVault())

    expect(await currentSiteId()).toBeNull()
  })

  it('leaves no home this phone has lost the key to', async () => {
    const vault = await pairedVault()
    const database = await db()
    await database.put('sites', siteRow())
    localStorage.setItem('ftw.site', SITE_ID)

    // The interruption: the disk refuses partway through. A killed tab or a
    // quota failure lands in the same place.
    vi.spyOn(database, 'clear').mockRejectedValue(new Error('quota exceeded'))

    await expect(forgetEverything(vault)).rejects.toThrow()

    // The row survived, so the key that reaches it has to survive too.
    // Identity without rows is a device back at pairing; rows without identity
    // is a house on screen that can never be reached again, and no amount of
    // reloading fixes it.
    expect(await database.get('sites', SITE_ID)).toBeTruthy()
    expect(await isEnrolled(vault), 'the key was thrown away before the home it opens').toBe(true)
  })

  it('keeps the cache key while a row it sealed is still on the disk', async () => {
    // The partial failure, which the all-or-nothing case above cannot reach:
    // one store refuses and the rest succeed. If the key goes while a sealed
    // snapshot stays, the next launch mints a fresh key, unsealing throws
    // where nothing catches it, and the app paints nothing — a phone that
    // cannot be fixed by reloading, in an app whose principle is that
    // reloading is never the fix.
    const vault = await pairedVault()
    const database = await db()
    await database.put('sites', siteRow())

    const real = database.clear.bind(database)
    const cleared: string[] = []
    const spy = vi.spyOn(database, 'clear').mockImplementation(async (store) => {
      cleared.push(store)
      if (store === 'snapshot') throw new Error('quota exceeded')
      return real(store)
    })

    await expect(forgetEverything(vault)).rejects.toThrow()
    expect(spy).toHaveBeenCalled()
    expect(cleared, 'the key was cleared while a sealed row survived').not.toContain('keys')
    expect(cleared, 'it gave up instead of clearing what it safely could').toContain('sites')
  })

  it('keeps what was never the household\'s: how this phone shows things', async () => {
    const database = await db()
    await database.put('sites', siteRow())
    await database.put('prefs', 'always', 'units')

    await forgetEverything(await pairedVault())

    // Theme and units belong to whoever is holding the phone, not to the home
    // it just left. Clearing them makes signing out feel like something went
    // wrong, and there is nothing of the previous household in them.
    expect(await database.get('prefs', 'units')).toBe('always')
  })

  it('clears every store the database has, bar the one it means to keep', async () => {
    // The list of stores to clear is written by hand, and nothing but this
    // holds it to the schema. A sixth household store added later would be
    // skipped in silence — on the one path whose whole job is handing a phone
    // on with nothing of the last household left readable on it.
    //
    // So: every store the database actually has is either cleared or is
    // 'prefs'. Adding a store to db.ts and not to PROJECTION fails here.
    const database = await db()
    const inSchema = [...database.objectStoreNames].sort()

    expect(inSchema).toEqual([...PROJECTION, 'prefs'].sort())
  })

  it('clears the key and the rows together when it does finish', async () => {
    const vault = await pairedVault()
    const database = await db()
    await database.put('sites', siteRow())
    localStorage.setItem('ftw.site', SITE_ID)

    await forgetEverything(vault)

    expect(await database.get('sites', SITE_ID)).toBeUndefined()
    expect(await isEnrolled(vault)).toBe(false)
    expect(await currentSiteId()).toBeNull()
  })
})
