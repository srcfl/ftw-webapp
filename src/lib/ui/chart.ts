/* Chart maths, kept out of the canvas.
 *
 * Everything here is a pure function of a series, so truthfulness can be
 * tested without a rendering context: a hole stays a hole, extrema survive
 * reduction and a display trend stays inside its local readings.
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

/** One cubic edge ending at the next real reading. Values stay in data space. */
export interface CubicSpan {
  control1: number
  control2: number
  value: number
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
export function segmentsOf(column: ArrayLike<number>): Segment[] {
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

/** Half the time either side of a reading that contributes to its trend. */
export const TREND_HALF_WINDOW_MS = 15 * 60_000

/**
 * Number of neighbouring readings used on either side of a trend point.
 *
 * Five-minute history gets a seven-point kernel spanning 30 minutes. Hourly
 * history is already aggregated by the box and stays untouched. The cap is a
 * guard for a future sub-minute resolution: painting should never turn into
 * an unbounded O(points * radius) operation because a frame declared a tiny
 * step.
 */
export function trendRadiusFor(stepMs: number): number {
  if (!Number.isFinite(stepMs) || stepMs <= 0) return 0
  return Math.min(30, Math.floor(TREND_HALF_WINDOW_MS / stepMs))
}

/** The actual first-to-last time span of the trend kernel. */
export function trendSpanMs(stepMs: number): number {
  return 2 * trendRadiusFor(stepMs) * stepMs
}

/**
 * A centred, triangular moving average for the line the eye follows.
 *
 * The raw readings remain the source of the axis and the value under the
 * finger. This is only their visual trend: alternating five-minute control
 * pulses should read as a stable operating level rather than a saw blade.
 * Triangular weights give the centre the most authority and taper smoothly
 * to either edge. Every output is a convex combination of nearby readings,
 * so it cannot invent a value outside their local range.
 *
 * Missing readings split the work into independent segments. Nothing on the
 * far side of an outage can pull the trend across it, and a short isolated
 * run is left raw because it has too little context to call a trend.
 */
export function trendOf(values: ArrayLike<number>, requestedRadius: number): Float64Array {
  const out = new Float64Array(values.length)
  out.fill(MISSING_SAMPLE)

  const radius = Math.min(
    Math.max(0, values.length - 1),
    Math.max(0, Math.floor(requestedRadius))
  )

  for (const segment of segmentsOf(values)) {
    const count = segment.end - segment.start
    if (radius === 0 || count < 2 * radius + 1) {
      for (let i = segment.start; i < segment.end; i++) out[i] = values[i]!
      continue
    }

    for (let i = segment.start; i < segment.end; i++) {
      const from = Math.max(segment.start, i - radius)
      const to = Math.min(segment.end - 1, i + radius)
      let weighted = 0
      let totalWeight = 0

      for (let j = from; j <= to; j++) {
        const weight = radius + 1 - Math.abs(j - i)
        weighted += values[j]! * weight
        totalWeight += weight
      }

      out[i] = weighted / totalWeight
    }
  }

  return out
}

/**
 * Join one present run with a smooth curve that still goes through every sample.
 *
 * This is shape-preserving cubic Hermite interpolation (PCHIP). The controls
 * for an edge remain between that edge's two readings, so the Bezier curve
 * cannot overshoot them; at a peak, trough or plateau the tangent becomes
 * flat instead of rounding the turn into a value the box never recorded.
 *
 * The result contains one span per pair of readings. Its x controls belong at
 * one and two thirds of the distance between those readings; x is kept out of
 * this function because the same values are painted both at sample positions
 * and at reduced pixel-column positions.
 */
export function monotoneCurveOf(values: ArrayLike<number>, segment: Segment): CubicSpan[] {
  const count = segment.end - segment.start
  if (count < 2) return []

  const deltas = new Float64Array(count - 1)
  for (let i = 0; i < deltas.length; i++) {
    deltas[i] = values[segment.start + i + 1]! - values[segment.start + i]!
  }

  const slopes = new Float64Array(count)
  if (count === 2) {
    slopes[0] = deltas[0]!
    slopes[1] = deltas[0]!
  } else {
    // PCHIP's one-sided endpoint estimate, limited to the first edge so its
    // control cannot leave the interval between the first two readings.
    const endpoint = (edge: number, neighbour: number): number => {
      let slope = (3 * edge - neighbour) / 2
      if (Math.sign(slope) !== Math.sign(edge)) return 0
      if (Math.sign(edge) !== Math.sign(neighbour) && Math.abs(slope) > 3 * Math.abs(edge)) {
        slope = 3 * edge
      }
      return slope
    }

    slopes[0] = endpoint(deltas[0]!, deltas[1]!)
    slopes[count - 1] = endpoint(deltas[count - 2]!, deltas[count - 3]!)

    for (let i = 1; i < count - 1; i++) {
      const before = deltas[i - 1]!
      const after = deltas[i]!
      // A direction change or a flat edge is an extremum. A zero tangent is
      // what keeps the curve on the readings' side of it.
      slopes[i] =
        before === 0 || after === 0 || Math.sign(before) !== Math.sign(after)
          ? 0
          : (2 * before * after) / (before + after)
    }
  }

  const out: CubicSpan[] = []
  for (let i = 0; i < count - 1; i++) {
    const value = values[segment.start + i]!
    const next = values[segment.start + i + 1]!
    out.push({
      control1: value + slopes[i]! / 3,
      control2: next - slopes[i + 1]! / 3,
      value: next,
    })
  }
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
export function columnsOf(column: ArrayLike<number>, width: number): Column[] {
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
