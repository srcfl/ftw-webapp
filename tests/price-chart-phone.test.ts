/* The chart on a phone: how much screen it takes, and whether its axis fits.
 *
 * Two claims, both about geometry the component decides for itself, and both
 * things a browser would show and jsdom would not. What is checked here is
 * the SVG the component writes, which is where the geometry is: the viewBox
 * it picks, the font sizes it picks, and where it puts the y-axis labels.
 *
 * This is a vendored file, so the change these lock in was made in the box
 * and copied here — see tests/vendored.test.ts. The test lives on this side
 * anyway, because the shorter box is the *app's* height, taken when the
 * component is fed rather than fetching; the box's own dashboard keeps the
 * height it had, and that is asserted below too. A re-copy that lost either
 * half fails here, which is the point of having it.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { chartPrices } from '$lib/state/price'
import type { Prices } from '$lib/protocol/messages'
import type { FtwPriceChartElement } from '$vendor/ftw/ftw-price-chart.js'

const HOUR_MS = 3_600_000

/** The phone the app is drawn against. Height, because that is what runs out. */
const PHONE_HEIGHT_PX = 812
/** 375 px of phone, less the Plan screen's --space-4 gutter on each side. */
const CHART_WIDTH_PX = 375 - 2 * 16

/**
 * A monospace advance, in ems.
 *
 * The component sizes its left gutter from the label text because it cannot
 * measure a glyph while building a string, and neither can this test. Both
 * ends assume the same thing about the --mono stack; what the test adds is
 * that the assumption is applied to the labels actually written, so a gutter
 * that goes back to a fixed number fails here rather than in someone's hand.
 */
const MONO_ADVANCE_EM = 0.62

function todayAt(hour: number): number {
  const d = new Date()
  d.setHours(hour, 0, 0, 0)
  return d.getTime()
}

/**
 * A day whose lowest slot is above zero, so the axis floor is 0 and the
 * bottom label is "0.00 ö" — the longest of the three, and the one that lost
 * its leading zero off the left edge of the SVG.
 */
const WIRE: Prices = {
  zone: 'SE4',
  currency: 'SEK',
  stale: false,
  slots: [17, 40, 92, 143, 66, 51].map((spot, i) => ({
    startMs: todayAt(i + 1),
    durationMs: HOUR_MS,
    spotMinor: spot,
    totalMinor: Math.round((spot + 70) * 1.25),
  })),
}

/** jsdom answers every media query with false, so the phone has to be said. */
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

async function mount(fed: boolean): Promise<FtwPriceChartElement> {
  await import('$vendor/ftw/ftw-price-chart.js')
  const el = document.createElement('ftw-price-chart') as FtwPriceChartElement
  if (fed) el.setAttribute('fed', '')
  document.body.appendChild(el)
  el.setPrices(chartPrices(WIRE))
  return el
}

function chartOf(el: FtwPriceChartElement): SVGSVGElement {
  const svg = el.shadowRoot!.querySelector('svg.chart')
  expect(svg, 'the chart drew no SVG').not.toBeNull()
  return svg as unknown as SVGSVGElement
}

/** The viewBox is "0 0 W H"; the app renders at width 100 %, so H/W is the shape. */
function box(svg: SVGSVGElement): { w: number; h: number } {
  const [, , w, h] = svg.getAttribute('viewBox')!.split(/\s+/).map(Number)
  return { w: w!, h: h! }
}

/** What the SVG paints at, in CSS pixels, from its intrinsic ratio. */
function paintedHeightPx(svg: SVGSVGElement): number {
  const { w, h } = box(svg)
  return (CHART_WIDTH_PX * h) / w
}

function fontSizes(svg: SVGSVGElement): number[] {
  return [...svg.querySelectorAll('text')]
    .map((t) => Number(t.getAttribute('font-size')))
    .filter((n) => Number.isFinite(n))
    .sort((a, b) => a - b)
}

describe('the price chart on a phone', () => {
  beforeEach(() => {
    pretendPhone()
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('no origin'))
  })

  afterEach(() => {
    document.body.replaceChildren()
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
  })

  it('gives the app a chart that leaves room for the rest of the screen', async () => {
    const app = chartOf(await mount(true))

    // The Plan screen is a sentence, the mode choice, this chart and then the
    // hour-by-hour timeline. At the dashboard's phone shape this SVG painted
    // 247 px of a 375×812 phone and the price block around it 461 — 57 % of
    // the screen, so the timeline under it was never on with it. At 151 px
    // the block is 45 %, and the chart itself under a fifth of the phone.
    const painted = paintedHeightPx(app)
    expect(painted).toBeLessThan(170)
    expect(painted / PHONE_HEIGHT_PX).toBeLessThan(0.2)
  })

  it('leaves the dashboard the height it has', async () => {
    // Without `fed` this is the box's own Energy tab, where the chart is the
    // thing you came for and the tall box is the right shape for it.
    expect(box(chartOf(await mount(false))).h).toBe(720)
  })

  it('makes the app shorter by lowering the bars, not by shrinking the type', async () => {
    const app = chartOf(await mount(true))
    const dashboard = chartOf(await mount(false))

    // Every font size is in viewBox units and the rendered scale comes from
    // the width, which neither of these changes — so a chart that is compact
    // rather than merely smaller writes exactly the same type as the tall one.
    expect(fontSizes(app)).toEqual(fontSizes(dashboard))
    expect(box(app).w).toBe(box(dashboard).w)

    // And a floor under the figures, since two charts matching would also be
    // true of two nobody can read. A viewBox unit paints at the element's
    // width over W, so the axis of a 375 px phone comes out at just over nine
    // pixels — small, and exactly where it was before any of this. Compact is
    // not the same as smaller.
    const axisFs = Number(app.querySelector('text[text-anchor="end"]')!.getAttribute('font-size'))
    expect((axisFs * CHART_WIDTH_PX) / box(app).w).toBeGreaterThanOrEqual(9)
  })

  it('keeps every y-axis figure inside the chart', async () => {
    for (const fed of [true, false]) {
      const svg = chartOf(await mount(fed))
      const { w } = box(svg)
      const labels = [...svg.querySelectorAll('text[text-anchor="end"]')]

      expect(labels.length, 'the y axis lost its labels').toBe(3)
      // "0.00 ö" is the widest of the three and the one that was cut: anchored
      // "end" just inside the gutter, it grew left past x=0 and the browser
      // clipped its first character, so the axis floor read ".00 ö".
      expect(labels.map((t) => t.textContent!.trim())).toContain('0.00 ö')

      for (const label of labels) {
        const x = Number(label.getAttribute('x'))
        const fs = Number(label.getAttribute('font-size'))
        const startsAt = x - label.textContent!.trim().length * MONO_ADVANCE_EM * fs
        expect(
          startsAt,
          `"${label.textContent!.trim()}" starts ${(-startsAt).toFixed(1)} units ` +
            `left of the chart's edge, so its first character is clipped`
        ).toBeGreaterThanOrEqual(0)
        expect(x).toBeLessThanOrEqual(w)
      }
      document.body.replaceChildren()
    }
  })
})
