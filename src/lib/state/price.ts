/* From a price window on the wire to the price chart's own vocabulary.
 *
 * The box's dashboard feeds this component from /api/prices, where a slot is
 * {slot_ts_ms, slot_len_min, spot_ore_kwh}; this is the same mapping fed from
 * the session instead. Two names change and one unit does, and that is the
 * whole of it — the component is the box's file and is not touched here.
 *
 * The total is carried across rather than recomputed. The box holds the grid
 * tariff and the VAT rate and applies them once; an app that multiplied spot
 * by its own guess would put a different number under the same hour than the
 * box's own dashboard does, which is the fault this component already had
 * once and was fixed for.
 */

import type { Prices } from '$lib/protocol/messages'
import type { FtwPriceChartWindow, FtwPriceChartSlot } from '$vendor/ftw/ftw-price-chart.js'

const MINUTE_MS = 60_000

/**
 * Build the component's window from the wire's.
 *
 * Slot length crosses as milliseconds and the component counts in minutes, so
 * this divides — exactly, since the component multiplies by the same number
 * to find where a slot ends. Rounding here would move the end of a slot.
 */
export function chartPrices(wire: Prices): FtwPriceChartWindow {
  return {
    zone: wire.zone,
    currency: wire.currency,
    stale: wire.stale,
    slots: wire.slots.map((s) => ({
      tsMs: s.startMs,
      lenMin: s.durationMs / MINUTE_MS,
      spot: s.spotMinor,
      total: s.totalMinor,
    })),
  }
}

/**
 * Whether the window misses hours it should have, rather than ending early.
 *
 * The box sets `stale` for either — its rule is that the answer does not
 * cover the window asked for, and all three shapes of short answer fall under
 * it: one failed midday fetch leaves a store holding 00:00-06:00 and
 * 12:00-24:00, and a store that first heard from the market at breakfast
 * holds 06:00-24:00 of a day asked for from midnight. Those two are missing
 * hours; a window that merely stops early is waiting for tomorrow. They need
 * different sentences and the flag cannot carry both, so the app reads it off
 * the slots it already holds.
 *
 * `fromMs` is where the window was asked to start, and it is what makes a
 * missing head visible at all. A store that begins at 06:00 answers a request
 * for the whole day with eighteen slots that join each other perfectly, so
 * looking only between slots sees a complete day — and the chart lays bars
 * out by index and closes the gap visually, which puts the NOW marker on the
 * wrong bar with nothing on the screen saying so.
 */
export function hasHole(slots: readonly FtwPriceChartSlot[], fromMs: number): boolean {
  if (slots.length === 0) return false
  if (slots[0]!.tsMs > fromMs) return true

  for (let i = 1; i < slots.length; i++) {
    const prev = slots[i - 1]!
    if (prev.tsMs + prev.lenMin * MINUTE_MS < slots[i]!.tsMs) return true
  }
  return false
}
