<!--
  The series, on a canvas.

  Canvas for the lines and DOM for everything around them. Two thousand points
  across four series is roughly eight thousand lineTo calls — under two
  milliseconds on a phone five years old, so there is no worker here and no
  need for one. The same points as SVG nodes would be eight thousand elements
  for the browser to lay out on every resize, which is where charts on phones
  actually go wrong.

  Two rules this component exists to keep:

  - A gap is drawn as a gap. The pen lifts wherever a sample is missing. See
    chart.ts, where the segment split lives and is tested.
  - The vertical axis does not jump. When a sharper series replaces a cached
    one the caller passes the domain it was already drawing, so the shape
    changes under a fixed axis instead of the whole chart rescaling.
-->
<script lang="ts">
  import { MISSING_SAMPLE } from '$lib/protocol/messages'
  import type { SeriesFrame } from '$lib/protocol/history'
  import { segmentsOf, domainOf, unionDomain, indexAt, type Domain, type Trace } from './chart'

  interface Props {
    frame: SeriesFrame
    traces: Trace[]
    /** Hold the axis at least this wide. Stops a rescale when data sharpens. */
    lockedDomain?: Domain | null
    /** Index under the pointer, owned by the caller so the readout can show it. */
    cursor?: number | null
    onCursor?: (index: number | null) => void
    height?: number
  }

  let {
    frame,
    traces,
    lockedDomain = null,
    cursor = null,
    onCursor,
    height = 220,
  }: Props = $props()

  let canvas = $state<HTMLCanvasElement | null>(null)
  let box = $state<HTMLDivElement | null>(null)
  let width = $state(320)

  const domain = $derived.by((): Domain => {
    const own = domainOf(frame.columns)
    return lockedDomain ? unionDomain(own, lockedDomain) : own
  })

  function draw(): void {
    const el = canvas
    if (!el || !box) return

    const ctx = el.getContext('2d')
    if (!ctx) return

    const dpr = Math.min(window.devicePixelRatio || 1, 2)
    const w = Math.max(1, width)
    const h = height

    if (el.width !== Math.round(w * dpr) || el.height !== Math.round(h * dpr)) {
      el.width = Math.round(w * dpr)
      el.height = Math.round(h * dpr)
    }

    ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
    ctx.clearRect(0, 0, w, h)

    const [min, max] = domain
    const span = max - min || 1
    const y = (v: number) => h - ((v - min) / span) * h
    const x = (i: number) => (frame.points <= 1 ? 0 : (i / (frame.points - 1)) * w)

    // Resolved once per paint. Components read design roles, never raw
    // values, and getComputedStyle inside the stroke loop is a stall.
    const style = getComputedStyle(box)
    const line = style.getPropertyValue('--line').trim() || '#2a2a2a'
    const colors = traces.map((t) => style.getPropertyValue(t.colorVar).trim() || '#888')

    // Zero is the line between drawing power and sending it back, so it is
    // the only rule on the chart drawn strongly enough to read as a boundary.
    if (min < 0 && max > 0) {
      ctx.strokeStyle = line
      ctx.lineWidth = 1
      ctx.beginPath()
      ctx.moveTo(0, Math.round(y(0)) + 0.5)
      ctx.lineTo(w, Math.round(y(0)) + 0.5)
      ctx.stroke()
    }

    ctx.lineJoin = 'round'
    ctx.lineCap = 'round'
    ctx.lineWidth = 1.5

    traces.forEach((trace, t) => {
      const column = frame.columns[frame.names.indexOf(trace.name)]
      if (!column) return

      ctx.strokeStyle = colors[t] ?? '#888'

      for (const segment of segmentsOf(column)) {
        // One point on its own still deserves to be visible; a zero-length
        // stroke with a round cap draws the dot.
        ctx.beginPath()
        ctx.moveTo(x(segment.start), y(column[segment.start]!))
        for (let i = segment.start + 1; i < segment.end; i++) {
          ctx.lineTo(x(i), y(column[i]!))
        }
        if (segment.end - segment.start === 1) ctx.lineTo(x(segment.start), y(column[segment.start]!))
        ctx.stroke()
      }
    })

    if (cursor !== null && cursor >= 0 && cursor < frame.points) {
      const cx = Math.round(x(cursor)) + 0.5
      ctx.strokeStyle = style.getPropertyValue('--fg-muted').trim() || '#858585'
      ctx.lineWidth = 1
      ctx.beginPath()
      ctx.moveTo(cx, 0)
      ctx.lineTo(cx, h)
      ctx.stroke()

      traces.forEach((trace, t) => {
        const column = frame.columns[frame.names.indexOf(trace.name)]
        const v = column?.[cursor!]
        if (v === undefined || v === MISSING_SAMPLE) return
        ctx.fillStyle = colors[t] ?? '#888'
        ctx.beginPath()
        ctx.arc(x(cursor!), y(v), 3, 0, Math.PI * 2)
        ctx.fill()
      })
    }
  }

  $effect(() => {
    // Named so the effect re-runs when any of them move.
    void frame
    void domain
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
    onCursor?.(indexAt(event.clientX - rect.left, rect.width, frame.points))
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
