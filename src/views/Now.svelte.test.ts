/* The first screen, on the two honesty switches it owns.
 *
 * The house diagram claims two things a glance cannot check: that moving
 * particles mean power is flowing at this very moment, and that the sentence
 * on the boot screen is a sentence. Both fail silently — a quiet inverter
 * keeps the particles moving over readings a minute old, and a wire enum
 * reads as a fault code on the one screen that promises nothing is wrong.
 *
 * Everything is real: a Session, a SimBox, the loopback carrier and the
 * ring. What the ring is fed is read off the page.
 */

import { describe, it, expect, vi, afterEach } from 'vitest'
import { render } from '@testing-library/svelte'
import Now from './Now.svelte'
import { SiteStore } from '$lib/state/site.svelte'
import { LoopbackCarrier } from '$lib/carrier/loopback'
import { SimBox } from '$lib/sim/box'
import { decodeFrame } from '$lib/protocol/frame'

/** Fixed so the simulated house is the same every run. */
const NOON = new Date(2026, 6, 15, 12, 0, 0).getTime()

function ringEl(): HTMLElement | null {
  return document.querySelector('.ring')
}

/** What the ring says, as a person reads it. */
const ringText = () => ringEl()?.textContent?.replace(/\s+/g, ' ').trim() ?? ''

/** Counts every change to the ring's page, so a feed shows up as work. */
function watchRing(): { count: () => number; stop: () => void } {
  let n = 0
  const seen = new MutationObserver((records) => {
    n += records.length
  })
  seen.observe(ringEl()!, { subtree: true, childList: true, characterData: true, attributes: true })
  return {
    count: () => (n += seen.takeRecords().length),
    stop: () => seen.disconnect(),
  }
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
    for (let i = 0; i < 100 && ringEl()?.dataset.live !== 'true'; i++) await vi.advanceTimersByTimeAsync(20)

    expect(ringEl(), 'the house never drew at all').not.toBeNull()
    expect(ringEl()!.dataset.live, 'a live stream was drawn still').toBe('true')

    box.faults = { ...box.faults, sourceStates: { 'inverter.sungrow': 'stale' } }
    box.tick(1_000)
    await vi.advanceTimersByTimeAsync(100)

    expect(site.session.phase, 'the session moved, so this is not the case under test').toBe(
      'streaming'
    )
    expect(site.srcState).not.toBe('live')
    expect(ringEl()!.dataset.live, 'light kept running over readings that are not current').toBe('false')
  })

  it('does not feed the ring while hidden, and catches up on return', async () => {
    // Now stays mounted behind the other tabs, hidden by the shell. The
    // stream keeps arriving either way; pushing it into a display:none ring
    // at 1 Hz is work nobody can see. Coming back must start from the
    // present, not replay what was skipped.
    vi.useFakeTimers()
    vi.setSystemTime(NOON)

    const box = new SimBox({ now: () => Date.now() })
    const site = new SiteStore('test')
    site.connect(new LoopbackCarrier(box, { latencyMs: 0 }))

    const { rerender } = render(Now, { props: { site, active: true } })
    for (let i = 0; i < 100 && !/Usage/.test(ringText()); i++) await vi.advanceTimersByTimeAsync(20)
    await rerender({ active: false })
    await vi.advanceTimersByTimeAsync(20)
    const before = ringText()
    const work = watchRing()

    // An hour of changed power into a view another tab is covering.
    vi.setSystemTime(NOON + 3_600_000)
    for (let i = 0; i < 10; i++) {
      box.tick()
      await vi.advanceTimersByTimeAsync(1_000)
    }
    expect(work.count(), 'a hidden ring was fed at 1 Hz').toBe(0)
    expect(ringText()).toBe(before)

    await rerender({ active: true })
    await vi.advanceTimersByTimeAsync(20)
    expect(ringText(), 'coming back never caught the view up').not.toBe(before)
    expect(ringEl()!.dataset.live, 'the live view stayed still on return').toBe('true')
    work.stop()
  })

  it('does not touch the ring for an unchanged cadence tick', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(NOON)

    const box = new SimBox({ now: () => Date.now() })
    // Exercise the telemetry path; the richer status has its own cadence.
    const serve = box.api.serve.bind(box.api)
    vi.spyOn(box.api, 'serve').mockImplementation(req => req.path === '/api/status'
      ? { status: 503, contentType: 'application/json', body: new TextEncoder().encode('{}') }
      : serve(req))
    const types: string[] = []
    box.onFrame((frame) => types.push(decodeFrame(frame).envelope.t))
    const site = new SiteStore('test')
    site.connect(new LoopbackCarrier(box, { latencyMs: 0 }))
    render(Now, { props: { site, active: true } })
    for (let i = 0; i < 100 && (!/Usage/.test(ringText()) || site.session.phase !== 'streaming'); i++) {
      await vi.advanceTimersByTimeAsync(20)
    }
    await vi.advanceTimersByTimeAsync(20)

    vi.setSystemTime(NOON)
    box.tick(0)
    await vi.advanceTimersByTimeAsync(100)
    const work = watchRing()
    types.length = 0

    vi.setSystemTime(NOON)
    box.tick(0)
    await vi.advanceTimersByTimeAsync(100)

    // Plan, price and API replies may finish loading in parallel with Now.
    // Only these three message types can replace the telemetry being tested.
    const telemetry = types.filter(t => t === 'snap' || t === 'delta' || t === 'tick')
    expect(telemetry, 'the simulator sent changed readings, so this is not a tick').toEqual(['tick'])
    expect(work.count(), 'an unchanged 1 Hz tick changed the ring').toBe(0)

    vi.setSystemTime(NOON + 3_600_000)
    box.tick()
    await vi.advanceTimersByTimeAsync(100)
    expect(work.count(), 'a changed reading did not reach the ring').toBeGreaterThan(0)
    work.stop()
  })

  it('uses fresh telemetry after a status failure and restores details when status recovers', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(NOON)
    const box = new SimBox({ now: () => Date.now() })
    const serve = box.api.serve.bind(box.api)
    let failStatus = false
    // The box's snapshot carries a warning on the battery and a house use of
    // its own. Only the snapshot says either, so the ring shows which source
    // drew the house.
    const warning = { driver: 'lynx', kind: 'battery', status: 'not_following', reason: 'setpoint_changed', severity: 'warning', evidence: 'accepted', readings_fresh: true }
    vi.spyOn(box.api, 'serve').mockImplementation(req => {
      if (req.path !== '/api/status') return serve(req)
      if (failStatus) {
        return { status: 503, contentType: 'application/json', body: new TextEncoder().encode('{}') }
      }
      const res = serve(req)
      if ('code' in res) return res
      const body = JSON.parse(new TextDecoder().decode(res.body)) as Record<string, unknown>
      // Copied into this realm's Uint8Array, or the frame encoder sees an
      // array of numbers rather than bytes.
      const bytes = Uint8Array.from(new TextEncoder().encode(JSON.stringify({ ...body, load_w: 12_345, control_feedback: [warning] })))
      return { ...res, body: bytes }
    })
    const marked = () => document.querySelector('[data-node="battery"] .mark') !== null
    const fromSnapshot = () => /12 kW/.test(document.querySelector('[data-node="home"]')?.textContent ?? '')
    const site = new SiteStore('test')
    site.connect(new LoopbackCarrier(box, { latencyMs: 0 }))
    const view = render(Now, { props: { site } })
    for (let i = 0; i < 300 && !document.querySelector('.card.fuse'); i++) {
      box.tick(20)
      await vi.advanceTimersByTimeAsync(20)
    }
    expect(document.querySelector('.card.fuse')?.textContent).toContain('Live safety')
    expect(marked(), 'the box snapshot never reached the ring').toBe(true)
    expect(fromSnapshot()).toBe(true)

    failStatus = true
    for (let i = 0; i < 4; i++) {
      box.tick(1_000)
      await vi.advanceTimersByTimeAsync(1_000)
    }
    expect(site.srcState).toBe('live')
    expect(ringEl()!.dataset.live, 'fresh telemetry should keep moving').toBe('true')
    expect(marked(), 'a stale snapshot still drew the ring').toBe(false)
    expect(fromSnapshot(), 'a stale snapshot still drew the ring').toBe(false)
    expect(document.body.textContent).toContain('Device details are out of date. Showing live totals.')
    expect(document.querySelector('.card.fuse')?.textContent).not.toContain('Live safety')
    expect(document.querySelector('.card.fuse time')?.getAttribute('datetime')).toBeTruthy()
    expect(document.querySelector('#today-title')?.textContent).toBe('Last totals')

    failStatus = false
    for (let i = 0; i < 4; i++) {
      box.tick(1_000)
      await vi.advanceTimersByTimeAsync(1_000)
    }
    expect(ringEl()!.dataset.live).toBe('true')
    expect(marked(), 'the recovered snapshot did not reach the ring').toBe(true)
    expect(fromSnapshot()).toBe(true)
    expect(document.body.textContent).not.toContain('Device details are out of date')
    expect(document.querySelector('.card.fuse')?.textContent).toContain('Live safety')
    expect(document.querySelector('#today-title')?.textContent).toBe('Today')
    view.unmount()
    site.destroy()
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
    expect(text()).toMatch(/Plan active|Fallback active|Manual|Checking/)
    expect(text()).not.toMatch(/The battery is charging/)
    expect(text()).toMatch(/\bToday\b/)
    expect(text()).toMatch(/\bFuse\b/)
    const chart = document.querySelector('ftw-price-chart')
    expect(chart, 'the compact price chart never mounted').not.toBeNull()
    expect(chart!.hasAttribute('fed'), 'the chart fetched /api/prices on this origin').toBe(true)
    expect(chart!.hasAttribute('compact')).toBe(true)
  })
})
