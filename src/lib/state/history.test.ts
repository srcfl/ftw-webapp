/* The cursor, as the range moves under it.
 *
 * The cursor is an index into the current frame. The same index against
 * another range's frame names another moment — against a longer step it can
 * even name a time in the future, and the readout dates a sample nobody is
 * pointing at.
 */

import { afterEach, describe, it, expect, vi } from 'vitest'
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

describe('history tile painting', () => {
  afterEach(() => {
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
  })

  it('assembles a burst of chunks once, not once per chunk', async () => {
    const callbacks: FrameRequestCallback[] = []
    const schedule = vi.fn((callback: FrameRequestCallback) => {
      callbacks.push(callback)
      return 7
    })
    const cancel = vi.fn()
    vi.stubGlobal('requestAnimationFrame', schedule)
    vi.stubGlobal('cancelAnimationFrame', cancel)

    const site = new SiteStore('test')
    vi.spyOn(site, 'history').mockImplementation(async (_query, onChunk) => {
      for (let i = 0; i < 8; i++) {
        onChunk({
          tileId: `tile-${i}`,
          etag: `${i}`,
          res: '5m',
          startMs: i * 43_200_000,
          stepMs: 300_000,
          series: ['grid_w', 'pv_w', 'battery_w', 'load_w'],
          data: new Uint8Array(16),
          partial: false,
        })
      }
      return { resActual: '5m', gaps: [] }
    })

    const history = new HistoryStore(site)
    await history.load()

    expect(schedule, 'each chunk scheduled its own full assembly').toHaveBeenCalledTimes(1)
    expect(cancel, 'the final answer did not replace the queued partial paint').toHaveBeenCalledWith(7)
    expect(history.loaded).toBe(true)
    expect(history.frame).not.toBeNull()
    history.destroy()
    site.destroy()
  })
})
