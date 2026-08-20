/* The first screen, on the two honesty switches it owns.
 *
 * The house diagram claims two things a glance cannot check: that moving
 * particles mean power is flowing at this very moment, and that the sentence
 * on the boot screen is a sentence. Both fail silently — a quiet inverter
 * keeps the particles moving over readings a minute old, and a wire enum
 * reads as a fault code on the one screen that promises nothing is wrong.
 *
 * Everything is real: a Session, a SimBox, the loopback carrier, the box's
 * own <ftw-energy-flow>. Only the feed call is a spy.
 */

import { describe, it, expect, vi, afterEach } from 'vitest'
import { render } from '@testing-library/svelte'
import Now from './Now.svelte'
import { SiteStore } from '$lib/state/site.svelte'
import { LoopbackCarrier } from '$lib/carrier/loopback'
import { SimBox } from '$lib/sim/box'
import type { FtwEnergyFlowElement } from '$vendor/ftw/ftw-energy-flow.js'
import { decodeFrame } from '$lib/protocol/frame'

/** Fixed so the simulated house is the same every run. */
const NOON = new Date(2026, 6, 15, 12, 0, 0).getTime()

function flowEl(): FtwEnergyFlowElement | null {
  return document.querySelector('ftw-energy-flow')
}

describe('the Now screen', () => {
  afterEach(() => {
    document.body.replaceChildren()
    vi.useRealTimers()
    vi.restoreAllMocks()
  })

  it('speaks about a starting box in words, never the wire token', async () => {
    // The box sends codes; this app owns all prose. boot.phase is a name
    // shared with the box — 'vacuum' is a database being compacted, and on
    // the screen that says nothing is wrong it reads as a fault.
    vi.useFakeTimers()
    vi.setSystemTime(NOON)

    const box = new SimBox({ now: () => Date.now(), faults: { booting: true } })
    const site = new SiteStore('test')
    site.connect(new LoopbackCarrier(box, { latencyMs: 0 }))

    render(Now, { props: { site, active: true } })
    const text = () => document.body.textContent ?? ''
    for (let i = 0; i < 100 && !/starting/i.test(text()); i++) {
      await vi.advanceTimersByTimeAsync(20)
    }

    expect(text()).toMatch(/Your box is starting/i)
    expect(text(), 'a wire token reached the screen').not.toMatch(/\bvacuum\b|\bmigrate\b|\bdrivers\b/i)
    // The progress itself is kept — it is the one number worth showing.
    expect(text()).toMatch(/40\s?%/)
  })

  it('holds the house still when a source goes quiet on a healthy socket', async () => {
    // The case the static switch exists for and phase alone cannot see:
    // connected, streaming, and the inverter went quiet a while ago. Moving
    // particles over those readings claim power is flowing right now.
    vi.useFakeTimers()
    vi.setSystemTime(NOON)

    const box = new SimBox({ now: () => Date.now() })
    const site = new SiteStore('test')
    site.connect(new LoopbackCarrier(box, { latencyMs: 0 }))

    render(Now, { props: { site, active: true } })
    for (let i = 0; i < 100 && !flowEl(); i++) await vi.advanceTimersByTimeAsync(20)

    expect(flowEl(), 'the house never drew at all').not.toBeNull()
    expect(flowEl()!.hasAttribute('static'), 'a live stream was drawn still').toBe(false)

    box.faults = { ...box.faults, sourceStates: { 'inverter.sungrow': 'stale' } }
    box.tick(1_000)
    await vi.advanceTimersByTimeAsync(100)

    expect(site.session.phase, 'the session moved, so this is not the case under test').toBe(
      'streaming'
    )
    expect(site.srcState).not.toBe('live')
    expect(
      flowEl()!.hasAttribute('static'),
      'particles kept flowing over readings that are not current'
    ).toBe(true)
  })

  it('does not feed the diagram while hidden, and catches up on return', async () => {
    // Now stays mounted behind the other tabs, hidden by the shell. The
    // stream keeps arriving either way; pushing it into a display:none SVG
    // at 1 Hz is work nobody can see. Coming back must start from the
    // present, not replay what was skipped.
    vi.useFakeTimers()
    vi.setSystemTime(NOON)

    const box = new SimBox({ now: () => Date.now() })
    const site = new SiteStore('test')
    site.connect(new LoopbackCarrier(box, { latencyMs: 0 }))

    const { rerender } = render(Now, { props: { site, active: false } })
    for (let i = 0; i < 100 && !flowEl(); i++) await vi.advanceTimersByTimeAsync(20)
    expect(flowEl()).not.toBeNull()
    expect(flowEl()!.hasAttribute('static'), 'the hidden particle loop was still running').toBe(
      true
    )

    const fed = vi.spyOn(flowEl()!, 'setReadings')

    // Ten seconds of live power into a view another tab is covering.
    for (let i = 0; i < 10; i++) {
      box.tick()
      await vi.advanceTimersByTimeAsync(1_000)
    }
    expect(fed, 'a hidden SVG was fed at 1 Hz').not.toHaveBeenCalled()

    await rerender({ active: true })
    await vi.advanceTimersByTimeAsync(20)
    expect(fed, 'coming back never caught the view up').toHaveBeenCalled()
    expect(flowEl()!.hasAttribute('static'), 'the live view stayed frozen on return').toBe(false)
  })

  it('does not rebuild the diagram for an unchanged cadence tick', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(NOON)

    const box = new SimBox({ now: () => Date.now() })
    const types: string[] = []
    box.onFrame((frame) => types.push(decodeFrame(frame).envelope.t))
    const site = new SiteStore('test')
    site.connect(new LoopbackCarrier(box, { latencyMs: 0 }))
    render(Now, { props: { site, active: true } })
    for (let i = 0; i < 100 && (!flowEl() || site.session.phase !== 'streaming'); i++) {
      await vi.advanceTimersByTimeAsync(20)
    }
    await vi.advanceTimersByTimeAsync(20)

    const fed = vi.spyOn(flowEl()!, 'setReadings')
    vi.setSystemTime(NOON)
    box.tick(0)
    await vi.advanceTimersByTimeAsync(100)
    fed.mockClear()
    types.length = 0

    vi.setSystemTime(NOON)
    box.tick(0)
    await vi.advanceTimersByTimeAsync(100)

    expect(types, 'the simulator sent changed readings, so this is not a tick').toEqual(['tick'])
    expect(fed, 'an unchanged 1 Hz tick rebuilt the full shadow DOM').not.toHaveBeenCalled()

    vi.setSystemTime(NOON + 3_600_000)
    box.tick()
    await vi.advanceTimersByTimeAsync(100)
    expect(fed, 'a changed reading did not reach the diagram').toHaveBeenCalledTimes(1)
  })

  it('draws kWh today on the hero once the dashboard snapshot arrives', async () => {
    // Frozen fields are five aggregates. The box page is per-driver planets
    // plus today's totals, from GET /api/status. This is the feed that makes
    // those two screens the same diagram.
    vi.useFakeTimers()
    vi.setSystemTime(NOON)

    const box = new SimBox({ now: () => Date.now() })
    const site = new SiteStore('test')
    site.connect(new LoopbackCarrier(box, { latencyMs: 0 }))
    render(Now, { props: { site, active: true } })
    for (let i = 0; i < 100 && !flowEl(); i++) await vi.advanceTimersByTimeAsync(20)
    expect(flowEl()).not.toBeNull()
    box.tick(1_000)

    const fed = vi.spyOn(flowEl()!, 'setReadings')
    await vi.advanceTimersByTimeAsync(2_200)

    const rich = fed.mock.calls
      .map((c) => c[0] as { selfPoweredPctToday?: number | null; planets?: { id: string }[] })
      .find((r) => r.selfPoweredPctToday != null)
    expect(rich, 'the dashboard snapshot never reached the hero').toBeTruthy()
    expect(rich!.planets?.some((p) => p.id === 'pv-sungrow')).toBe(true)
  })

  it('draws price, the next plan step, today and the fuse under the house', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(NOON)
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('no origin'))

    const box = new SimBox({ now: () => Date.now() })
    const site = new SiteStore('test')
    site.connect(new LoopbackCarrier(box, { latencyMs: 0 }))
    render(Now, { props: { site, active: true } })
    box.tick(1_000)

    const text = () => document.body.textContent ?? ''
    for (let i = 0; i < 300 && !/\bFuse\b/.test(text()); i++) {
      await vi.advanceTimersByTimeAsync(20)
    }

    expect(text()).toMatch(/What FTW does next/)
    expect(text()).toMatch(/\bToday\b/)
    expect(text()).toMatch(/\bFuse\b/)
    const chart = document.querySelector('ftw-price-chart')
    expect(chart, 'the compact price chart never mounted').not.toBeNull()
    expect(chart!.hasAttribute('fed'), 'the chart fetched /api/prices on this origin').toBe(true)
    expect(chart!.hasAttribute('compact')).toBe(true)
  })
})
