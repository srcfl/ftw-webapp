import { describe, it, expect } from 'vitest'
import { chartPrices, hasHole } from './price'
import type { Prices } from '$lib/protocol/messages'

// The mapping between the wire's price window and the vendored chart. The
// component itself is the box's file and is not under test here — what is
// under test is every rename and unit change the app makes before speaking
// to it, because a silent one of those puts the right shape on screen with
// the wrong numbers in it.

const WIRE: Prices = {
  zone: 'SE4',
  currency: 'SEK',
  stale: false,
  slots: [
    { startMs: 1_800_000_000_000, durationMs: 3_600_000, spotMinor: 17, totalMinor: 109 },
    { startMs: 1_800_003_600_000, durationMs: 900_000, spotMinor: -4, totalMinor: 82 },
  ],
}

describe('chartPrices', () => {
  it('renames every field the component reads', () => {
    const slot = chartPrices(WIRE).slots[0]!

    expect(slot.tsMs).toBe(1_800_000_000_000)
    expect(slot.spot).toBe(17)
    expect(slot.total).toBe(109)
  })

  it('converts slot length from milliseconds to minutes', () => {
    const slots = chartPrices(WIRE).slots

    expect(slots[0]!.lenMin).toBe(60)
    // Quarter-hour settlement, which is what the day-ahead market moved to.
    expect(slots[1]!.lenMin).toBe(15)
  })

  it('keeps the slot end where the box put it', () => {
    // The component finds a slot's end as tsMs + lenMin × 60 000. Anything
    // lossy in the conversion above moves that end, and with it the NOW
    // marker and every tick label.
    for (const [i, slot] of chartPrices(WIRE).slots.entries()) {
      const wire = WIRE.slots[i]!
      expect(slot.tsMs + slot.lenMin * 60_000).toBe(wire.startMs + wire.durationMs)
    }
  })

  it('carries the total across rather than recomputing it', () => {
    // The box holds the grid tariff and the VAT rate. Spot × 1.25 here would
    // read 21 öre for the slot the box's own dashboard prices at 109.
    const totals = chartPrices(WIRE).slots.map((s) => s.total)
    expect(totals).toEqual([109, 82])
  })

  it('keeps a negative spot negative', () => {
    // Priced to be taken. The chart draws those bars below the zero line and
    // colours them differently, which it cannot do if the sign is lost.
    expect(chartPrices(WIRE).slots[1]!.spot).toBe(-4)
  })

  it('passes the labels and the staleness through untouched', () => {
    expect(chartPrices(WIRE).zone).toBe('SE4')
    expect(chartPrices(WIRE).currency).toBe('SEK')
    expect(chartPrices(WIRE).stale).toBe(false)
    // Tomorrow's rates have not published. Saying so is the difference
    // between a short window and a market that stopped.
    expect(chartPrices({ ...WIRE, stale: true }).stale).toBe(true)
  })

  it('maps an empty window to an empty window', () => {
    expect(chartPrices({ ...WIRE, slots: [] }).slots).toEqual([])
  })
})

/* Telling the shapes of a short answer apart.
 *
 * The box sets one flag over all three — a window that begins after its start,
 * one with a hole in the middle, one that stops short of the end — so this is
 * the only thing that can keep the view from saying "tomorrow isn't published"
 * over a day missing its morning.
 */
describe('hasHole', () => {
  /** Where the window that produced WIRE was asked to start. */
  const ASKED_FROM = 1_800_000_000_000

  it('does not call a slot that joins the last one a hole', () => {
    // The mixed case on purpose: an hour followed by a quarter of one, meeting
    // exactly. Comparing starts rather than ends would read this as a gap.
    expect(hasHole(chartPrices(WIRE).slots, ASKED_FROM)).toBe(false)
  })

  it('finds an hour nobody sent', () => {
    const withGap = chartPrices({
      ...WIRE,
      slots: [
        { startMs: 1_800_000_000_000, durationMs: 3_600_000, spotMinor: 17, totalMinor: 109 },
        // 3 600 000 ms later would join. This starts an hour after that.
        { startMs: 1_800_007_200_000, durationMs: 3_600_000, spotMinor: 21, totalMinor: 113 },
      ],
    })
    expect(hasHole(withGap.slots, ASKED_FROM)).toBe(true)
  })

  it('finds a window that never started', () => {
    // The shape a box sends when its store begins mid-day: eighteen hourly
    // slots from 06:00 answering a request for the whole day. Every slot joins
    // the last, so looking only between them sees a flawless day — and the
    // chart, which lays bars out by index, draws one.
    const lateStart = chartPrices({
      ...WIRE,
      slots: [
        { startMs: ASKED_FROM + 6 * 3_600_000, durationMs: 3_600_000, spotMinor: 17, totalMinor: 109 },
        { startMs: ASKED_FROM + 7 * 3_600_000, durationMs: 3_600_000, spotMinor: 21, totalMinor: 113 },
      ],
    })
    expect(hasHole(lateStart.slots, ASKED_FROM)).toBe(true)
  })

  it('does not invent a hole before a window that starts where it was asked to', () => {
    const onTime = chartPrices({ ...WIRE, slots: [WIRE.slots[0]!] })
    expect(hasHole(onTime.slots, ASKED_FROM)).toBe(false)
    // The box is free to answer with more than was asked for.
    expect(hasHole(onTime.slots, ASKED_FROM + 60_000)).toBe(false)
  })

  it('has no hole in a window of none', () => {
    // Nothing at all is a chart that draws nothing, and a notice about
    // missing hours under an empty rectangle explains the wrong thing.
    expect(hasHole([], ASKED_FROM)).toBe(false)
  })
})
