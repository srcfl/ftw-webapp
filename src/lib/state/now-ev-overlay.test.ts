import { describe, it, expect, vi, afterEach } from 'vitest'
import { watchLoadpointCharge } from './now-ev-overlay'
import { SiteStore } from './site.svelte'
import { LoopbackCarrier } from '$lib/carrier/loopback'
import { SimBox } from '$lib/sim/box'

const EVENING = Date.UTC(2026, 6, 15, 18, 30, 0)

describe('watchLoadpointCharge', () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  it('reports charger watts from the box and can be stopped', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(EVENING)

    const site = new SiteStore('test')
    site.connect(new LoopbackCarrier(new SimBox({ now: () => Date.now() }), { latencyMs: 5 }))
    for (let i = 0; i < 100 && site.session.phase !== 'streaming'; i++) {
      await vi.advanceTimersByTimeAsync(10)
    }
    expect(site.session.phase).toBe('streaming')

    const seen: number[] = []
    const stop = watchLoadpointCharge(site, (w) => seen.push(w))
    await vi.advanceTimersByTimeAsync(200)

    expect(seen.some((w) => w > 7000), 'evening charge never arrived').toBe(true)
    const n = seen.length
    stop()
    await vi.advanceTimersByTimeAsync(6_000)
    expect(seen.length, 'a stopped watch kept asking').toBe(n)
  })
})
