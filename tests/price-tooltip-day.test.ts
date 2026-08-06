/* What the tooltip says, against the bar it is pointing at.
 *
 * The chart draws the horizon the toggle selects — today, tomorrow, or both —
 * but the tooltip used to look its slot up in the whole set the box sent. With
 * TOMORROW showing, bar 3 is tomorrow's slot 3 and items[3] is today's, so the
 * tooltip printed the right clock time (both days start at midnight) over the
 * wrong day's price. On Fredrik's phone a bar at the top of a 96 öre axis read
 * "9.00 öre" under his thumb.
 *
 * Vendored file: the fix was made in the box and copied here. This side has a
 * DOM, so this is where it can be shown.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { chartPrices } from '$lib/state/price'
import type { Prices } from '$lib/protocol/messages'
import type { FtwPriceChartElement } from '$vendor/ftw/ftw-price-chart.js'

const HOUR_MS = 3_600_000

function dayAt(offsetDays: number, hour: number): number {
  const d = new Date()
  d.setHours(0, 0, 0, 0)
  return d.getTime() + offsetDays * 24 * HOUR_MS + hour * HOUR_MS
}

/**
 * Two days that cannot be confused for each other: today is cheap all through,
 * tomorrow is dear all through. Any mix-up between them shows up as an order
 * of magnitude rather than a rounding difference.
 */
const CHEAP = [4, 5, 6, 7, 8, 9]
const DEAR = [301, 302, 303, 304, 305, 306]

const WIRE: Prices = {
  zone: 'SE4',
  currency: 'SEK',
  stale: false,
  slots: [
    ...CHEAP.map((spot, i) => ({
      startMs: dayAt(0, i + 1),
      durationMs: HOUR_MS,
      spotMinor: spot,
      totalMinor: spot,
    })),
    ...DEAR.map((spot, i) => ({
      startMs: dayAt(1, i + 1),
      durationMs: HOUR_MS,
      spotMinor: spot,
      totalMinor: spot,
    })),
  ],
}

function pretendPhone() {
  vi.stubGlobal('matchMedia', (query: string) => ({
    matches: /max-width:\s*600px/.test(query),
    media: query,
    addEventListener() {},
    removeEventListener() {},
    addListener() {},
    removeListener() {},
  }))
}

describe('the price tooltip', () => {
  beforeEach(pretendPhone)
  afterEach(() => {
    document.body.replaceChildren()
    vi.unstubAllGlobals()
  })

  it('reads the day that is drawn, not the day that is held', async () => {
    await import('$vendor/ftw/ftw-price-chart.js')
    const el = document.createElement('ftw-price-chart') as FtwPriceChartElement
    el.setAttribute('fed', '')
    document.body.appendChild(el)
    el.setPrices(chartPrices(WIRE))

    // Show tomorrow alone, which is what Fredrik had selected.
    const tomorrow = [...el.shadowRoot!.querySelectorAll('button')].find(
      (b) => /^tomorrow$/i.test(b.textContent?.trim() ?? '')
    ) as HTMLButtonElement
    expect(tomorrow, 'no TOMORROW toggle to select').toBeTruthy()
    tomorrow.click()

    // Point at a bar. The hit target carries the index the bars were drawn
    // with, which is the same index the tooltip resolves.
    const target = el.shadowRoot!.querySelector('[data-idx="3"]')
    expect(target, 'the chart drew no hit target').not.toBeNull()
    // The component listens on the SVG and routes by data-idx, so the event
    // has to travel the way a real pointer's does.
    target!.dispatchEvent(new MouseEvent('mousemove', { bubbles: true, clientX: 40, clientY: 40 }))

    const shown = el.shadowRoot!.querySelector('[data-tip-price]')!.textContent ?? ''
    const value = Number(shown.replace(/[^\d.-]/g, ''))

    // Tomorrow's fourth slot is 304 öre. Today's is 7. Anything near 7 means
    // the tooltip read the other day.
    expect(value, `the tooltip said "${shown}" over a bar drawn from tomorrow`).toBeGreaterThan(100)
  })
})
