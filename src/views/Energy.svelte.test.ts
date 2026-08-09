/* Energy by day, against a box that answers and one that goes quiet.
 *
 * Everything is real — a Session, a SimBox, the loopback carrier dropping the
 * way a socket drops in the field. Only the count of asks is a spy.
 *
 * Two things are pinned here that a passing render would not catch on its own:
 * that the figures add up between the card and the bars under it, and that a
 * screen whose ask the wire cut short fills itself in when the wire comes
 * back. There is no reload button in this app; healing is the code's job.
 */

import { describe, it, expect, vi, afterEach } from 'vitest'
import { render } from '@testing-library/svelte'
import Energy from './Energy.svelte'
import { SiteStore } from '$lib/state/site.svelte'
import { LoopbackCarrier } from '$lib/carrier/loopback'
import { SimBox } from '$lib/sim/box'

/** Fixed, so the simulated house has the same week behind it every run. */
const NOON = new Date(2026, 6, 15, 12, 0, 0).getTime()

function text(): string {
  return document.body.textContent ?? ''
}

/**
 * The chart, once it exists.
 *
 * The component is fetched with a dynamic import so it never sits on the path
 * to a first frame, and how many turns of the microtask queue that costs is
 * not a fixed number — it depends on whether the module was already in the
 * cache from an earlier test. A single advance passed on one run and failed on
 * the next, which is worse than either.
 */
async function chartWhenDrawn(): Promise<HTMLElement & { data: { value: number }[] }> {
  for (let i = 0; i < 100; i++) {
    const el = document.querySelector('ftw-bar-chart') as
      | (HTMLElement & { data: { value: number }[] })
      | null
    if (el?.data?.length) return el
    await vi.advanceTimersByTimeAsync(20)
  }
  throw new Error('the chart was never drawn')
}

describe('the energy screen', () => {
  afterEach(() => {
    document.body.replaceChildren()
    vi.useRealTimers()
    vi.restoreAllMocks()
  })

  it('shows the four figures a household came for', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(NOON)

    const box = new SimBox({ now: () => Date.now() })
    const site = new SiteStore('test')
    site.connect(new LoopbackCarrier(box, { latencyMs: 0 }))

    render(Energy, { props: { site } })
    await vi.advanceTimersByTimeAsync(500)

    for (const label of ['Used at home', 'Made by solar', 'Bought', 'Sold']) {
      expect(text(), `${label} is missing`).toContain(label)
    }
    // A house with solar and a battery bought some and sold some. Dashes
    // everywhere would render perfectly and mean nothing arrived.
    expect(text()).toMatch(/kWh/)
    expect(text()).not.toMatch(/—\s*—/)
  })

  it('draws bars that add up to the figure above them', async () => {
    // The rule that has bitten this area before: two numbers side by side in
    // different units, or rounded twice. The card is the sum of the bars, and
    // it has to be the sum of the bars a person can read off the chart.
    vi.useFakeTimers()
    vi.setSystemTime(NOON)

    const box = new SimBox({ now: () => Date.now() })
    const site = new SiteStore('test')
    site.connect(new LoopbackCarrier(box, { latencyMs: 0 }))

    render(Energy, { props: { site } })
    await vi.advanceTimersByTimeAsync(500)

    const bars = (await chartWhenDrawn()).data
    expect(bars).toHaveLength(7)

    const sumKwh = bars.reduce((t, b) => t + b.value, 0)
    const card = document.querySelector('.card[aria-pressed="true"] .card-value')
    const shown = Number((card?.textContent ?? '').replace(/[^0-9.]/g, ''))

    // Both sides printed at the same precision the card uses, because that is
    // the comparison a person makes with their eyes.
    expect(shown).toBeCloseTo(Number(sumKwh.toFixed(shown < 10 ? 1 : 0)), 0)
  })

  it('fills in on its own once the carrier is back', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(NOON)

    const box = new SimBox({ now: () => Date.now() })
    // Enough latency that the wire can be cut while the ask is still on it.
    const carrier = new LoopbackCarrier(box, { latencyMs: 20 })
    const site = new SiteStore('test')
    const asked = vi.spyOn(site, 'api')
    site.connect(carrier)

    render(Energy, { props: { site } })

    for (let i = 0; i < 60 && asked.mock.calls.length === 0; i++) {
      await vi.advanceTimersByTimeAsync(5)
    }
    expect(asked).toHaveBeenCalledTimes(1)

    carrier.drop('wire died')
    await vi.advanceTimersByTimeAsync(50)
    // What the wire did, never what the house did. "Nothing recorded" was one
    // of the accepted answers here, which let a screen report an empty week
    // whenever an ask was cut short.
    expect(text()).toMatch(/out of reach|didn't answer/i)
    expect(text()).not.toMatch(/Nothing recorded/i)

    carrier.restore()
    await vi.advanceTimersByTimeAsync(1_000)

    expect(site.session.phase).toBe('streaming')
    expect(asked.mock.calls.length, 'nothing asked again once the box was back').toBeGreaterThan(1)
    expect((await chartWhenDrawn()).data).toHaveLength(7)
  })

  it('asks again once the hour turns, on a wire that never drops', async () => {
    // "Today so far" keeps filling all day, and a figure fetched at nine in
    // the morning used to still be the figure at nine in the evening unless
    // the carrier happened to drop or the day turned over. The hour is part
    // of the name the ask is made under, on a clock that ticks — a bare
    // Date.now() in the name re-fires nothing.
    vi.useFakeTimers()
    vi.setSystemTime(NOON)

    const box = new SimBox({ now: () => Date.now() })
    const site = new SiteStore('test')
    const asked = vi.spyOn(site, 'api')
    site.connect(new LoopbackCarrier(box, { latencyMs: 0 }))

    render(Energy, { props: { site } })
    for (let i = 0; i < 60 && asked.mock.calls.length === 0; i++) {
      await vi.advanceTimersByTimeAsync(5)
    }
    await vi.advanceTimersByTimeAsync(200)
    const before = asked.mock.calls.length

    // An hour of quiet streaming — no drop, no midnight.
    for (let i = 0; i < 61; i++) {
      box.tick()
      await vi.advanceTimersByTimeAsync(60_000)
    }

    expect(site.session.phase).toBe('streaming')
    expect(
      asked.mock.calls.length,
      "today's figure froze at the hour it was fetched"
    ).toBeGreaterThan(before)
  })

  it('never says the house recorded nothing before the box has said so', async () => {
    // Three states, not two — the same rule the roster learned the hard way. A
    // period the app has not read is not a period with nothing in it, and the
    // difference matters most to the household whose box is slow to answer:
    // "Nothing recorded for this period yet" is a statement about their home,
    // made from an empty variable.
    vi.useFakeTimers()
    vi.setSystemTime(NOON)

    // A box that is starting: it answers the handshake, so its capabilities
    // arrive and this section draws — and it sends no readings, so nothing
    // asks for a figure yet. That window is minutes long after an update,
    // which is exactly when a household opens the app to check.
    const box = new SimBox({ now: () => Date.now(), faults: { booting: true } })
    const site = new SiteStore('test')
    const asked = vi.spyOn(site, 'api')
    site.connect(new LoopbackCarrier(box, { latencyMs: 0 }))

    render(Energy, { props: { site } })
    await vi.advanceTimersByTimeAsync(2_000)

    expect(site.session.caps.has('api.passthrough'), 'the box never said').toBe(true)
    expect(asked, 'the figures were asked for after all').not.toHaveBeenCalled()
    expect(text(), 'the section never drew').toContain('Used at home')
    expect(text(), 'a period nobody has read was reported as empty').not.toMatch(
      /Nothing recorded/i
    )
  })

  it('draws nothing at all when the box has no passthrough', async () => {
    // Absent means hide, never crash — and never an empty chart, which would
    // claim the house recorded nothing.
    vi.useFakeTimers()
    vi.setSystemTime(NOON)

    const box = new SimBox({ now: () => Date.now(), faults: { maxProto: 0 } })
    const site = new SiteStore('test')
    site.connect(new LoopbackCarrier(box, { latencyMs: 0 }))

    render(Energy, { props: { site } })
    await vi.advanceTimersByTimeAsync(500)

    expect(site.session.caps.has('api.passthrough')).toBe(false)
    expect(text()).not.toContain('Used at home')
  })
})
