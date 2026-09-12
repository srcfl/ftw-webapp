<!--
  A live line, sliding right to left.

  The 1 Hz stream lands one reading a second; between them the leading edge
  eases from the last value to the new one, so the line moves like something
  alive rather than stepping once a second. The window is a couple of
  minutes wide, "now" is the right edge, and the vertical scale drifts toward
  what the data needs instead of snapping — a chart that rescaled on every
  new peak would look like the house lurched when only the axis did.

  It draws nothing it does not have: no reading, no line. And it holds still
  the moment it stops being fed, because a moving line is a claim that power
  is flowing at this very second, and that is the one thing the app never
  fakes.
-->
<script lang="ts">
  import { untrack } from 'svelte'

  interface Props {
    /** The current reading, in watts. Null when there is none. */
    value: number | null
    /** A monotonic stamp that changes only when a real frame arrived, so the
     *  line eases on news and freezes on silence. */
    tick: number
    /** Positive is into the site; the zero line is drawn when the data
     *  crosses it (grid, battery), hidden when it cannot (solar, load). */
    signed: boolean
    /** The line's colour, a design role resolved by the host. */
    color: string
    /** Whether the stream is live right now. A quiet stream stops moving. */
    live: boolean
    /** Recent (time, plot-value) samples to open already drawn, oldest first.
     *  Read once on mount; changes afterward arrive as `value`/`tick`. */
    seed?: { t: number; v: number }[]
  }

  let { value, tick, signed, color, live, seed = [] }: Props = $props()

  const WINDOW_MS = 120_000
  const EASE_MS = 600
  /** How fast the axis chases the data. Tracks without snapping. */
  const BOUNDS_SPEED = 0.08
  /** ~15 fps: a two-minute window has no pixel-level motion to show at 60. */
  const FRAME_MS = 66

  let canvas = $state<HTMLCanvasElement | null>(null)

  /** Reduced motion steps straight to each new reading: no easing, no axis
   *  drift. Read per use, so a mid-session OS change is honoured. */
  function motionReduced(): boolean {
    return window.matchMedia?.('(prefers-reduced-motion: reduce)').matches === true
  }

  // The rolling history and the eased leading edge live outside Svelte's
  // reactivity: they change every animation frame, and routing that through
  // signals would be a repaint a frame for nothing on screen to gain.
  let history: { t: number; v: number }[] = []
  let displayV = 0
  let prevV = 0
  let targetV = 0
  let transitionAt = 0
  let minY = -1
  let maxY = 1
  let raf = 0
  let lastPaint = 0
  let lastTick = -1
  let nowMs = 0

  // A frame arrived: commit the value the line is showing as a real point at
  // this instant so it does not jump, then ease toward the new reading.
  function onFrame(v: number, at: number): void {
    history.push({ t: at, v: displayV })
    prevV = displayV
    targetV = v
    transitionAt = at
    const cutoff = at - WINDOW_MS - 10_000
    while (history.length > 2 && history[0]!.t < cutoff) history.shift()
  }

  function eased(at: number): number {
    if (motionReduced()) return targetV
    const t = Math.min(1, (at - transitionAt) / EASE_MS)
    const e = 1 - Math.pow(1 - t, 3)
    return prevV + (targetV - prevV) * e
  }

  function bounds(): void {
    let lo = signed ? -1 : 0
    let hi = 1
    for (const p of history) {
      if (p.v < lo) lo = p.v
      if (p.v > hi) hi = p.v
    }
    if (displayV < lo) lo = displayV
    if (displayV > hi) hi = displayV
    const pad = (hi - lo) * 0.08
    lo -= pad
    hi += pad
    if (motionReduced()) {
      minY = lo
      maxY = hi
      return
    }
    minY += (lo - minY) * BOUNDS_SPEED
    maxY += (hi - maxY) * BOUNDS_SPEED
  }

  function draw(): void {
    const el = canvas
    if (!el) return
    const ctx = el.getContext('2d')
    if (!ctx) return

    const dpr = window.devicePixelRatio || 1
    const w = el.clientWidth
    const h = el.clientHeight
    if (el.width !== Math.round(w * dpr) || el.height !== Math.round(h * dpr)) {
      el.width = Math.round(w * dpr)
      el.height = Math.round(h * dpr)
    }
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
    ctx.clearRect(0, 0, w, h)

    if (history.length === 0 && value === null) return

    const now = nowMs
    const span = maxY - minY || 1
    const yOf = (v: number) => h - ((v - minY) / span) * h
    const xOf = (t: number) => w - ((now - t) / WINDOW_MS) * w

    const points = [...history, { t: now, v: displayV }].filter(
      (p) => p.t >= now - WINDOW_MS
    )
    if (points.length === 0) return

    // The line colour is resolved by the browser from the design role the
    // host set inline; the fill is that same colour, faint. Reading it off
    // the canvas means one source of truth for the hue.
    const styles = getComputedStyle(el)
    const line = styles.getPropertyValue('--live-line').trim() || color

    // The zero line, where the data can sit on both sides of it. The same
    // rule the borders read, so neither theme gets a hand-picked grey.
    if (signed && minY < 0 && maxY > 0) {
      ctx.strokeStyle = styles.getPropertyValue('--line').trim() || 'rgba(128,128,128,0.3)'
      ctx.lineWidth = 1
      ctx.beginPath()
      ctx.moveTo(0, yOf(0))
      ctx.lineTo(w, yOf(0))
      ctx.stroke()
    }

    // The soft body under the line, so a full-power moment reads as weight.
    ctx.beginPath()
    ctx.moveTo(xOf(points[0]!.t), yOf(points[0]!.v))
    for (const p of points) ctx.lineTo(xOf(p.t), yOf(p.v))
    const base = signed && minY < 0 && maxY > 0 ? yOf(0) : h
    ctx.lineTo(xOf(points[points.length - 1]!.t), base)
    ctx.lineTo(xOf(points[0]!.t), base)
    ctx.closePath()
    ctx.globalAlpha = 0.12
    ctx.fillStyle = line
    ctx.fill()
    ctx.globalAlpha = 1

    // The line itself.
    ctx.beginPath()
    ctx.moveTo(xOf(points[0]!.t), yOf(points[0]!.v))
    for (const p of points) ctx.lineTo(xOf(p.t), yOf(p.v))
    ctx.strokeStyle = line
    ctx.lineWidth = 2
    ctx.lineJoin = 'round'
    ctx.stroke()

    // The leading dot, the point of the whole thing: the reading, now.
    const lx = xOf(now)
    const ly = yOf(displayV)
    ctx.beginPath()
    ctx.arc(lx, ly, 3, 0, Math.PI * 2)
    ctx.fillStyle = line
    ctx.fill()
  }

  // One loop, only while the reading is live. A stale panel remains mounted
  // so it can say "last known", but its line and time axis must stop with the
  // data rather than spending frames moving an old reading across the screen.
  $effect(() => {
    const running = live
    if (!running) {
      untrack(() => {
        if (nowMs === 0) nowMs = Date.now()
        bounds()
        draw()
      })
      return
    }

    const loop = (ts: number) => {
      raf = requestAnimationFrame(loop)
      nowMs = Date.now()
      displayV = eased(nowMs)
      if (ts - lastPaint < FRAME_MS) return
      lastPaint = ts
      bounds()
      draw()
    }
    raf = requestAnimationFrame(loop)
    return () => cancelAnimationFrame(raf)
  })

  // Open already drawn: lay the recent samples down as history so the line
  // arrives with a couple of minutes behind it rather than a blank right
  // edge. Once only, on mount — everything after is a live frame.
  let seeded = false
  $effect(() => {
    if (seeded || seed.length === 0) return
    seeded = true
    for (const p of seed) history.push({ t: p.t, v: p.v })
    const last = seed[seed.length - 1]!
    displayV = last.v
    prevV = last.v
    targetV = last.v
    transitionAt = last.t
    let lo = signed ? -1 : 0
    let hi = 1
    for (const p of seed) {
      if (p.v < lo) lo = p.v
      if (p.v > hi) hi = p.v
    }
    minY = lo * 1.05
    maxY = hi * 1.05
    if (!live) {
      nowMs = Date.now()
      bounds()
      draw()
    }
  })

  // A real frame — value and a fresh tick — starts a new ease. Silence (the
  // tick unchanged) leaves the line exactly where it froze.
  $effect(() => {
    if (!live || value === null) return
    if (tick !== lastTick) {
      lastTick = tick
      if (history.length === 0) {
        displayV = value
        prevV = value
        targetV = value
        minY = signed ? Math.min(-1, value) * 1.05 : 0
        maxY = Math.max(1, value) * 1.05
      }
      onFrame(value, Date.now())
    }
  })
</script>

<canvas bind:this={canvas} style="--live-line: {color}"></canvas>

<style>
  canvas {
    display: block;
    width: 100%;
    height: 100%;
  }
</style>
