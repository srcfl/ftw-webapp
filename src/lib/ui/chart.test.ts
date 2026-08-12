/* The chart does not invent data.
 *
 * A line across an outage and a smooth curve beyond a measured extremum are
 * both plausible-looking values the box never reported. These tests keep
 * gaps, reduction and interpolation inside what was actually observed.
 */

import { describe, it, expect } from 'vitest'
import { MISSING_SAMPLE } from '$lib/protocol/messages'
import {
  segmentsOf,
  monotoneCurveOf,
  domainOf,
  unionDomain,
  ticksOf,
  indexAt,
  isPresent,
  xOf,
  columnsOf,
  runsOf,
  blankSpans,
  type Domain,
} from './chart'

describe('the curve between readings', () => {
  it('passes through every reading without overshooting either neighbour', () => {
    const values = new Int32Array([0, 4000, 1000, 1000, -3000, 2000])
    const curve = monotoneCurveOf(values, { start: 0, end: values.length })

    expect(curve).toHaveLength(values.length - 1)
    curve.forEach((span, i) => {
      const low = Math.min(values[i]!, values[i + 1]!)
      const high = Math.max(values[i]!, values[i + 1]!)
      expect(span.value, `edge ${i} missed its measured endpoint`).toBe(values[i + 1])
      expect(span.control1, `edge ${i} rose above or below its readings`).toBeGreaterThanOrEqual(low)
      expect(span.control1, `edge ${i} rose above or below its readings`).toBeLessThanOrEqual(high)
      expect(span.control2, `edge ${i} rose above or below its readings`).toBeGreaterThanOrEqual(low)
      expect(span.control2, `edge ${i} rose above or below its readings`).toBeLessThanOrEqual(high)
    })
  })

  it('flattens a peak and a trough instead of rounding past them', () => {
    const values = new Int32Array([0, 3000, -2000, 1000])
    const curve = monotoneCurveOf(values, { start: 0, end: values.length })

    // The control on each side of an extremum equals the extremum itself:
    // that is a zero tangent and therefore no hidden value beyond it.
    expect(curve[0]!.control2).toBe(3000)
    expect(curve[1]!.control1).toBe(3000)
    expect(curve[1]!.control2).toBe(-2000)
    expect(curve[2]!.control1).toBe(-2000)
  })

  it('does not join across a missing run or invent a curve for one point', () => {
    const values = new Int32Array([0, 1000, MISSING_SAMPLE, 2000])
    const segments = segmentsOf(values)

    expect(segments.map((segment) => monotoneCurveOf(values, segment).length)).toEqual([1, 0])
  })
})

describe('segments lift the pen over a gap', () => {
  it('splits a series at every missing sample', () => {
    const column = new Int32Array([100, 200, MISSING_SAMPLE, MISSING_SAMPLE, 300, 400])
    expect(segmentsOf(column)).toEqual([
      { start: 0, end: 2 },
      { start: 4, end: 6 },
    ])
  })

  it('never joins the samples either side of a hole', () => {
    // The failure this exists to prevent: one stroke from index 1 to index 4,
    // inventing two readings that were never taken.
    const column = new Int32Array([100, 200, MISSING_SAMPLE, MISSING_SAMPLE, 300, 400])
    for (const segment of segmentsOf(column)) {
      for (let i = segment.start; i < segment.end; i++) {
        expect(isPresent(column[i])).toBe(true)
      }
    }
  })

  it('keeps a lone reading visible instead of dropping it', () => {
    const column = new Int32Array([MISSING_SAMPLE, 500, MISSING_SAMPLE])
    expect(segmentsOf(column)).toEqual([{ start: 1, end: 2 }])
  })

  it('draws nothing at all for a window the box has no data for', () => {
    expect(segmentsOf(new Int32Array([MISSING_SAMPLE, MISSING_SAMPLE]))).toEqual([])
    expect(segmentsOf(new Int32Array(0))).toEqual([])
  })

  it('closes a segment that runs to the end of the series', () => {
    expect(segmentsOf(new Int32Array([MISSING_SAMPLE, 1, 2]))).toEqual([{ start: 1, end: 3 }])
  })
})

/**
 * A month of readings is denser than a phone has pixels, so the chart reduces
 * before it draws. Reducing is allowed to lose detail. It is not allowed to
 * invent any, and it is not allowed to close a hole — the rule at the top of
 * this file does not stop applying because the data got dense.
 */
describe('more readings than pixels', () => {
  const PX = 300
  const POINTS = 720

  /** An hourly month with a recognisable peak, and a hole where asked for. */
  function month(hole?: { from: number; len: number }): Int32Array {
    const column = new Int32Array(POINTS)
    for (let i = 0; i < POINTS; i++) column[i] = 1000 + (i % 24) * 100
    column[500] = 9999
    if (hole) for (let i = hole.from; i < hole.from + hole.len; i++) column[i] = MISSING_SAMPLE
    return column
  }

  it('keeps the highest reading of the window as the highest thing drawn', () => {
    // What a mean-only downsample throws away. The peak hour of the month is
    // the reading the month is remembered by, and averaging it with the two
    // hours either side of it is how a chart quietly flattens a house.
    const reduced = columnsOf(month(), PX)
    expect(Math.max(...reduced.map((c) => c.max))).toBe(9999)
  })

  it('never reports a value no reading in that pixel reached', () => {
    const column = month()
    for (const c of columnsOf(column, PX)) {
      expect(c.min).toBeLessThanOrEqual(c.mid)
      expect(c.mid).toBeLessThanOrEqual(c.max)
      expect([...column].includes(c.min)).toBe(true)
      expect([...column].includes(c.max)).toBe(true)
    }
  })

  it('leaves every pixel a gap covers empty, and draws no run across one', () => {
    // The failure this exists to prevent: an outage reduced away, and the
    // band closed over it as though the house had been running all along.
    const column = month({ from: 300, len: 48 })
    const reduced = columnsOf(column, PX)

    const drawn = new Set(reduced.map((c) => c.px))
    for (let i = 300; i < 348; i++) {
      const px = Math.round(xOf(i, POINTS, PX))
      // Unless a present sample shares the pixel, nothing is drawn there.
      const shared = [...Array(POINTS).keys()].some(
        (j) => isPresent(column[j]) && Math.round(xOf(j, POINTS, PX)) === px
      )
      if (!shared) expect(drawn.has(px)).toBe(false)
    }

    for (const run of runsOf(reduced)) {
      for (let i = run.start; i < run.end; i++) expect(drawn.has(reduced[i]!.px)).toBe(true)
      // Contiguous by pixel, which is what stops a run spanning an empty one.
      for (let i = run.start + 1; i < run.end; i++) {
        expect(reduced[i]!.px).toBe(reduced[i - 1]!.px + 1)
      }
    }
    expect(runsOf(reduced).length).toBeGreaterThan(1)
  })

  it('marks a stretch no series recorded anything for', () => {
    // Four lifted pens read as a quiet afternoon. The shaded span is what
    // makes it read as an outage instead.
    const present = new Int32Array(10).fill(500)
    const holed = new Int32Array(10).fill(500)
    for (let i = 4; i < 7; i++) {
      present[i] = MISSING_SAMPLE
      holed[i] = MISSING_SAMPLE
    }
    expect(blankSpans([present, holed])).toEqual([{ start: 4, end: 7 }])

    // One series still reading is not an outage, however long the other is out.
    const reading = new Int32Array(10).fill(500)
    expect(blankSpans([reading, holed])).toEqual([])
  })
})

describe('the vertical axis', () => {
  it('ignores missing samples rather than plotting INT32_MIN', () => {
    // Without this the axis runs to negative two billion and every real
    // reading collapses onto one pixel at the top.
    const [min, max] = domainOf([new Int32Array([MISSING_SAMPLE, 1000, 2000])])
    expect(min).toBeGreaterThan(-10_000)
    expect(max).toBeGreaterThan(2000)
  })

  it('always contains zero, which is where import becomes export', () => {
    const [min, max] = domainOf([new Int32Array([3000, 4000])])
    expect(min).toBeLessThanOrEqual(0)
    expect(max).toBeGreaterThan(0)
  })

  it('gives a drawable range for a series that is entirely missing', () => {
    const [min, max] = domainOf([new Int32Array([MISSING_SAMPLE])])
    expect(max).toBeGreaterThan(min)
  })

  it('only ever widens when held', () => {
    // Holding the axis is what stops the chart jumping when sharper data
    // lands. A union can grow; it can never shrink under the user.
    const held: [number, number] = [-5000, 5000]
    expect(unionDomain([-1000, 1000], held)).toEqual(held)
    expect(unionDomain([-9000, 1000], held)).toEqual([-9000, 5000])
  })

  it('puts ticks on numbers a person already holds', () => {
    for (const tick of ticksOf([-5000, 5000], 4)) {
      expect(Math.abs(tick % 1000)).toBe(0)
    }
  })

  it('rules the export half of the chart, not just the import half', () => {
    // A house between -8 kW and +12 kW. Taking the first step wider than the
    // average gap gave two rungs, zero and 10 kW, and every watt the house
    // sent back sat under an axis with nothing written on it — no number, and
    // so no "out" either, which is the only thing on a chart that says which
    // way is which.
    const ticks = ticksOf([-8000, 12500], 4)
    expect(ticks.some((t) => t < 0), 'nothing labels the export side').toBe(true)
    expect(ticks.length).toBeGreaterThanOrEqual(3)
    expect(ticks.length).toBeLessThanOrEqual(4)
  })

  it('never rules outside the extent it was given', () => {
    const domains: Domain[] = [
      [-8000, 12500],
      [-5000, 5000],
      [-50, 50],
      [0, 240_000],
    ]
    for (const domain of domains) {
      for (const tick of ticksOf(domain, 4)) {
        expect(tick).toBeGreaterThanOrEqual(domain[0])
        expect(tick).toBeLessThanOrEqual(domain[1])
      }
    }
  })
})

describe('the readout follows the finger', () => {
  it('maps a position to a sample index', () => {
    expect(indexAt(0, 100, 11)).toBe(0)
    expect(indexAt(100, 100, 11)).toBe(10)
    expect(indexAt(50, 100, 11)).toBe(5)
  })

  it('names the sample that is drawn under the finger', () => {
    // The hit test is the inverse of the mapping the series is drawn with, or
    // it is a different chart. It used to divide by the width where the line
    // divides by the width less one: near the right edge the readout named a
    // sample two along from the one the finger was on, and the last sample of
    // the window could not be reached at all.
    const points = 288
    const width = 275
    for (const i of [0, 1, 143, 286, 287]) {
      expect(indexAt(xOf(i, points, width), width, points), `sample ${i}`).toBe(i)
    }
  })

  it('returns an index inside a gap rather than snapping to distant data', () => {
    // The readout says "no reading" there, which is true. Snapping the cursor
    // across the hole would suggest the hole is not there.
    expect(indexAt(50, 100, 11)).toBe(5)
    expect(indexAt(-1, 100, 11)).toBeNull()
    expect(indexAt(5, 100, 0)).toBeNull()
  })
})
