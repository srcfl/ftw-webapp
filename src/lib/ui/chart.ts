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

/**
 * Where sample `i` sits, in pixels from the left edge of the plot.
 *
 * One mapping, exported, because three things have to agree on it: the line,
 * the per-pixel reduction below, and the hit test at the bottom of this file.
 * When they drifted apart the readout named a different sample from the one
 * under the finger.
 */
export function xOf(i: number, points: number, width: number): number {
  if (points <= 1 || width <= 1) return 0
  return (i / (points - 1)) * (width - 1)
}

/** One pixel column of a series: the true extent of the readings under it. */
export interface Column {
  /** Pixel column, from the left of the plot. */
  px: number
  min: number
  max: number
  /** Mean of the readings in this column. */
  mid: number
}

/**
 * Reduce a series to one entry per pixel column.
 *
 * A month at hourly resolution is 720 readings on a phone 300 pixels wide.
 * Drawn as a polyline that is not a curve, it is a comb: two or three
 * readings fight over every pixel and what the eye gets is the interference
 * between them, not the shape of the month.
 *
 * So each pixel reports what is actually under it — the lowest reading, the
 * highest, and their mean. Nothing is invented and nothing is dropped: the
 * highest reading of the window is still the highest point drawn, which is
 * exactly what a mean-only downsample would have thrown away.
 *
 * A pixel with no readings at all yields no entry, so the pen lifts there
 * the same way it lifts over a gap in `segmentsOf`.
 */
export function columnsOf(column: Int32Array, width: number): Column[] {
  const points = column.length
  if (points === 0 || width <= 0) return []

  const out: Column[] = []
  let current: Column | null = null
  let sum = 0
  let count = 0

  for (let i = 0; i < points; i++) {
    const v = column[i]!
    if (v === MISSING_SAMPLE) continue

    const px = Math.round(xOf(i, points, width))
    if (!current || current.px !== px) {
      if (current) current.mid = sum / count
      current = { px, min: v, max: v, mid: v }
      out.push(current)
      sum = 0
      count = 0
    }

    if (v < current.min) current.min = v
    if (v > current.max) current.max = v
    sum += v
    count++
  }

  if (current) current.mid = sum / count
  return out
}

/**
 * Split reduced columns into stretches of neighbouring pixels.
 *
 * A band must not close over a pixel that has no readings, for the same
 * reason a line must not. `end` is exclusive and indexes the column array,
 * not the pixel.
 */
export function runsOf(columns: readonly Column[]): Segment[] {
  if (columns.length === 0) return []

  const out: Segment[] = []
  let start = 0
  for (let i = 1; i <= columns.length; i++) {
    if (i === columns.length || columns[i]!.px !== columns[i - 1]!.px + 1) {
      out.push({ start, end: i })
      start = i
    }
  }
  return out
}

/**
 * Runs where no series has a reading — the box recorded nothing at all.
 *
 * A per-series hole shows as a lifted pen, but four lifted pens over an
 * outage read as "nothing happened" rather than "nothing is known", and the
 * eye closes the distance between the two ends by itself. These runs are
 * what the chart shades so an outage looks like one.
 */
export function blankSpans(columns: readonly Int32Array[]): Segment[] {
  const points = columns[0]?.length ?? 0
  if (points === 0 || columns.length === 0) return []

  const out: Segment[] = []
  let start = -1

  for (let i = 0; i < points; i++) {
    let any = false
    for (const column of columns) {
      if (isPresent(column[i])) {
        any = true
        break
      }
    }

    if (!any) {
      if (start < 0) start = i
    } else if (start >= 0) {
      out.push({ start, end: i })
      start = -1
    }
  }

  if (start >= 0) out.push({ start, end: points })
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
 * The vertical extent to draw against, held open by whatever is on screen.
 *
 * One function so the numbers printed beside the canvas and the rules drawn
 * on it come from the same call. Two calls drift the moment one of them
 * forgets the held domain, and then the labels name the wrong gridlines.
 */
export function axisOf(columns: readonly Int32Array[], locked: Domain | null): Domain {
  const own = domainOf(columns)
  return locked ? unionDomain(own, locked) : own
}

/**
 * Round numbers for the axis: at most `count` of them, on a 1/2/5 step.
 *
 * Arbitrary divisions of the range give ticks like "3417 W", which nobody
 * reads. A person checks a chart against numbers they already hold.
 *
 * The step is the narrowest on the ladder that still fits the budget, not the
 * first one wider than the average gap. That distinction is the whole of this
 * function: a house running between -8 kW and +12 kW asks for a 5 kW gap,
 * and taking the next rung up ruled the chart at zero and 10 kW only —
 * leaving every exported watt below an unlabelled half of the axis.
 */
export function ticksOf([min, max]: Domain, count = 4): number[] {
  const span = max - min
  if (!Number.isFinite(span) || span <= 0) return [0]

  const budget = Math.max(2, count)
  const magnitude = 10 ** Math.floor(Math.log10(span / budget))
  const ladder = [1, 2, 5, 10, 20].map((m) => m * magnitude)
  const rungs = (step: number) => Math.floor(max / step) - Math.ceil(min / step) + 1
  const step = ladder.find((s) => rungs(s) <= budget) ?? ladder[ladder.length - 1]!

  const out: number[] = []
  for (let k = Math.ceil(min / step); k * step <= max; k++) out.push(k * step)
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
  if (points === 1 || width === 1) return 0
  // The inverse of xOf, so the sample named is the sample drawn there.
  return Math.min(points - 1, Math.max(0, Math.round((x / (width - 1)) * (points - 1))))
}
