/* The seam between the wire and the box's own price chart.
 *
 * The component is vendored byte-for-byte and is not under test here. What is
 * under test is what a fed instance does with what the mapping hands it: a
 * mapping that lost the total would draw a chart of the right shape with the
 * wrong money in it, and every mount below sets `fed` because that is the
 * mode being exercised.
 *
 * That the *view* sets the attribute is a different claim, and one this file
 * cannot make — it belongs in src/views/Plan.svelte.test.ts, where the view
 * itself is mounted.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { chartPrices } from '$lib/state/price'
import type { Prices } from '$lib/protocol/messages'
import type { FtwPriceChartElement } from '$vendor/ftw/ftw-price-chart.js'

const HOUR_MS = 3_600_000

/** Slots have to land on today's calendar day: the chart filters by it. */
function todayAt(hour: number): number {
  const d = new Date()
  d.setHours(hour, 0, 0, 0)
  return d.getTime()
}

const WIRE: Prices = {
  zone: 'SE4',
  currency: 'SEK',
  stale: false,
  slots: [
    { startMs: todayAt(1), durationMs: HOUR_MS, spotMinor: 17, totalMinor: 109 },
    { startMs: todayAt(2), durationMs: HOUR_MS, spotMinor: 40, totalMinor: 137 },
    { startMs: todayAt(3), durationMs: HOUR_MS, spotMinor: -4, totalMinor: 82 },
  ],
}

async function mount(): Promise<FtwPriceChartElement> {
  await import('$vendor/ftw/ftw-price-chart.js')
  const el = document.createElement('ftw-price-chart') as FtwPriceChartElement
  el.setAttribute('fed', '')
  document.body.appendChild(el)
  return el
}

describe('the price chart, fed from the wire', () => {
  let fetched: ReturnType<typeof vi.spyOn>

  beforeEach(() => {
    fetched = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('no origin'))
  })

  afterEach(() => {
    document.body.replaceChildren()
    vi.restoreAllMocks()
  })

  it('asks no origin for anything', async () => {
    const el = await mount()
    el.setPrices(chartPrices(WIRE))

    // The app reaches its box over an encrypted session and has no HTTP
    // origin at all. A request here is a 404 and a broken promise.
    expect(fetched).not.toHaveBeenCalled()
  })

  it('draws one bar per slot it was given', async () => {
    const el = await mount()
    el.setPrices(chartPrices(WIRE))

    // Bars plus the invisible hit targets over them, one pair per slot.
    expect(el.shadowRoot!.querySelectorAll('rect[data-idx]')).toHaveLength(WIRE.slots.length * 2)
  })

  it('shows the box’s total, not one it worked out itself', async () => {
    const el = await mount()
    el.setPrices(chartPrices(WIRE))

    // Spot × 1.25 would read 50 öre high and 21 low. The box applied a grid
    // tariff this instance never fetched, and the wire carried the answer.
    const stats = el.shadowRoot!.querySelector('.meta-stats')!.textContent!
    expect(stats).toContain('137.0 öre')
    expect(stats).toContain('82.0 öre')
  })

  it('names the zone and currency the box sent', async () => {
    const el = await mount()
    el.setPrices(chartPrices(WIRE))

    const meta = el.shadowRoot!.querySelector('.meta')!.textContent!
    expect(meta).toContain('SE4')
    // Never "incl. VAT" over a total that also carries the grid tariff —
    // that claim is the fault this component was fixed for once already.
    expect(meta).not.toContain('incl. VAT')
  })

  it('replaces the window rather than appending to it', async () => {
    const el = await mount()
    el.setPrices(chartPrices(WIRE))
    el.setPrices(chartPrices({ ...WIRE, slots: WIRE.slots.slice(0, 1) }))

    expect(el.shadowRoot!.querySelectorAll('rect[data-idx]')).toHaveLength(2)
  })

  it('says so rather than drawing an empty market', async () => {
    const el = await mount()
    el.setPrices(chartPrices({ ...WIRE, slots: [] }))

    expect(el.shadowRoot!.querySelector('.empty')).not.toBeNull()
  })
})
