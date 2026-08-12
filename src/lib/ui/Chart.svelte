<!--
  The series, on a canvas.

  Canvas for the lines and DOM for everything around them. Two thousand points
  across four series is roughly eight thousand path segments, small enough to
  paint directly without a worker. The same points as SVG nodes would be eight
  thousand elements for the browser to lay out on every resize, which is where
  charts on phones actually go wrong.

  Three rules this component exists to keep:

  - A gap is drawn as a gap. The pen lifts wherever a sample is missing, and
    a stretch no series has a reading for is shaded so it reads as an outage
    rather than as a quiet afternoon. See chart.ts, where both live and are
    tested.
  - Every reading is a knot in a shape-preserving curve. Its controls cannot
    overshoot either neighbouring reading, so smoothing a corner never invents
    a higher peak or a lower trough. When readings outnumber pixels, each pixel
    column still draws the true lowest and highest reading under it with the
    mean through the middle.
  - The vertical axis does not jump. The caller owns it, passes it in, and
    holds it open while a sharper series replaces a cached one — so the shape
    changes under a fixed axis instead of the whole chart rescaling.
-->
<script lang="ts">
  import { MISSING_SAMPLE } from '$lib/protocol/messages'
  import type { SeriesFrame } from '$lib/protocol/history'
  import {
    segmentsOf,
    columnsOf,
    runsOf,
    blankSpans,
    indexAt,
    monotoneCurveOf,
    xOf,
    type Column,
    type CubicSpan,
    type Domain,
    type Segment,
    type Trace,
  } from './chart'

  interface Props {
    frame: SeriesFrame
    traces: Trace[]
    /** The vertical extent to draw against. The caller owns it so the numbers
     *  printed beside the canvas name the rules drawn on it. */
    axis: Domain
    /** Where to rule the chart horizontally. Same values the caller labels. */
    ticks?: number[]
    /** Index under the pointer, owned by the caller so the readout can show it. */
    cursor?: number | null
    onCursor?: (index: number | null) => void
    height?: number
  }

  let { frame, traces, axis, ticks = [], cursor = null, onCursor, height = 200 }: Props = $props()

  /**
   * What a role that resolves to nothing is painted as.
   *
   * An empty resolution is a renamed token or a stylesheet that never
   * mounted, and a theme-matched fallback would mask it in the theme it
   * matches. One mid-grey for every role is visibly wrong in both themes,
   * which keeps tokens.css the only place a real colour lives.
   */
  const TOKEN_MISSING = '#808080'

  let canvas = $state<HTMLCanvasElement | null>(null)
  let box = $state<HTMLDivElement | null>(null)
  let width = $state(320)

  interface CurvedRun {
    segment: Segment
    spans: CubicSpan[]
  }

  /** One trace, ready to stroke: either a line or a band, never both. */
  type Shape =
    | { kind: 'line'; column: Int32Array; runs: CurvedRun[] }
    | { kind: 'band'; columns: Column[]; runs: CurvedRun[] }

  function curveRuns(values: ArrayLike<number>, segments: Segment[]): CurvedRun[] {
    return segments.map((segment) => ({ segment, spans: monotoneCurveOf(values, segment) }))
  }

  /**
   * The plot's width in whole pixels.
   *
   * One number, because the reduction, the paint and the hit test all have to
   * agree about where a sample sits. Rounding in one of them and not the
   * others put the band and the cursor dot a pixel apart at the right edge.
   */
  const plotW = $derived(Math.max(1, Math.round(width)))

  // Reduced here rather than inside draw() so dragging a finger across the
  // chart re-strokes the same arrays instead of rebuilding them sixty times a
  // second. Only the frame and the width can change what is drawn.
  const shapes = $derived.by((): (Shape | null)[] => {
    const w = plotW
    const dense = frame.points > w

    return traces.map((trace) => {
      const column = frame.columns[frame.names.indexOf(trace.name)]
      if (!column) return null
      if (!dense) {
        const segments = segmentsOf(column)
        return { kind: 'line', column, runs: curveRuns(column, segments) }
      }
      const columns = columnsOf(column, w)
      const segments = runsOf(columns)
      const mids = Float64Array.from(columns, (c) => c.mid)
      return { kind: 'band', columns, runs: curveRuns(mids, segments) }
    })
  })

  const blanks = $derived(blankSpans(frame.columns))

  function draw(): void {
    const el = canvas
    if (!el || !box) return

    const ctx = el.getContext('2d')
    if (!ctx) return

    // Matched to the device up to 3, which is where phones sit. Capped at all
    // because a desktop at 4 would quadruple the backing store to sharpen a
    // line nobody is holding six inches from their face.
    const dpr = Math.min(window.devicePixelRatio || 1, 3)
    const w = plotW
    const h = height

    if (el.width !== Math.round(w * dpr) || el.height !== Math.round(h * dpr)) {
      el.width = Math.round(w * dpr)
      el.height = Math.round(h * dpr)
    }

    ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
    ctx.clearRect(0, 0, w, h)

    const [min, max] = axis
    const span = max - min || 1
    const y = (v: number) => h - ((v - min) / span) * h
    const x = (i: number) => xOf(i, frame.points, w)

    // Resolved once per paint. Components read design roles, never raw
    // values, and getComputedStyle inside the stroke loop is a stall.
    const style = getComputedStyle(box)
    const role = (name: string) => style.getPropertyValue(name).trim() || TOKEN_MISSING
    const line = role('--line')
    const lineSoft = role('--line-soft')
    const sunken = role('--surface-sunken')
    const colors = traces.map((t) => role(t.colorVar))

    /**
     * Add one present run to the current path.
     *
     * Every measured/aggregated value is an endpoint. Only the connection
     * between them changes, and monotoneCurveOf keeps both controls inside
     * the neighbouring values, so the whole cubic remains inside them too.
     */
    const curvePath = (
      run: CurvedRun,
      xAt: (index: number) => number,
      startValue: number,
      joinStart = false
    ): void => {
      const { segment, spans } = run
      const startX = xAt(segment.start)
      if (joinStart) ctx.lineTo(startX, y(startValue))
      else ctx.moveTo(startX, y(startValue))
      for (let offset = 0; offset < spans.length; offset++) {
        const span = spans[offset]!
        const fromX = xAt(segment.start + offset)
        const toX = xAt(segment.start + offset + 1)
        const third = (toX - fromX) / 3
        ctx.bezierCurveTo(
          fromX + third,
          y(span.control1),
          toX - third,
          y(span.control2),
          toX,
          y(span.value)
        )
      }
    }

    // Hours the box has nothing for, shaded before anything is drawn over
    // them. Recessed rather than marked, so it reads as absence.
    ctx.fillStyle = sunken
    for (const blank of blanks) {
      const from = x(blank.start - 0.5)
      const to = x(blank.end - 0.5)
      ctx.fillRect(from, 0, Math.max(1, to - from), h)
    }

    // Rules at the numbers printed beside the chart, so a height on screen
    // can be read as a quantity rather than guessed at.
    ctx.lineWidth = 1
    for (const tick of ticks) {
      if (tick === 0) continue
      ctx.strokeStyle = lineSoft
      ctx.beginPath()
      ctx.moveTo(0, Math.round(y(tick)) + 0.5)
      ctx.lineTo(w, Math.round(y(tick)) + 0.5)
      ctx.stroke()
    }

    // Zero is the line between drawing power and sending it back, so it is
    // the only rule on the chart drawn strongly enough to read as a boundary.
    if (min < 0 && max > 0) {
      ctx.strokeStyle = line
      ctx.beginPath()
      ctx.moveTo(0, Math.round(y(0)) + 0.5)
      ctx.lineTo(w, Math.round(y(0)) + 0.5)
      ctx.stroke()
    }

    ctx.lineJoin = 'round'
    ctx.lineCap = 'round'

    shapes.forEach((shape, t) => {
      if (!shape) return
      const color = colors[t] ?? TOKEN_MISSING

      if (shape.kind === 'band') {
        // The spread of readings inside each pixel, filled; their mean, drawn
        // through it. A month of readings has both a range and a middle, and
        // one line can only carry the middle.
        const { columns, runs } = shape

        ctx.fillStyle = color
        ctx.globalAlpha = 0.28
        for (const { segment: run } of runs) {
          // One pixel wide, a band has no area to fill. The stroke below is
          // what carries it.
          if (run.end - run.start < 2) continue
          ctx.beginPath()
          ctx.moveTo(columns[run.start]!.px, y(columns[run.start]!.max))
          for (let i = run.start + 1; i < run.end; i++) {
            const c = columns[i]!
            ctx.lineTo(c.px, y(c.max))
          }
          for (let i = run.end - 1; i >= run.start; i--) {
            const c = columns[i]!
            ctx.lineTo(c.px, y(c.min))
          }
          ctx.closePath()
          ctx.fill()
        }
        ctx.globalAlpha = 1

        ctx.strokeStyle = color
        ctx.lineWidth = 1
        for (const run of runs) {
          const first = columns[run.segment.start]!
          ctx.beginPath()
          if (run.segment.end - run.segment.start === 1) {
            // A pixel standing alone between two gaps, drawn as the extent of
            // what was read there rather than as a point on a line that is
            // not there. Equal ends make a zero-length stroke, which the
            // round cap draws as a dot — the same way a lone sample is kept
            // visible below.
            ctx.moveTo(first.px, y(first.max))
            ctx.lineTo(first.px, y(first.min))
          } else {
            curvePath(run, (i) => columns[i]!.px, first.mid)
          }
          ctx.stroke()
        }
        return
      }

      // Fewer readings than pixels: every one of them, joined.
      const { column, runs } = shape

      // Filled back to zero, at a weight that reads as ground rather than as
      // a second line. A series resting at zero then has no mass at all,
      // which is the truthful amount of attention it has earned.
      ctx.fillStyle = color
      ctx.globalAlpha = 0.14
      for (const run of runs) {
        const { segment } = run
        if (segment.end - segment.start < 2) continue
        ctx.beginPath()
        ctx.moveTo(x(segment.start), y(0))
        curvePath(run, x, column[segment.start]!, true)
        ctx.lineTo(x(segment.end - 1), y(0))
        ctx.closePath()
        ctx.fill()
      }
      ctx.globalAlpha = 1

      ctx.strokeStyle = color
      ctx.lineWidth = 1.5
      for (const run of runs) {
        const { segment } = run
        // One point on its own still deserves to be visible; a zero-length
        // stroke with a round cap draws the dot.
        ctx.beginPath()
        curvePath(run, x, column[segment.start]!)
        if (segment.end - segment.start === 1) {
          ctx.lineTo(x(segment.start), y(column[segment.start]!))
        }
        ctx.stroke()
      }
    })

    if (cursor !== null && cursor >= 0 && cursor < frame.points) {
      const cx = Math.round(x(cursor)) + 0.5
      ctx.strokeStyle = role('--fg-muted')
      ctx.lineWidth = 1
      ctx.beginPath()
      ctx.moveTo(cx, 0)
      ctx.lineTo(cx, h)
      ctx.stroke()

      traces.forEach((trace, t) => {
        const column = frame.columns[frame.names.indexOf(trace.name)]
        const v = column?.[cursor!]
        if (v === undefined || v === MISSING_SAMPLE) return
        ctx.fillStyle = colors[t] ?? TOKEN_MISSING
        ctx.beginPath()
        ctx.arc(x(cursor!), y(v), 3, 0, Math.PI * 2)
        ctx.fill()
      })
    }
  }

  $effect(() => {
    // Named so the effect re-runs when any of them move.
    void shapes
    void blanks
    void axis
    void ticks
    void cursor
    void width
    void height
    draw()
  })

  $effect(() => {
    const el = box
    if (!el) return

    const observer = new ResizeObserver((entries) => {
      const next = entries[0]?.contentRect.width
      if (next && Math.abs(next - width) >= 1) width = next
    })
    observer.observe(el)
    width = el.clientWidth || width

    return () => observer.disconnect()
  })

  function move(event: PointerEvent): void {
    if (!box) return
    const rect = box.getBoundingClientRect()
    // Against the same width the series was drawn against, so the sample the
    // readout names is the one under the finger.
    onCursor?.(indexAt(event.clientX - rect.left, plotW, frame.points))
  }
</script>

<!-- The chart is one picture to a screen reader. Its numbers are read from the
     readout beside it, which is DOM text and does not need describing twice. -->
<div
  class="chart"
  role="img"
  aria-label="{traces.map((t) => t.label).join(', ')} over the selected range"
  bind:this={box}
  style:height="{height}px"
  onpointermove={move}
  onpointerdown={move}
  onpointerleave={() => onCursor?.(null)}
>
  <canvas bind:this={canvas} aria-hidden="true"></canvas>
</div>

<style>
  .chart {
    position: relative;
    width: 100%;
    touch-action: pan-y;
  }

  canvas {
    display: block;
    width: 100%;
    height: 100%;
  }
</style>
