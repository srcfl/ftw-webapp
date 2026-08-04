/* Chart maths, kept out of the canvas.
 *
 * Everything here is a pure function of a series, so the one property that
 * matters can be tested without a rendering context: a hole in the data is
 * drawn as a hole. A line that runs straight across a four-hour outage is not
 * a simplification, it is four hours of readings the house never took.
 *
 * No chart library. A line, an axis and a hit test are less code than the
 * adapter would be, and this way the gap rule is ours to enforce rather than
 * a library option we hope stays set.
 */

import { MISSING_SAMPLE } from '$lib/protocol/messages'

/** One drawn series: which column, what to call it, and which token colours it. */
export interface Trace {
  name: string
  label: string
  /** A custom property from tokens.css. Colour carries meaning, so never a hex. */
  colorVar: string
}

/** A run of consecutive present samples. `end` is exclusive. */
export interface Segment {
  start: number
  end: number
}

export function isPresent(value: number | undefined): boolean {
  return value !== undefined && value !== MISSING_SAMPLE
}

/**
 * Split a column into the runs that actually have readings.
 *
 * One stroke per segment, so the pen lifts over every gap. A single sample
 * standing alone is still a segment — it draws as a dot rather than
 * disappearing, because a reading that exists should be visible.
 */
export function segmentsOf(column: Int32Array): Segment[] {
  const out: Segment[] = []
  let start = -1

  for (let i = 0; i < column.length; i++) {
    if (isPresent(column[i])) {
      if (start < 0) start = i
    } else if (start >= 0) {
      out.push({ start, end: i })
      start = -1
    }
  }

  if (start >= 0) out.push({ start, end: column.length })
  return out
}

export type Domain = [min: number, max: number]

/**
 * Vertical extent across every series, always including zero.
 *
 * Zero is the line that separates drawing power from sending it back, so an
 * axis that excludes it would put export and import on the same side of the
 * chart and make the sign convention invisible.
 */
export function domainOf(columns: readonly Int32Array[]): Domain {
  let min = 0
  let max = 0
  let seen = false

  for (const column of columns) {
    for (let i = 0; i < column.length; i++) {
      const v = column[i]!
      if (v === MISSING_SAMPLE) continue
      seen = true
      if (v < min) min = v
      if (v > max) max = v
    }
  }

  if (!seen) return [-1000, 1000]

  // A flat series would otherwise divide by zero and draw on the top edge.
  const pad = Math.max((max - min) * 0.08, 50)
  return [min - pad, max + pad]
}

/** Widen a domain to cover another, so the axis never shrinks mid-update. */
export function unionDomain(a: Domain, b: Domain): Domain {
  return [Math.min(a[0], b[0]), Math.max(a[1], b[1])]
}

/**
 * Round numbers for the axis: at most `count` of them, on a 1/2/5 step.
 *
 * Arbitrary divisions of the range give ticks like "3417 W", which nobody
 * reads. A person checks a chart against numbers they already hold.
 */
export function ticksOf([min, max]: Domain, count = 4): number[] {
  const raw = (max - min) / Math.max(1, count)
  if (!Number.isFinite(raw) || raw <= 0) return [0]

  const magnitude = 10 ** Math.floor(Math.log10(raw))
  const step = [1, 2, 5, 10].map((m) => m * magnitude).find((s) => s >= raw) ?? magnitude * 10

  const out: number[] = []
  for (let v = Math.ceil(min / step) * step; v <= max; v += step) out.push(v)
  return out
}

/**
 * Sample index under a horizontal position, or null when outside.
 *
 * Returns an index even where the sample is missing — the readout says "no
 * reading" there, which is a truthful answer and better than snapping the
 * cursor to distant data as though the gap were not there.
 */
export function indexAt(x: number, width: number, points: number): number | null {
  if (points <= 0 || width <= 0 || x < 0 || x > width) return null
  return Math.min(points - 1, Math.max(0, Math.round((x / width) * (points - 1))))
}
