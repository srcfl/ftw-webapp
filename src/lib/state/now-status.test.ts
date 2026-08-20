import { describe, it, expect, vi, afterEach } from 'vitest'
import { watchStatus } from './now-status'
import { SiteStore } from './site.svelte'
import { LoopbackCarrier } from '$lib/carrier/loopback'
import { SimBox } from '$lib/sim/box'

const NOON = new Date(2026, 6, 15, 12, 0, 0).getTime()

describe('watchStatus', () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  it('reports the dashboard snapshot and can be stopped', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(NOON)

    const box = new SimBox({ now: () => Date.now() })
    const site = new SiteStore('test')
    site.connect(new LoopbackCarrier(box, { latencyMs: 5 }))
    for (let i = 0; i < 100 && site.session.phase !== 'streaming'; i++) {
      await vi.advanceTimersByTimeAsync(10)
    }
    expect(site.session.phase).toBe('streaming')
    box.tick(1_000)

    const seen: unknown[] = []
    const stop = watchStatus(site, (status) => seen.push(status))
    await vi.advanceTimersByTimeAsync(200)

    expect(seen.length, 'no status arrived').toBeGreaterThan(0)
    const first = seen[0] as { drivers?: Record<string, { pv_w?: number }> }
    expect(first.drivers?.['sungrow']?.pv_w, 'solar missing from the snapshot').toBeDefined()
    const n = seen.length
    stop()
    await vi.advanceTimersByTimeAsync(4_000)
    expect(seen.length, 'a stopped watch kept asking').toBe(n)
  })
})
