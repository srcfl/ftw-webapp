/* The store and the home it points at.
 *
 * Two ways the pointer and the stream disagree, and both end with this phone
 * doing something for a home it should not:
 *
 *   - start() repoints the store while the old home is still streaming. The
 *     subscriber tags every streaming frame with the current site id, so one
 *     frame in the gap seals house A's readings to disk under house B's id —
 *     and B's next cold start paints A's kitchen.
 *   - a carrier finishes connecting after the store was destroyed. Handed to
 *     the session, it starts a live, self-reconnecting stream to the home
 *     this phone just signed out of, unreferenced and unclosable.
 *
 * Everything here is real: a Session, a SimBox, the loopback carrier.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'
import 'fake-indexeddb/auto'
import { SiteStore } from './site.svelte'
import { LoopbackCarrier } from '$lib/carrier/loopback'
import { SimBox } from '$lib/sim/box'
import { db } from '$lib/store/db'
import { loadSnapshot } from '$lib/store/snapshot'

beforeEach(async () => {
  const database = await db()
  for (const store of ['sites', 'snapshot', 'tiles', 'meta', 'keys'] as const) {
    await database.clear(store)
  }
})

describe('a store repointed at another home mid-stream', () => {
  it('never seals the old house under the new id', async () => {
    const box = new SimBox({})
    const site = new SiteStore('test')
    await site.start('home-a')
    site.connect(new LoopbackCarrier(box, { latencyMs: 0 }))
    await vi.waitFor(() => expect(site.session.phase).toBe('streaming'), { timeout: 2_000 })

    // Repointed without a disconnect: signing out of A and into B while A's
    // frames are still in the air.
    await site.start('home-b')

    // One more frame from A's box, and the flush the shell makes on every
    // visibilitychange.
    box.tick()
    await new Promise((r) => setTimeout(r, 20))
    await site.persistNow()

    expect(
      await loadSnapshot('home-b'),
      "house A's readings were sealed under house B's id"
    ).toBeNull()

    site.destroy()
  })
})

describe('a carrier that finishes connecting after sign-out', () => {
  it('is closed, not adopted', async () => {
    const box = new SimBox({})
    const spoken = vi.spyOn(box, 'receive')

    const site = new SiteStore('test')
    site.destroy()

    // The connect that was in flight when the user signed out.
    const carrier = new LoopbackCarrier(box, { latencyMs: 0 })
    site.connect(carrier)
    await new Promise((r) => setTimeout(r, 50))

    expect(carrier.status.phase, 'a store nothing owns kept a live carrier').toBe('closed')
    expect(spoken, 'the dead store still spoke to the box').not.toHaveBeenCalled()
  })
})
