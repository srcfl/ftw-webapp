import { afterEach, describe, expect, it, vi } from 'vitest'
import { SnapshotWriter } from './snapshot'
import type { StoredSnapshot } from './db'

function snapshot(savedAtMs: number): StoredSnapshot {
  return {
    siteId: 'site',
    savedAtMs,
    uptimeMs: savedAtMs,
    fields: {},
    sources: {},
    dispatchBlockedBy: [],
    dict: {},
    controlRev: 0,
  }
}

describe('snapshot writer work', () => {
  afterEach(() => vi.useRealTimers())

  it('materialises only the newest offered session when a write is due', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(100_000)
    const saved: StoredSnapshot[] = []
    const save = vi.fn(async (row: StoredSnapshot) => {
      saved.push(row)
    })
    const writer = new SnapshotWriter(save)
    const first = vi.fn(() => snapshot(1))
    const skipped = vi.fn(() => snapshot(2))
    const newest = vi.fn(() => snapshot(3))

    writer.offer(first)
    await vi.advanceTimersByTimeAsync(0)
    expect(first).toHaveBeenCalledTimes(1)

    writer.offer(skipped)
    writer.offer(newest)
    expect(skipped).not.toHaveBeenCalled()
    expect(newest).not.toHaveBeenCalled()

    await writer.flushNow()
    expect(skipped, 'an overwritten 1 Hz frame was copied for nothing').not.toHaveBeenCalled()
    expect(newest).toHaveBeenCalledTimes(1)
    expect(saved.map((row) => row.savedAtMs)).toEqual([1, 3])
    writer.stop()
  })
})
