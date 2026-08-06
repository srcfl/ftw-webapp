/* A home that is cleared while it is still streaming has to stay cleared.
 *
 * Two ways it does not, and both end the same way: a sealed snapshot of the
 * household this phone just left, sitting on the disk under a cache key
 * generated on demand to replace the one the sign-out cleared a moment before.
 *
 *   - The disk is cleared while the session is still receiving. Clearing is
 *     several awaits long, and a frame landing in any of those gaps writes the
 *     home back.
 *   - The app is backgrounded on the way out. 'visibilitychange' flushes the
 *     writer by hand, and a writer that was stopped but still holding a frame
 *     obliges.
 *
 * This mounts nothing, but it needs a live session, so it runs in the project
 * where the carrier and the simulator resolve the way the app does.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import 'fake-indexeddb/auto'
import { SiteStore } from './site.svelte'
import { leaveHome } from './leave'
import { LoopbackCarrier } from '$lib/carrier/loopback'
import { SimBox } from '$lib/sim/box'
import { db } from '$lib/store/db'
import { memoryVaultStore } from '$lib/identity/vault'

const SITE_ID = 'sim-0001'

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

/**
 * A store that is streaming and is holding a frame it has not written yet.
 *
 * The first frame is written the moment it lands; every one after that waits
 * out the throttle. So the state worth testing — a writer with something
 * pending — needs a second frame, which is what the tick is for.
 */
async function streaming(): Promise<SiteStore> {
  const box = new SimBox({})
  const site = new SiteStore('test')
  await site.start(SITE_ID)
  site.connect(new LoopbackCarrier(box, { latencyMs: 0 }))
  await vi.waitFor(() => expect(site.session.phase).toBe('streaming'), { timeout: 2_000 })

  const database = await db()
  await vi.waitFor(async () => expect(await database.get('snapshot', SITE_ID)).toBeTruthy(), {
    timeout: 2_000,
  })

  const written = await database.get('snapshot', SITE_ID)
  const before = site.session.uptimeMs
  box.tick()
  await vi.waitFor(() => expect(site.session.uptimeMs).toBeGreaterThan(before), { timeout: 2_000 })
  // Still the first write: the second frame is pending, not stored.
  expect(await database.get('snapshot', SITE_ID)).toEqual(written)

  return site
}

describe('signing out of a home that is still streaming', () => {
  beforeEach(async () => {
    vi.stubGlobal('localStorage', stubStorage())
    const database = await db()
    for (const store of ['sites', 'snapshot', 'tiles', 'meta', 'keys'] as const) {
      await database.clear(store)
    }
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('stops the stream before it touches the disk, not after', async () => {
    const site = await streaming()

    const order: string[] = []
    const database = await db()
    const clear = database.clear.bind(database)
    vi.spyOn(database, 'clear').mockImplementation(async (store) => {
      order.push('clear')
      return clear(store)
    })

    await leaveHome({
      home: {
        destroy: () => {
          order.push('stop')
          site.destroy()
        },
      },
      vault: memoryVaultStore(),
    })

    // Any frame arriving inside the clear would be written back, and the clear
    // is several awaits long. Stopping afterwards is a race this loses often
    // enough to hand a phone on with the last owner readable on it.
    expect(order[0], 'the disk was cleared while the session was still running').toBe('stop')
    expect(await database.get('snapshot', SITE_ID)).toBeUndefined()
  })

  it('is not undone by the app being backgrounded on the way out', async () => {
    const site = await streaming()

    await leaveHome({ home: site, vault: memoryVaultStore() })

    // What the shell does on every 'visibilitychange' — the last chance to
    // persist, and on the way out of a home the last chance to resurrect it.
    await site.persistNow()

    const database = await db()
    expect(
      await database.get('snapshot', SITE_ID),
      'the home was written back after it was cleared'
    ).toBeUndefined()
  })
})
