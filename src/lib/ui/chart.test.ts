/* A hole in the data is drawn as a hole.
 *
 * This is the one property of the chart worth a test. A line running straight
 * across a four-hour outage is not a simplification of the truth — it is four
 * hours of readings the house never took, drawn as though it had.
 */

import { describe, it, expect } from 'vitest'
import { MISSING_SAMPLE } from '$lib/protocol/messages'
import { segmentsOf, domainOf, unionDomain, ticksOf, indexAt, isPresent } from './chart'

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
})

describe('the readout follows the finger', () => {
  it('maps a position to a sample index', () => {
    expect(indexAt(0, 100, 11)).toBe(0)
    expect(indexAt(100, 100, 11)).toBe(10)
    expect(indexAt(50, 100, 11)).toBe(5)
  })

  it('returns an index inside a gap rather than snapping to distant data', () => {
    // The readout says "no reading" there, which is true. Snapping the cursor
    // across the hole would suggest the hole is not there.
    expect(indexAt(50, 100, 11)).toBe(5)
    expect(indexAt(-1, 100, 11)).toBeNull()
    expect(indexAt(5, 100, 0)).toBeNull()
  })
})
