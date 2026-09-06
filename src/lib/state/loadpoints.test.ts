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
import {
  OP_LOADPOINT_HOLD,
  OP_LOADPOINT_BOOST,
  OP_LOADPOINT_SOC_SET,
  OP_LOADPOINT_SURPLUS_ONLY_SET,
} from '$lib/protocol/messages'

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
    // The sim charger estimates the car's level the way the box does for a
    // charger without a car API: a fraction on the wire, inferred.
    expect(lp.socPct).toBe(42)
    expect(lp.socSource).toBe('inferred')
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

  /** A store that has read the charger once, with the clock in the evening. */
  async function loadedStore(): Promise<{ site: SiteStore; store: LoadpointsStore }> {
    const site = await streamingSite(new SimBox({ now: () => Date.now() }))
    const store = new LoadpointsStore(site)
    const first = store.load()
    await vi.advanceTimersByTimeAsync(500)
    await first
    return { site, store }
  }

  /** Run one command and let the reread it triggers land. */
  async function settled(run: Promise<void>): Promise<void> {
    await vi.advanceTimersByTimeAsync(500)
    await run
    await vi.advanceTimersByTimeAsync(500)
  }

  it('charges now at the chosen current, as the box page would send it', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(CHARGING_EVENING)
    const { site, store } = await loadedStore()

    const sent = vi.spyOn(site, 'command')
    await settled(store.chargeNow(store.points[0]!, 10))

    // 10 A × 3 × 230 V, a hold only Stop or an unplug releases, on three
    // phases: the body the box's own page posts to manual_hold.
    expect(sent).toHaveBeenCalledWith(OP_LOADPOINT_HOLD, {
      id: 'carport',
      power_w: 6900,
      hold_s: 0,
      phase_mode: '3p',
    })
    expect(store.command).toEqual({ kind: 'applied', of: 'hold', did: 'hold' })

    // The reread says the same: a hold at that setpoint, and the car drawing it.
    const lp = store.points[0]!
    expect(lp.manualActive).toBe(true)
    expect(lp.manualChargeW).toBe(6900)
    expect(lp.powerW).toBe(6900)
  })

  it('boosts from the house battery with a reserve and a bound, then stops it', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(CHARGING_EVENING)
    const { site, store } = await loadedStore()

    const sent = vi.spyOn(site, 'command')
    await settled(store.boost(store.points[0]!, 30, 3600))

    expect(sent).toHaveBeenCalledWith(OP_LOADPOINT_BOOST, {
      id: 'carport',
      min_battery_soc_pct: 30,
      duration_s: 3600,
    })
    expect(store.command).toEqual({ kind: 'applied', of: 'boost', did: 'boost' })

    let lp = store.points[0]!
    expect(lp.boostActive).toBe(true)
    expect(lp.boostReservePct).toBe(30)
    expect(lp.boostExpiresAtMs).toBeGreaterThan(Date.now())
    expect(lp.boostExpiresAtMs).toBeLessThanOrEqual(Date.now() + 3600_000)
    expect(lp.boostStopReason).toBeNull()

    await settled(store.stopBoost(lp))
    expect(sent).toHaveBeenCalledWith(OP_LOADPOINT_BOOST, { id: 'carport', cancel: true })
    expect(store.command).toEqual({ kind: 'applied', of: 'boost', did: 'unboost' })

    lp = store.points[0]!
    expect(lp.boostActive).toBe(false)
    expect(lp.boostStopReason).toBe('cancelled')
  })

  it('reports a hold ending a boost, and the box refusing a boost under a hold', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(CHARGING_EVENING)
    const { store } = await loadedStore()

    await settled(store.boost(store.points[0]!, 30, 3600))
    expect(store.points[0]!.boostActive).toBe(true)

    // A hold takes priority: the box withdraws the boost and keeps the why.
    await settled(store.chargeNow(store.points[0]!, 16))
    let lp = store.points[0]!
    expect(lp.manualActive).toBe(true)
    expect(lp.boostActive).toBe(false)
    expect(lp.boostStopReason).toBe('operator_hold')

    // And a boost asked for under that hold is refused, in a sentence about
    // the boost rather than about the charger being out of reach.
    await settled(store.boost(lp, 30, 3600))
    expect(store.command.kind).toBe('failed')
    expect(store.command.kind === 'failed' && store.command.help).toMatch(/won't boost/)
    lp = store.points[0]!
    expect(lp.boostActive).toBe(false)
    expect(lp.manualActive).toBe(true)
  })

  it('carries the sentence for a lease the box would not take', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(CHARGING_EVENING)
    const { store } = await loadedStore()

    // Five hours: over the box's four-hour cap, so the lease is refused.
    await settled(store.boost(store.points[0]!, 30, 5 * 3600))
    expect(store.command.kind).toBe('failed')
    expect(store.command.kind === 'failed' && store.command.help).toMatch(/reserve and time/)
    expect(store.points[0]!.boostActive).toBe(false)
  })

  it("corrects the car's level as a fraction, and reads back what the box holds", async () => {
    vi.useFakeTimers()
    vi.setSystemTime(CHARGING_EVENING)
    const { site, store } = await loadedStore()
    expect(store.points[0]!.socPct).toBe(42)

    const sent = vi.spyOn(site, 'command')
    await settled(store.setSoc(store.points[0]!, 60))

    // Whole percent in, the wire's fraction out: the body the box's own
    // page posts to `soc`.
    expect(sent).toHaveBeenCalledWith(OP_LOADPOINT_SOC_SET, { id: 'carport', soc: 0.6 })
    expect(store.command).toEqual({ kind: 'applied', of: 'soc', did: 'soc' })
    // The reread is the level the box holds, not the slider's echo.
    expect(store.points[0]!.socPct).toBe(60)
  })

  it('resolves a command only once the charger has been reread', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(CHARGING_EVENING)
    const { store } = await loadedStore()

    // The panel holds a slider draft until this resolves and lets the box's
    // value through afterwards, so the order is load-bearing.
    const run = store.setSoc(store.points[0]!, 60)
    await vi.advanceTimersByTimeAsync(500)
    await run
    expect(store.points[0]!.socPct).toBe(60)
  })

  it('says to plug the car in when the box has no car to set a level for', async () => {
    vi.useFakeTimers()
    // Midday: the sim car left with the morning commute.
    vi.setSystemTime(Date.UTC(2026, 6, 15, 12, 0, 0))
    const { store } = await loadedStore()
    expect(store.points[0]!.pluggedIn).toBe(false)

    await settled(store.setSoc(store.points[0]!, 60))
    expect(store.command.kind).toBe('failed')
    expect(store.command.kind === 'failed' && store.command.help).toMatch(/Plug the car in first/)
  })

  it('turns PV only on and off, and the box refuses a boost while it is on', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(CHARGING_EVENING)
    const { site, store } = await loadedStore()
    expect(store.points[0]!.surplusOnly).toBe(false)

    const sent = vi.spyOn(site, 'command')
    await settled(store.setSurplusOnly(store.points[0]!, true))
    expect(sent).toHaveBeenCalledWith(OP_LOADPOINT_SURPLUS_ONLY_SET, {
      id: 'carport',
      surplus_only: true,
    })
    expect(store.command).toEqual({ kind: 'applied', of: 'surplus', did: 'surplus_on' })
    expect(store.points[0]!.surplusOnly).toBe(true)

    await settled(store.boost(store.points[0]!, 30, 3600))
    expect(store.command.kind).toBe('failed')
    expect(store.command.kind === 'failed' && store.command.help).toMatch(/won't boost/)

    await settled(store.setSurplusOnly(store.points[0]!, false))
    expect(sent).toHaveBeenCalledWith(OP_LOADPOINT_SURPLUS_ONLY_SET, {
      id: 'carport',
      surplus_only: false,
    })
    expect(store.command).toEqual({ kind: 'applied', of: 'surplus', did: 'surplus_off' })
    expect(store.points[0]!.surplusOnly).toBe(false)
  })

  it('reports PV only ending a running boost', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(CHARGING_EVENING)
    const { store } = await loadedStore()

    await settled(store.boost(store.points[0]!, 30, 3600))
    expect(store.points[0]!.boostActive).toBe(true)

    await settled(store.setSurplusOnly(store.points[0]!, true))
    const lp = store.points[0]!
    expect(lp.boostActive).toBe(false)
    expect(lp.boostStopReason).toBe('surplus_only')
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
