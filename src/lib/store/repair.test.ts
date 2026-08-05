// @vitest-environment jsdom
import { describe, it, expect } from 'vitest'
import 'fake-indexeddb/auto'
import { openDB } from 'idb'

/* An install that already lost its schema must heal itself.
 *
 * Version 1 of this database could be created empty, by a launch probe that
 * only wanted to read a snapshot. Every read and write then failed for the
 * life of the install, and no amount of fixing the probe helps a phone that
 * is already in that state — a version it has not seen is the only way back.
 *
 * These tests build the broken state deliberately and then open the database
 * the way the app does.
 */

const STORES = ['meta', 'keys', 'sites', 'snapshot', 'tiles', 'prefs'] as const

/** The exact upgrade db.ts runs, isolated so a test can drive it by name. */
function ensureStores(database: IDBDatabase): void {
  const ensure = (name: string, options?: IDBObjectStoreParameters) => {
    if (!database.objectStoreNames.contains(name)) database.createObjectStore(name, options)
  }
  ensure('meta')
  ensure('keys')
  ensure('sites', { keyPath: 'siteId' })
  ensure('snapshot', { keyPath: 'siteId' })
  ensure('tiles', { keyPath: 'key' })
  ensure('prefs')
}

function createEmptyV1(name: string): Promise<void> {
  return new Promise((resolve) => {
    const req = indexedDB.open(name, 1)
    req.onupgradeneeded = () => {
      /* the fault: a version 1 with no stores at all */
    }
    req.onsuccess = () => {
      req.result.close()
      resolve()
    }
  })
}

describe('a database left empty by version 1', () => {
  it('gets its stores back when the app opens version 2', async () => {
    const name = `ftw-repair-${Math.random().toString(36).slice(2)}`
    await createEmptyV1(name)

    const db = await openDB(name, 2, { upgrade: (d) => ensureStores(d as unknown as IDBDatabase) })
    expect([...db.objectStoreNames].sort()).toEqual([...STORES].sort())

    // And it works: a site written after the repair reads back.
    await db.put('sites', { siteId: 'abc', label: 'Home' })
    expect(await db.get('sites', 'abc')).toMatchObject({ siteId: 'abc', label: 'Home' })
    db.close()
  })

  it('leaves a healthy database and its rows alone', async () => {
    const name = `ftw-healthy-${Math.random().toString(36).slice(2)}`

    const first = await openDB(name, 2, {
      upgrade: (d) => ensureStores(d as unknown as IDBDatabase),
    })
    await first.put('sites', { siteId: 'keep-me', label: 'Home' })
    first.close()

    let upgraded = false
    const again = await openDB(name, 2, {
      upgrade: (d) => {
        upgraded = true
        ensureStores(d as unknown as IDBDatabase)
      },
    })

    expect(upgraded, 'no upgrade runs on a database already at this version').toBe(false)
    expect(await again.get('sites', 'keep-me')).toMatchObject({ label: 'Home' })
    again.close()
  })
})
