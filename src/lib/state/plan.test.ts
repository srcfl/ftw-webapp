/* The plan the box pushes unasked.
 *
 * A plan does not only arrive as an answer. The box replans after a mode
 * change made from any phone and pushes the result with no request id,
 * because nobody on this connection asked. The session keeps that copy; a
 * store holding its own caught only the answers, so a long-lived connection
 * drained to "no plan for right now" while the box's intent moved on.
 */

import { describe, it, expect, vi } from 'vitest'
import 'fake-indexeddb/auto'
import { SiteStore } from './site.svelte'
import { PlanStore } from './plan.svelte'
import { LoopbackCarrier } from '$lib/carrier/loopback'
import { SimBox } from '$lib/sim/box'
import { OP_SET_MODE } from '$lib/protocol/messages'

describe('a replan this phone never asked for', () => {
  it('reaches the plan on screen', async () => {
    const box = new SimBox({})
    const site = new SiteStore('test')
    const store = new PlanStore(site)
    site.connect(new LoopbackCarrier(box, { latencyMs: 0 }))
    await vi.waitFor(() => expect(site.session.phase).toBe('streaming'), { timeout: 2_000 })

    // Nothing has been asked for, and nothing has been pushed.
    expect(store.plan).toBeNull()

    // A mode change straight over the wire — as another phone's would land —
    // never touching this store's load(). The box replans and pushes the
    // result with no pending id to claim it.
    const result = await site.command(OP_SET_MODE, { mode: 'planner_self' })
    expect(result.state, 'the mode change failed, so no replan is coming').toBe('applied')

    await vi.waitFor(() => expect(store.plan).not.toBeNull(), { timeout: 2_000 })
    expect(store.plan!.rev).toBeGreaterThan(1)

    site.destroy()
  })
})

describe('the mode the Plan store offers a way back from', () => {
  async function connected(mode?: string) {
    const box = new SimBox(mode ? { mode } : {})
    const site = new SiteStore('test')
    const store = new PlanStore(site)
    site.connect(new LoopbackCarrier(box, { latencyMs: 0 }))
    await vi.waitFor(() => expect(site.session.phase).toBe('streaming'), { timeout: 2_000 })
    return { box, site, store }
  }

  it('treats a planner mode as the plan, and hides planner keys from the manual list', async () => {
    const { store } = await connected()
    expect(store.inManual).toBe(false)
    expect(store.manualModes.every((m) => !m.key.startsWith('planner_'))).toBe(true)
    expect(store.manualModes.some((m) => m.key === 'self_consumption')).toBe(true)
    expect(store.manualModes.some((m) => m.key === 'planner_self')).toBe(false)
    store.destroy()
  })

  it('follows mapped_mode when handing the house back to the plan', async () => {
    const { store, box, site } = await connected('self_consumption')
    await store.load()
    await store.setPrefs({ battery_export: 'allowed' })
    expect(box.mode, 'a prefs write must not leave a manual mode on its own').toBe('self_consumption')
    expect(box.batteryExport).toBe('allowed')
    const sent = vi.spyOn(site, 'command')
    await store.usePlan()
    expect(box.mode).toBe('planner_arbitrage')
    expect(sent.mock.calls.some((c) => c[0] === 'site.mode.set' && c[1]?.mode === 'planner_arbitrage')).toBe(
      true
    )
    expect(sent.mock.calls.some((c) => c[1]?.mode === 'planner_passive_arbitrage')).toBe(false)
    store.destroy()
    site.destroy()
  })

  it('uses the passive mode when the prefs read fails', async () => {
    const { store, box, site } = await connected('self_consumption')
    await store.load()
    await store.setPrefs({ battery_export: 'allowed' })
    const api = site.api.bind(site)
    vi.spyOn(site, 'api').mockImplementation(async (req) => {
      if (req.path === '/api/planner/prefs') throw new Error('down')
      return api(req)
    })
    await store.usePlan()
    expect(box.mode).toBe('planner_passive_arbitrage')
    store.destroy()
    site.destroy()
  })

  it('treats Self (manual) as a manual fallback, not a plan', async () => {
    const { store, site } = await connected()
    await store.setMode('self_consumption')
    expect(store.inManual).toBe(true)
    expect(store.shownMode).toBe('self_consumption')
    expect(site.session.modes.find((m) => m.key === store.shownMode)?.tier).toBe('advanced')
    store.destroy()
  })

  it('waits for the in-flight request before accepting another mode', async () => {
    const box = new SimBox({})
    const site = new SiteStore('test')
    const store = new PlanStore(site)
    site.connect(new LoopbackCarrier(box, { latencyMs: 60 }))
    await vi.waitFor(() => expect(site.session.phase).toBe('streaming'), { timeout: 2_000 })
    const sent = vi.spyOn(site, 'command')

    const first = store.setMode('self_consumption')
    expect(store.command.kind).toBe('sending')
    await store.setMode('idle')
    expect(sent).toHaveBeenCalledTimes(1)
    expect(store.shownMode).toBe('self_consumption')

    await first
    expect(box.mode).toBe('self_consumption')
    await store.setMode('idle')
    expect(sent).toHaveBeenCalledTimes(2)
    expect(store.command.kind).toBe('applied')
    expect(box.mode).toBe('idle')
    expect(store.shownMode).toBe('idle')
    store.destroy()
    site.destroy()
  })
})


describe('planner preference changes from another client', () => {
  it('ignores a preference read sent before this phone changed the margin', async () => {
    const box = new SimBox({})
    const site = new SiteStore('test')
    const store = new PlanStore(site)
    site.connect(new LoopbackCarrier(box, { latencyMs: 0 }))
    await vi.waitFor(() => expect(site.session.phase).toBe('streaming'), { timeout: 2_000 })
    await store.load()
    const old = box.plannerPrefsBody()
    let finish!: (value: Awaited<ReturnType<SiteStore['api']>>) => void
    const pending = new Promise<Awaited<ReturnType<SiteStore['api']>>>((resolve) => { finish = resolve })
    const api = site.api.bind(site)
    let reading = false
    vi.spyOn(site, 'api').mockImplementationOnce(async (request) => {
      expect(request.path).toBe('/api/planner/prefs')
      reading = true
      return pending
    }).mockImplementation(api)
    const load = store.load()
    await vi.waitFor(() => expect(reading).toBe(true))
    await store.setPrefs({ safety_k: 0.15 })
    finish({ status: 200, headers: { 'content-type': 'application/json' }, body: new TextEncoder().encode(JSON.stringify(old)) })
    await load
    expect(store.prefs!.safetyK).toBe(0.15)
    store.destroy()
    site.destroy()
  })

  it('keeps the box export permission when this phone changes style from an old read', async () => {
    const box = new SimBox({})
    const site = new SiteStore('test')
    const store = new PlanStore(site)
    site.connect(new LoopbackCarrier(box, { latencyMs: 0 }))
    await vi.waitFor(() => expect(site.session.phase).toBe('streaming'), { timeout: 2_000 })
    await store.load()
    expect(store.prefs!.batteryExport).toBe('unknown')
    await site.command('planner.prefs.set', { battery_export: 'allowed' })
    const sent = vi.spyOn(site, 'command')
    await store.setPrefs({ safety_k: 0.15 })
    expect(sent.mock.calls[0]).toEqual(['planner.prefs.set', { safety_k: 0.15 }])
    expect(box.batteryExport).toBe('allowed')
    expect(box.safetyK).toBe(0.15)
    store.destroy()
    site.destroy()
  })
})
