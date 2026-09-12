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

  it('names the first primary mode as the plan to return to', async () => {
    const { store } = await connected()
    expect(store.planHome?.key).toBe('planner_passive_arbitrage')
    expect(store.inManual).toBe(false)
    store.destroy()
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
