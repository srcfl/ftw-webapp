// @vitest-environment jsdom
import { describe, it, expect } from 'vitest'
import 'fake-indexeddb/auto'

/* The launch probe must never build the database.
 *
 * index.html opens 'ftw' at version 1 before the bundle parses, to paint the
 * last readings in the first frame. If that open CREATES the database — which
 * it does when none exists — it creates it empty, and db.ts opening the same
 * version afterwards gets no upgrade callback and therefore creates no object
 * stores. Every read and write is then broken for the life of the install,
 * and the user meets a pairing screen for a house they already paired.
 *
 * These tests drive the two opens in the order a cold launch does.
 */

/** Exactly what the inline script in index.html does, aborting on upgrade. */
function bootProbe(name: string): Promise<string[]> {
  return new Promise((resolve) => {
    const req = indexedDB.open(name, 1)
    req.onerror = () => resolve([])
    req.onupgradeneeded = () => {
      try {
        req.transaction!.abort()
      } catch {
        /* nothing to undo */
      }
      resolve([])
    }
    req.onsuccess = () => {
      const d = req.result
      const names = [...d.objectStoreNames]
      d.close()
      resolve(names)
    }
  })
}

/** Stands in for db.ts: same name, same version, creates the schema. */
function appOpen(name: string): Promise<{ upgraded: boolean; stores: string[] }> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(name, 1)
    let upgraded = false
    req.onupgradeneeded = () => {
      upgraded = true
      req.result.createObjectStore('sites', { keyPath: 'siteId' })
      req.result.createObjectStore('snapshot', { keyPath: 'siteId' })
    }
    req.onerror = () => reject(req.error)
    req.onsuccess = () => {
      const d = req.result
      const out = { upgraded, stores: [...d.objectStoreNames].sort() }
      d.close()
      resolve(out)
    }
  })
}

describe('the launch probe and the app database', () => {
  it('leaves no database behind when there is none, so the app builds the schema', async () => {
    const name = `ftw-cold-${Math.random().toString(36).slice(2)}`

    expect(await bootProbe(name)).toEqual([])

    const app = await appOpen(name)
    expect(app.upgraded, 'the app must get its upgrade callback').toBe(true)
    expect(app.stores).toEqual(['sites', 'snapshot'])
  })

  it('reads the existing database on a warm launch without disturbing it', async () => {
    const name = `ftw-warm-${Math.random().toString(36).slice(2)}`

    await appOpen(name)
    // Second launch: the probe now finds a real database and must see the
    // stores rather than an empty list.
    expect(await bootProbe(name)).toEqual(['sites', 'snapshot'])

    const again = await appOpen(name)
    expect(again.upgraded, 'no second upgrade on a database that exists').toBe(false)
    expect(again.stores).toEqual(['sites', 'snapshot'])
  })
})
