/* The charger's store, against the simulator playing the box.
 *
 * Everything real: a Session over a LoopbackCarrier, the sim's own route
 * table with its tiers, and the clock held inside the evening charging
 * window so the simulated house has a car on the cable.
 */

import { describe, it, expect, vi, afterEach } from 'vitest'
import { LoadpointsStore, chargeWindows } from './loadpoints.svelte'
import { SiteStore } from './site.svelte'
import { LoopbackCarrier } from '$lib/carrier/loopback'
import { SimBox } from '$lib/sim/box'

/** Half past six in the evening UTC: the sim car is plugged in and drawing. */
const CHARGING_EVENING = Date.UTC(2026, 6, 15, 18, 30, 0)

async function streamingSite(box: SimBox): Promise<SiteStore> {
  const site = new SiteStore('test')
  site.connect(new LoopbackCarrier(box, { latencyMs: 5 }))
  for (let i = 0; i < 100 && site.session.phase !== 'streaming'; i++) {
    await vi.advanceTimersByTimeAsync(10)
  }
  expect(site.session.phase).toBe('streaming')
  return site
}

describe('the charger over the wire', () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  it('reads the charger and its windows from the box', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(CHARGING_EVENING)

    const site = await streamingSite(new SimBox({ now: () => Date.now() }))
    const store = new LoadpointsStore(site)

    const done = store.load()
    await vi.advanceTimersByTimeAsync(500)
    await done

    expect(store.loaded).toBe(true)
    expect(store.points).toHaveLength(1)

    const lp = store.points[0]!
    expect(lp.id).toBe('carport')
    expect(lp.pluggedIn).toBe(true)
    expect(lp.powerW).toBeGreaterThan(7000)
    // The sim charger honestly does not know the car's charge.
    expect(lp.socPct).toBeNull()
    expect(lp.schedule).not.toBeNull()

    // The plan's charging window covers this very evening.
    const windows = store.windows['carport']!
    expect(windows.length).toBeGreaterThan(0)
    expect(windows[0]!.fromMs).toBeLessThanOrEqual(Date.now())
    expect(windows[0]!.peakW).toBeGreaterThan(0)
    expect(store.planMissing).toBe(false)
  })

  it('keeps the charger when only the plan read fails', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(CHARGING_EVENING)

    const box = new SimBox({ now: () => Date.now() })
    const site = await streamingSite(box)

    // An older box: the charger route answers, the plan route does not
    // exist. The sim's own refusal for an unpriced path plays that part.
    const serve = box.api.serve.bind(box.api)
    vi.spyOn(box.api, 'serve').mockImplementation((req) =>
      req.path === '/api/mpc/plan'
        ? { code: 'E_UNKNOWN_OP', args: { t: 'api.req', field: 'path' } }
        : serve(req)
    )

    const store = new LoadpointsStore(site)
    const done = store.load()
    await vi.advanceTimersByTimeAsync(500)
    await done

    expect(store.points).toHaveLength(1)
    expect(store.loaded).toBe(true)
    expect(store.error).toBeNull()
    expect(store.planMissing, 'a missing plan was passed off as an idle week').toBe(true)
  })

  it('rejects and says so when the box is out of reach, keeping what was drawn', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(CHARGING_EVENING)

    const box = new SimBox({ now: () => Date.now() })
    const carrier = new LoopbackCarrier(box, { latencyMs: 5 })
    const site = new SiteStore('test')
    site.connect(carrier)
    for (let i = 0; i < 100 && site.session.phase !== 'streaming'; i++) {
      await vi.advanceTimersByTimeAsync(10)
    }

    const store = new LoadpointsStore(site)
    const first = store.load()
    await vi.advanceTimersByTimeAsync(500)
    await first
    expect(store.points).toHaveLength(1)

    carrier.drop('wire died')
    // The handler goes on before the clock moves, or the rejection lands
    // unowned in the window between them.
    const second = expect(store.load()).rejects.toThrow()
    await vi.advanceTimersByTimeAsync(30_000)
    await second

    // The panel keeps the charger it drew, under a sentence about the wire.
    expect(store.points).toHaveLength(1)
    expect(store.error).toMatch(/out of reach/i)
  })
})

describe('charge windows folded from plan slots', () => {
  const slot = (h: number, m: number, w: number, reason = 'charge from cheap grid') => ({
    slot_start_ms: Date.UTC(2026, 6, 15, h, m),
    slot_len_min: 15,
    reason,
    loadpoint_power_w: { carport: w },
  })

  it('merges adjacent charging slots into one window', () => {
    const windows = chargeWindows(
      [slot(1, 0, 7200), slot(1, 15, 11000), slot(1, 30, 7200), slot(5, 0, 7200)],
      'carport'
    )
    expect(windows).toHaveLength(2)
    expect(windows[0]!.toMs - windows[0]!.fromMs).toBe(45 * 60_000)
    expect(windows[0]!.peakW).toBe(11000)
    expect(windows[1]!.fromMs).toBe(Date.UTC(2026, 6, 15, 5, 0))
  })

  it('carries a plan that is missing fields mid-replan', () => {
    expect(
      chargeWindows(
        [{ reason: 'hold' }, { slot_start_ms: 1, slot_len_min: 15 }, slot(1, 0, 0)],
        'carport'
      )
    ).toHaveLength(0)
  })

  it('reads only the asked charger from a shared plan', () => {
    const both = [
      { ...slot(1, 0, 7200), loadpoint_power_w: { carport: 0, garage: 9000 } },
    ]
    expect(chargeWindows(both, 'carport')).toHaveLength(0)
    expect(chargeWindows(both, 'garage')).toHaveLength(1)
  })
})
