/* The cursor, as the range moves under it.
 *
 * The cursor is an index into the current frame. The same index against
 * another range's frame names another moment — against a longer step it can
 * even name a time in the future, and the readout dates a sample nobody is
 * pointing at.
 */

import { describe, it, expect } from 'vitest'
import { HistoryStore } from './history.svelte'
import { SiteStore } from './site.svelte'

describe('the cursor across a range change', () => {
  it('does not survive into a frame where its index means a different time', () => {
    const store = new HistoryStore(new SiteStore('test'))
    store.cursor = 200

    store.select('30d')

    expect(store.cursor, 'an index into the old frame was kept against the new one').toBeNull()
  })

  it('stays put when the range does not actually change', () => {
    const store = new HistoryStore(new SiteStore('test'))
    store.cursor = 12

    store.select('24h')

    expect(store.cursor).toBe(12)
  })
})
