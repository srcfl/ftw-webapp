<!--
  The home and what flows through it, as the iOS app draws Now (Ring /
  Quiet, chosen by Fredrik on 24 October 2026): the home's use in the middle
  of a ring, each other node as text on the ground in its corner, and the
  quarter of the ring that faces it lit from its middle out, longer with
  more power. Steady flow (J, chosen on 30 October 2026): the arc is
  brightest over its middle third, each reading from the box sends one swell
  along it, and thin lines of light run all the time between the arc and the
  home's circle, in toward the home for power coming into it and out for
  power leaving it. In the dark the arcs and lines glow in two blurred
  passes for the whole ring.

  Light means live. Only a reading the box confirms live glows or moves; a
  cached or quiet arc is a faint still arc in ink, and a node at rest shows
  only its quarter's track. The loop runs only while an arc is live and
  flowing, or for a moment after a change so an arc can grow or cool, and
  only while this view is on screen. Under reduced motion nothing runs or
  swells, and a still chevron on the way to the home says which way it flows.
-->
<script lang="ts">
  import { onMount, untrack } from 'svelte'
  import type { ControlScope } from '$vendor/ftw/control-feedback.js'
  import { formatPower } from '$lib/format/power'
  import {
    NODE_TITLE, doing, flowHeight, flowing, labelHeight, nodeWidth, onAxis, quantised, quantisedHolding,
    ringArc, ringFill, ringGeometry, ringSpot, type RingNode, type RingReading, type RingSpot,
  } from '$lib/state/ring'
  import { ArcMotion, alpha, ringEase, ringLines, ringStrength, ringSwell, type ArcTarget } from '$lib/state/ring-motion'

  interface Props {
    readings: RingReading[]
    /** Whether this view is the one on screen. Hidden, nothing draws. */
    active?: boolean
    /** When the newest reading from the box came, in ms. Each new one sends
     *  a swell along the live arcs. */
    readingAt?: number | null
    /** A tap on a node, with the scope the box's own hero would send. */
    onopen?: (scope: ControlScope) => void
  }

  let { readings, active = true, readingAt = null, onopen }: Props = $props()

  let width = $state(0)
  // jsdom and a first frame before layout have no width; draw a phone's.
  const w = $derived(width > 0 ? width : 360)
  const nodes = $derived(readings.map((r) => r.node))
  const axis = $derived(nodes.some((n) => onAxis(ringSpot(n, nodes))))
  const height = $derived(flowHeight(w, axis))
  const labelW = $derived(nodeWidth(w))
  const ring = $derived(ringGeometry(w, height, labelHeight(), labelW, axis))
  const corners = $derived(
    readings.filter((r) => r.node !== 'home').map((r) => ({ r, spot: ringSpot(r.node, nodes) }))
  )
  const home = $derived(readings.find((r) => r.node === 'home'))
  const anyLive = $derived(readings.some((r) => r.live))

  // ---------- figures ----------

  /** The figure on screen per node, held on a rounding edge. Not state: it
   *  only remembers what was last shown. */
  const held = new Map<RingNode, number>()
  function figure(r: RingReading) {
    if (r.watts == null) {
      held.delete(r.node)
      return null
    }
    const shown = quantisedHolding(r.watts, held.get(r.node))
    held.set(r.node, shown)
    return formatPower(shown)
  }

  function spoken(r: RingReading): string {
    const parts = [NODE_TITLE[r.node]]
    if (r.watts != null) {
      const f = formatPower(quantised(r.watts))
      parts.push(`${f.text} ${f.unit}`)
    }
    parts.push(r.word)
    if (r.levelPct != null) parts.push(`${Math.round(r.levelPct)}%`)
    parts.push(r.live ? 'live' : 'not live')
    if (r.mark) parts.push(r.mark.label)
    return parts.join(', ')
  }

  function open(r: RingReading) {
    if (r.scope) onopen?.(r.scope)
  }

  // ---------- the ring ----------

  interface Arc {
    node: RingNode
    spot: RingSpot
    color: string
    target: ArcTarget
  }

  const arcs = $derived<Arc[]>(
    corners.map(({ r, spot }) => {
      // The figure as drawn, so a 1 W wobble is the same drawing.
      const kw = (r.watts !== null && Number.isFinite(r.watts) ? quantised(r.watts) : 0) / 1000
      return {
        node: r.node,
        spot,
        color: r.color,
        target: { kw, live: r.live, flowing: flowing(r), towardHome: r.towardHome, fill: ringFill(kw) },
      }
    })
  )
  const drawn = $derived(JSON.stringify(arcs))

  let root = $state<HTMLDivElement | undefined>()
  let canvas = $state<HTMLCanvasElement | undefined>()
  // The glow in two passes for the whole ring, each blurred once.
  let halo = $state<HTMLCanvasElement | undefined>()
  let near = $state<HTMLCanvasElement | undefined>()
  const motions = new Map<RingNode, ArcMotion>()
  let frameId = 0
  let settleUntil = 0
  let reduceMotion = false
  let reduceTransparency = false
  let pageVisible = true
  let onScreen = true

  /** Long enough for an arc to grow (τ 0.4 s) and a glow to cool. */
  const SETTLE_MS = 2_400

  type RGBA = [number, number, number, number]
  let ink: RGBA = [238, 243, 255, 1]
  let ink2: RGBA = [154, 165, 184, 1]
  let dark = true
  const colors = new Map<string, RGBA>()

  /** One small canvas to read colours with, made once. */
  let probe: CanvasRenderingContext2D | null | undefined

  /** A colour as numbers, for a canvas that cannot read tokens. */
  function parse(css: string, fallback: RGBA): RGBA {
    if (!canvas) return fallback
    const style = getComputedStyle(canvas)
    const value = css.replace(/var\((--[\w-]+)\)/g, (_, name: string) => style.getPropertyValue(name).trim())
    probe ??= document.createElement('canvas').getContext('2d')
    if (!probe || !value) return fallback
    // A value the canvas cannot read leaves the one before it in place.
    const unset = '#010203'
    probe.fillStyle = unset
    probe.fillStyle = value
    const out = String(probe.fillStyle)
    if (out === unset) return fallback
    const hex = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(out)
    if (hex) {
      const [, r = '0', g = '0', b = '0'] = hex
      return [parseInt(r, 16), parseInt(g, 16), parseInt(b, 16), 1]
    }
    const rgb = /rgba?\(([\d.]+),\s*([\d.]+),\s*([\d.]+)(?:,\s*([\d.]+))?\)/.exec(out)
    if (rgb) {
      const [, r = '0', g = '0', b = '0', a = '1'] = rgb
      return [+r, +g, +b, +a]
    }
    return fallback
  }

  /** The theme's ink and ground, read again when the theme changes. */
  function resolveTheme() {
    ink = parse('var(--fg)', ink)
    ink2 = parse('var(--fg-dim)', ink2)
    const ground = parse('var(--surface)', [5, 8, 15, 1])
    dark = 0.2126 * ground[0] + 0.7152 * ground[1] + 0.0722 * ground[2] < 128
    colors.clear()
  }

  /** An arc's colour, read once per theme. */
  function hueOf(css: string): RGBA {
    let c = colors.get(css)
    if (!c) colors.set(css, (c = parse(css, ink)))
    return c
  }

  const rgba = (c: RGBA, opacity = 1) => `rgba(${c[0]}, ${c[1]}, ${c[2]}, ${Math.max(0, Math.min(1, c[3] * opacity))})`
  function mix(a: RGBA, b: RGBA, k: number): RGBA {
    const t = Math.min(1, Math.max(0, k))
    return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t, a[3] + (b[3] - a[3]) * t]
  }

  const rad = (deg: number) => (deg * Math.PI) / 180

  function running(now: number): boolean {
    if (!active || !pageVisible || !onScreen || reduceMotion) return false
    return now < settleUntil || arcs.some((a) => a.target.live && a.target.flowing)
  }

  /** Draw now, and keep drawing while something moves. */
  function kick() {
    if (!active || frameId || typeof requestAnimationFrame !== 'function') return
    frameId = requestAnimationFrame(tick)
  }

  function tick() {
    frameId = 0
    if (!active) return
    const now = performance.now()
    const moving = running(now)
    draw(now / 1000, moving)
    if (moving) frameId = requestAnimationFrame(tick)
  }

  /** A canvas sized to the ring and cleared, or null. */
  function layer(c: HTMLCanvasElement | undefined, dpr: number): CanvasRenderingContext2D | null {
    const ctx = c?.getContext('2d')
    if (!c || !ctx) return null
    const pw = Math.round(w * dpr)
    const ph = Math.round(height * dpr)
    if (c.width !== pw || c.height !== ph) {
      c.width = pw
      c.height = ph
    }
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
    ctx.clearRect(0, 0, w, height)
    ctx.lineCap = 'round'
    return ctx
  }

  function draw(t: number, animating: boolean) {
    const dpr = window.devicePixelRatio || 1
    const ctx = layer(canvas, dpr)
    if (!ctx) return
    const glows = dark && !reduceTransparency
    const haloCtx = layer(halo, dpr)
    const nearCtx = layer(near, dpr)
    const g = ring
    const th = g.thickness
    const r = g.radius

    // Each node's quarter, the track its arc lights.
    ctx.lineWidth = th
    ctx.strokeStyle = rgba(ink, dark ? 0.13 : 0.09)
    for (const a of arcs) {
      const [lo, hi] = ringArc(a.spot, 1).track
      ctx.beginPath()
      ctx.arc(g.cx, g.cy, r, rad(lo), rad(hi), false)
      ctx.stroke()
    }

    // The way between the arcs and the home's circle, where the lines run.
    const outer = r - th / 2 - 4
    const inner = g.hub / 2 + 4
    const reading = untrack(() => readingAt)
    for (const a of arcs) {
      let m = motions.get(a.node)
      if (!m) motions.set(a.node, (m = new ArcMotion(a.target, t, reading)))
      const f = m.step(a.target, t, reduceMotion, reading, animating)
      const k = 1 - f.idle
      const lit = ringArc(a.spot, f.fill).lit
      if (k <= 0.01 || !lit) continue
      const light = Math.min(1, f.light)
      // Light means live: the arc's colour while the box confirms it, ink
      // once it does not, crossing over as the phosphor ignites or cools.
      const color = mix(ink2, hueOf(a.color), light)
      const strength = ringStrength(a.target.kw)
      const half = (((lit[1] - lit[0]) / 2) * r * Math.PI) / 180
      const swell = (s: number) => (f.swell === null ? 0 : ringSwell(s, f.swell, half))
      // A live arc leaves the swell the room it needs.
      const base = 1 - (reduceMotion ? 0.1 : 0.3) * light
      const end = dark ? 0.14 : 0.32
      soft(ctx, lit, r, th, color, (u, s) => alpha(f) * k * ringEase(u, end) * (base + (1 - base) * swell(s)))
      if (glows && light > 0.004) {
        const g0 = light * k
        if (haloCtx) soft(haloCtx, lit, r, th * 1.6, color, (u, s) => 0.9 * g0 * ringEase(u, 0) * (0.5 + 0.6 * strength * swell(s)))
        if (nearCtx) soft(nearCtx, lit, r, th * 1.1, color, (u, s) => 0.65 * g0 * ringEase(u, 0) * (0.5 + 0.6 * strength * swell(s)))
      }
      const mid = (lit[0] + lit[1]) / 2
      if (reduceMotion) {
        if (a.target.flowing) chevron(ctx, mid, (outer + inner) / 2, a.target.towardHome, alpha(f) * k)
        continue
      }
      // The lines keep their angle, so they narrow as they near the home and
      // widen as they leave it, and fade in and out at the ends of the way.
      if (light <= 0.004) continue
      const spread = Math.max(8, (lit[1] - lit[0]) / 2)
      for (const toHome of ringLines(f.phase, outer - inner, a.target.towardHome)) {
        const rr = outer + (inner - outer) * toHome
        const hs = spread * (1 - 0.4 * toHome)
        const line = (dark ? 0.6 : 0.55) * strength * Math.pow(Math.sin(Math.PI * toHome), 1.2) * light * k
        const range: [number, number] = [mid - hs, mid + hs]
        soft(ctx, range, rr, th * 0.4, color, (u) => (dark ? 1 : 0.85) * line * ringEase(u, 0))
        if (glows && nearCtx) soft(nearCtx, range, rr, th * 0.8, color, (u) => 0.75 * line * ringEase(u, 0))
      }
    }
  }

  /**
   * A soft arc at `radius` over `range`: `color` at `strength(u, s)` along
   * it, `u` from -1 at its first angle to 1 at its last and `s` px from its
   * middle, on a conic gradient that starts half the stroke's width before
   * the arc, so each round cap takes the colour of the end it closes. Stops
   * sit 6 px apart, close enough for light this soft.
   */
  function soft(ctx: CanvasRenderingContext2D, range: [number, number], radius: number, width: number, color: RGBA, strength: (u: number, s: number) => number) {
    const [lo, hi] = range
    const span = hi - lo
    if (span <= 0.2) return
    const perDegree = (radius * Math.PI) / 180
    const lead = width / 2 / perDegree
    const at = (deg: number) => rgba(color, strength(span > 0 ? (deg / span) * 2 - 1 : 0, Math.abs(deg - span / 2) * perDegree))
    ctx.lineWidth = width
    if (typeof ctx.createConicGradient === 'function') {
      const grad = ctx.createConicGradient(rad(lo - lead), ring.cx, ring.cy)
      grad.addColorStop(0, at(0))
      const step = Math.max(0.5, Math.min(span / 8, 6 / perDegree))
      for (let d = 0; d < span; d += step) grad.addColorStop((d + lead) / 360, at(d))
      grad.addColorStop(Math.min(1, (span + lead) / 360), at(span))
      grad.addColorStop(1, at(span))
      ctx.strokeStyle = grad
    } else {
      ctx.strokeStyle = at(span / 2)
    }
    ctx.beginPath()
    ctx.arc(ring.cx, ring.cy, radius, rad(lo), rad(hi), false)
    ctx.stroke()
  }

  /** A still chevron on the way between an arc and the home, at the arc's
   *  middle, pointing the way the lines would run, in ink. */
  function chevron(ctx: CanvasRenderingContext2D, angle: number, radius: number, inward: boolean, opacity: number) {
    const g = ring
    const a = rad(angle)
    const cx = g.cx + radius * Math.cos(a)
    const cy = g.cy + radius * Math.sin(a)
    const dir = inward ? -1 : 1
    const ux = Math.cos(a) * dir
    const uy = Math.sin(a) * dir
    const size = Math.max(6, g.thickness * 0.6 + 3)
    ctx.save()
    ctx.lineWidth = 1.75
    ctx.lineJoin = 'round'
    ctx.strokeStyle = rgba(ink, opacity)
    ctx.beginPath()
    ctx.moveTo(cx - ux * size - uy * size, cy - uy * size + ux * size)
    ctx.lineTo(cx + ux * size * 0.6, cy + uy * size * 0.6)
    ctx.lineTo(cx - ux * size + uy * size, cy - uy * size - ux * size)
    ctx.stroke()
    ctx.restore()
  }

  // A change to what is drawn, or to the room, plays for a moment. Kept by
  // value: a prop can signal with nothing changed, and a 1 Hz tick that
  // changes nothing must draw nothing.
  let played = ''
  $effect(() => {
    const key = `${drawn}|${w}|${height}`
    if (!active || !canvas) {
      played = ''
      return
    }
    if (key === played) return
    played = key
    untrack(() => {
      settleUntil = performance.now() + SETTLE_MS
      kick()
    })
  })

  onMount(() => {
    const media = (q: string) => (typeof matchMedia === 'function' ? matchMedia(q) : null)
    const motion = media('(prefers-reduced-motion: reduce)')
    const transparency = media('(prefers-reduced-transparency: reduce)')
    const scheme = media('(prefers-color-scheme: dark)')
    const sync = () => {
      reduceMotion = motion?.matches ?? false
      reduceTransparency = transparency?.matches ?? false
      pageVisible = document.visibilityState !== 'hidden'
      resolveTheme()
      kick()
    }
    sync()
    for (const m of [motion, transparency, scheme]) m?.addEventListener('change', sync)
    document.addEventListener('visibilitychange', sync)
    // The theme switch writes data-theme on <html>.
    const theme = typeof MutationObserver === 'function' ? new MutationObserver(sync) : null
    theme?.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] })
    const seen = typeof IntersectionObserver === 'function' && canvas
      ? new IntersectionObserver(([e]) => {
          onScreen = e?.isIntersecting ?? true
          kick()
        })
      : null
    if (canvas) seen?.observe(canvas)
    // Guarded rather than bound: a test's DOM has no ResizeObserver.
    const size = typeof ResizeObserver === 'function'
      ? new ResizeObserver(([e]) => {
          // Hidden, the view measures 0; keep the width it had.
          if (e && e.contentRect.width > 0) width = e.contentRect.width
        })
      : null
    if (root) {
      if (root.clientWidth > 0) width = root.clientWidth
      size?.observe(root)
    }
    return () => {
      size?.disconnect()
      for (const m of [motion, transparency, scheme]) m?.removeEventListener('change', sync)
      document.removeEventListener('visibilitychange', sync)
      theme?.disconnect()
      seen?.disconnect()
      if (frameId) cancelAnimationFrame(frameId)
      frameId = 0
    }
  })

  const ALIGN: Record<RingSpot, string> = {
    topLeading: 'top: 0; left: 0; text-align: left; align-items: flex-start',
    topTrailing: 'top: 0; right: 0; text-align: right; align-items: flex-end',
    bottomLeading: 'bottom: 0; left: 0; text-align: left; align-items: flex-start',
    bottomTrailing: 'bottom: 0; right: 0; text-align: right; align-items: flex-end',
    top: 'top: 0; left: 50%; transform: translateX(-50%); text-align: center; align-items: center',
    bottom: 'bottom: 0; left: 50%; transform: translateX(-50%); text-align: center; align-items: center',
    center: '',
  }
  const trailing = (s: RingSpot) => s === 'topTrailing' || s === 'bottomTrailing'

  const batteryStep = (pct: number | null) => {
    const p = pct ?? 50
    return p >= 88 ? 4 : p >= 63 ? 3 : p >= 38 ? 2 : p >= 13 ? 1 : 0
  }
</script>

{#snippet symbol(r: RingReading)}
  <svg class="symbol" viewBox="0 0 16 16" aria-hidden="true">
    {#if r.node === 'solar'}
      <circle cx="8" cy="8" r="3.2" fill="currentColor" />
      <g stroke="currentColor" stroke-width="1.5" stroke-linecap="round">
        <path d="M8 1.2v1.6M8 13.2v1.6M1.2 8h1.6M13.2 8h1.6M3.2 3.2l1.1 1.1M11.7 11.7l1.1 1.1M3.2 12.8l1.1-1.1M11.7 4.3l1.1-1.1" />
      </g>
    {:else if r.node === 'battery'}
      <rect x="1" y="4.5" width="12" height="7" rx="2" fill="none" stroke="currentColor" stroke-width="1.3" />
      <rect x="13.6" y="6.6" width="1.4" height="2.8" rx="0.6" fill="currentColor" />
      {#if batteryStep(r.levelPct) > 0}
        <rect x="2.6" y="6.1" width={8.8 * batteryStep(r.levelPct) / 4} height="3.8" rx="0.8" fill="currentColor" />
      {/if}
    {:else if r.node === 'grid'}
      <path d="M9.2 1 3.5 9h4l-1 6 5.9-8.2H8.3z" fill="currentColor" />
    {:else if r.node === 'car'}
      <path d="M2.6 8.2 4 4.9c.3-.7.9-1.1 1.6-1.1h4.8c.7 0 1.3.4 1.6 1.1l1.4 3.3c.6.3 1 .9 1 1.6v2.1c0 .4-.3.7-.7.7H14v.9c0 .5-.4.9-.9.9h-.6c-.5 0-.9-.4-.9-.9v-.9H4.4v.9c0 .5-.4.9-.9.9h-.6c-.5 0-.9-.4-.9-.9v-.9h-.3c-.4 0-.7-.3-.7-.7V9.8c0-.7.4-1.3 1-1.6zm1.6-.4h7.6l-1-2.4c-.1-.2-.3-.3-.5-.3H5.7c-.2 0-.4.1-.5.3zM4.4 11a1 1 0 1 0 0-2 1 1 0 0 0 0 2zm7.2 0a1 1 0 1 0 0-2 1 1 0 0 0 0 2z" fill="currentColor" />
    {/if}
  </svg>
{/snippet}

{#snippet mark(r: RingReading)}
  {#if r.mark}
    <svg class="mark" viewBox="-12 -12 24 24" data-tone={r.mark.tone} aria-hidden="true">
      <title>{r.mark.label}</title>
      {#if r.mark.tone === 'alarm'}
        <circle r="9" fill="var(--alarm)" />
        <path d="M0 -4.5 V1.2 M0 4.2 V4.4" stroke="var(--surface)" stroke-width="2.2" stroke-linecap="round" />
      {:else}
        <path d="M0 -9 L9.5 7.5 H-9.5 Z" fill="var(--alarm)" stroke-linejoin="round" />
        <path d="M0 -3.2 V1.8 M0 4.6 V4.8" stroke="var(--surface)" stroke-width="2" stroke-linecap="round" />
      {/if}
    </svg>
  {/if}
{/snippet}

{#snippet label(r: RingReading, spot: RingSpot)}
  {@const f = figure(r)}
  <span class="name" style:color={r.live ? r.color : 'var(--fg-dim)'}>
    {#if !trailing(spot)}{@render symbol(r)}{/if}
    <span>{NODE_TITLE[r.node]}</span>
    {#if trailing(spot)}{@render symbol(r)}{/if}
    {@render mark(r)}
  </span>
  <span class="figure" class:quiet={r.watts == null || !r.live}>
    {#if f}{f.text}{' '}<span class="unit">{f.unit}</span>{:else}—{/if}
  </span>
  <span class="word" class:quiet={!r.live}>{doing(r)}</span>
  <span class="lock" aria-hidden="true"></span>
{/snippet}

<div
  class="ring"
  bind:this={root}
  style:height="{height}px"
  style:--scale={ring.labelScale}
  style:--halo="{ring.thickness * 1.3}px"
  style:--near="{ring.thickness * 0.5}px"
  data-live={anyLive}
>
  <canvas class="halo" bind:this={halo} style:width="{w}px" style:height="{height}px" aria-hidden="true"></canvas>
  <canvas class="near" bind:this={near} style:width="{w}px" style:height="{height}px" aria-hidden="true"></canvas>
  <canvas bind:this={canvas} style:width="{w}px" style:height="{height}px" aria-hidden="true"></canvas>

  <div class="box" style:top="{ring.cy - ring.box / 2}px" style:height="{ring.box}px">
    {#each corners as { r, spot } (r.node)}
      {#if r.scope}
        <button
          type="button"
          class="node"
          data-node={r.node}
          style="{ALIGN[spot]}; width: {labelW}px"
          aria-label={spoken(r)}
          onclick={() => open(r)}
        >
          {@render label(r, spot)}
        </button>
      {:else}
        <div class="node" data-node={r.node} style="{ALIGN[spot]}; width: {labelW}px" role="group" aria-label={spoken(r)}>
          {@render label(r, spot)}
        </div>
      {/if}
    {/each}
  </div>

  {#if home}
    {@const f = figure(home)}
    <button
      type="button"
      class="hub"
      data-node="home"
      style:left="{ring.cx - ring.hub / 2}px"
      style:top="{ring.cy - ring.hub / 2}px"
      style:width="{ring.hub}px"
      style:height="{ring.hub}px"
      style:--figure="{Math.min(44, ring.hub * 0.38)}px"
      style:--word="{Math.min(13, ring.hub * 0.12)}px"
      aria-label={spoken(home)}
      onclick={() => open(home)}
    >
      {#if ring.hub >= 110}
        <svg class="house" viewBox="0 0 16 16" aria-hidden="true">
          <path d="M8 1.6 1.3 7.3c-.4.3-.1.9.4.9H3v5.6c0 .4.3.7.7.7h2.8V10.4h3v4.1h2.8c.4 0 .7-.3.7-.7V8.2h1.3c.5 0 .8-.6.4-.9z" fill="currentColor" />
        </svg>
      {/if}
      <span class="hub-figure" class:quiet={home.watts == null || !home.live}>{f ? f.text : '—'}</span>
      <span class="hub-unit">{f ? f.unit : 'W'}</span>
      <span class="hub-name">{NODE_TITLE.home}</span>
      <span class="lock" aria-hidden="true"></span>
    </button>
  {/if}
</div>

<style>
  .ring {
    position: relative;
    width: 100%;
    --scale: 1;
  }

  canvas {
    position: absolute;
    inset: 0;
    pointer-events: none;
  }

  .halo {
    filter: blur(var(--halo));
    mix-blend-mode: plus-lighter;
  }

  .near {
    filter: blur(var(--near));
    mix-blend-mode: plus-lighter;
  }

  .box {
    position: absolute;
    left: 0;
    right: 0;
  }

  /* Text on the ground: no box, three fixed rows, so nothing moves when a
     word or a level arrives. */
  .node {
    position: absolute;
    display: flex;
    flex-direction: column;
    gap: 1px;
    padding: 0;
    background: none;
    border: 0;
    color: var(--fg);
    font: inherit;
    cursor: pointer;
    -webkit-tap-highlight-color: transparent;
  }

  div.node {
    cursor: default;
  }

  .name {
    display: inline-flex;
    align-items: center;
    gap: 5px;
    font-size: calc(15px * var(--scale));
    font-weight: 600;
    line-height: 1.3;
    white-space: nowrap;
  }

  .symbol {
    width: 1em;
    height: 1em;
    flex: none;
  }

  .mark {
    width: 1em;
    height: 1em;
    flex: none;
  }

  .figure {
    font-size: calc(30px * var(--scale));
    font-weight: 500;
    line-height: 1.2;
    letter-spacing: -0.02em;
    font-variant-numeric: tabular-nums;
    white-space: nowrap;
    color: var(--fg);
  }

  .figure.quiet {
    color: var(--fg-dim);
  }

  .unit {
    font-size: calc(15px * var(--scale));
    font-weight: 500;
    letter-spacing: 0;
    color: var(--fg-dim);
  }

  .word {
    font-size: calc(14px * var(--scale));
    line-height: 1.3;
    color: var(--fg-dim);
    font-variant-numeric: tabular-nums;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
    max-width: 100%;
  }

  .word.quiet {
    color: var(--fg-muted);
  }

  /* The home in the middle of the ring, everything it uses right now,
     inside a thin circle of ink. */
  .hub {
    position: absolute;
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    padding: 0 10px;
    border-radius: 50%;
    border: 1px solid color-mix(in srgb, var(--fg) 16%, transparent);
    background: none;
    color: var(--fg);
    font: inherit;
    cursor: pointer;
    -webkit-tap-highlight-color: transparent;
  }

  .house {
    width: calc(var(--word) + 3px);
    height: calc(var(--word) + 3px);
    color: var(--fg-dim);
    margin-bottom: 2px;
  }

  .hub-figure {
    font-size: var(--figure);
    font-weight: 500;
    line-height: 1.05;
    letter-spacing: -1px;
    font-variant-numeric: tabular-nums;
    white-space: nowrap;
  }

  .hub-figure.quiet {
    color: var(--fg-dim);
  }

  .hub-unit {
    font-size: var(--word);
    font-weight: 500;
    color: var(--fg-dim);
  }

  .hub-name {
    font-size: var(--word);
    color: var(--fg-dim);
  }

  /* The lock-on: four 7 px corner brackets close on what is pressed, from
     1.15× to its size. Also the keyboard's focus mark. */
  .lock {
    position: absolute;
    inset: -6px;
    pointer-events: none;
    opacity: 0;
    transform: scale(1.15);
    transition: opacity var(--motion-base) var(--ease), transform var(--motion-base) var(--ease);
    --c: var(--fg);
    background:
      linear-gradient(var(--c), var(--c)) top left / 7px 1px no-repeat,
      linear-gradient(var(--c), var(--c)) top left / 1px 7px no-repeat,
      linear-gradient(var(--c), var(--c)) top right / 7px 1px no-repeat,
      linear-gradient(var(--c), var(--c)) top right / 1px 7px no-repeat,
      linear-gradient(var(--c), var(--c)) bottom left / 7px 1px no-repeat,
      linear-gradient(var(--c), var(--c)) bottom left / 1px 7px no-repeat,
      linear-gradient(var(--c), var(--c)) bottom right / 7px 1px no-repeat,
      linear-gradient(var(--c), var(--c)) bottom right / 1px 7px no-repeat;
  }

  .hub .lock {
    inset: 8%;
  }

  button:active .lock,
  button:focus-visible .lock {
    opacity: 1;
    transform: scale(1);
  }

  button:focus-visible {
    outline: none;
  }

  @media (prefers-reduced-motion: reduce) {
    .lock {
      transition: none;
    }
  }
</style>
