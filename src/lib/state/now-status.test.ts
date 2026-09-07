import { describe, it, expect, vi, afterEach } from 'vitest'
import { watchStatus, STATUS_MAX_AGE_MS, type StatusSnapshot } from './now-status'
import { SiteStore } from './site.svelte'
import { LoopbackCarrier } from '$lib/carrier/loopback'
import { SimBox } from '$lib/sim/box'

const NOON = new Date(2026, 6, 15, 12, 0, 0).getTime()

describe('watchStatus', () => {
  afterEach(() => {
    vi.useRealTimers()
    vi.restoreAllMocks()
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

    const seen: StatusSnapshot[] = []
    const stop = watchStatus(site, (status) => seen.push(status))
    await vi.advanceTimersByTimeAsync(200)

    expect(seen.length, 'no status arrived').toBeGreaterThan(0)
    const first = seen[0]!
    expect(first.status?.drivers?.['sungrow']?.pv_w, 'solar missing from the snapshot').toBeDefined()
    expect(first.fresh).toBe(true)
    expect(first.receivedAt).toBeGreaterThanOrEqual(NOON)
    stop()
    expect(seen.at(-1)?.fresh).toBe(false)
    const n = seen.length
    await vi.advanceTimersByTimeAsync(4_000)
    expect(seen.length, 'a stopped watch kept asking').toBe(n)
    site.destroy()
  })

  it('expires the last reply while a later request is pending and ignores a reply after stop', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(NOON)
    const box = new SimBox({ now: () => Date.now() })
    const site = new SiteStore('test')
    site.connect(new LoopbackCarrier(box, { latencyMs: 0 }))
    await vi.advanceTimersByTimeAsync(100)
    const seen: StatusSnapshot[] = []
    const stop = watchStatus(site, snapshot => seen.push(snapshot))
    await vi.advanceTimersByTimeAsync(100)
    const first = seen.at(-1)!
    expect(first.fresh).toBe(true)

    const api = site.api.bind(site)
    let finish: (() => void) | undefined
    vi.spyOn(site, 'api').mockImplementation(req => req.path === '/api/status'
      ? new Promise(resolve => { finish = () => resolve({ status: 200, headers: {}, body: new TextEncoder().encode('{"grid_w":123}') }) })
      : api(req))
    await vi.advanceTimersByTimeAsync(2_100)
    expect(finish).toBeDefined()
    // A backwards clock change must not extend the life of a reading.
    vi.setSystemTime(NOON - 3_600_000)
    await vi.advanceTimersByTimeAsync(STATUS_MAX_AGE_MS)
    expect(seen.at(-1)).toEqual({ ...first, fresh: false })
    stop()
    const n = seen.length
    finish!()
    await vi.advanceTimersByTimeAsync(100)
    expect(seen).toHaveLength(n)
    site.destroy()
  })
})
