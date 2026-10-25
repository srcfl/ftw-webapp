<!--
  The home and what flows through it, as the iOS app draws Now (Ring /
  Quiet, chosen by Fredrik on 24 October 2026): the home's use in the middle
  of a ring, each other node as text on the ground in its corner, and the
  quarter of the ring that faces it lit from its middle out, longer with
  more power. A soft wave of light runs along a lit arc, clockwise for power
  coming into the home and the other way for power leaving it.

  Light means live. Only a reading the box confirms live glows or moves; a
  cached or quiet arc is a faint still arc in ink, and a node at rest shows
  only its quarter's track. The loop runs only while an arc is live and
  flowing, or for a moment after a change so an arc can grow or cool, and
  only while this view is on screen. Under reduced motion the light holds
  still and a chevron on the arc says which way it flows.
-->
<script lang="ts">
  import { onMount, untrack } from 'svelte'
  import type { ControlScope } from '$vendor/ftw/control-feedback.js'
  import { formatPower } from '$lib/format/power'
  import {
    NODE_TITLE, doing, flowHeight, flowing, labelHeight, nodeWidth, onAxis, quantisedHolding,
    ringArc, ringFill, ringGeometry, ringSpot, type RingNode, type RingReading, type RingSpot,
  } from '$lib/state/ring'
  import { ArcMotion, WAVELENGTH, alpha, depth, wave, type ArcFrame, type ArcTarget } from '$lib/state/ring-motion'

  interface Props {
    readings: RingReading[]
    /** Whether this view is the one on screen. Hidden, nothing draws. */
    active?: boolean
    /** A tap on a node, with the scope the box's own hero would send. */
    onopen?: (scope: ControlScope) => void
  }

  let { readings, active = true, onopen }: Props = $props()

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
      const f = formatPower(r.watts)
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
      const kw = (r.watts ?? 0) / 1000
      return {
        node: r.node,
        spot,
        color: r.color,
        target: { kw, live: r.live, flowing: flowing(r), towardHome: r.towardHome, fill: ringFill(kw) },
      }
    })
  )
  // A tick with the same readings is the same drawing.
  const drawn = $derived(JSON.stringify(arcs))

  let root = $state<HTMLDivElement | undefined>()
  let canvas = $state<HTMLCanvasElement | undefined>()
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

  /** The page's colours as numbers, for a canvas that cannot read tokens. */
  function resolveColors() {
    if (!canvas) return
    const style = getComputedStyle(canvas)
    const probe = document.createElement('canvas').getContext('2d')
    const parse = (css: string, fallback: RGBA): RGBA => {
      const value = css.replace(/var\((--[\w-]+)\)/g, (_, name: string) => style.getPropertyValue(name).trim())
      if (!probe || !value) return fallback
      probe.fillStyle = '#000'
      probe.fillStyle = value
      const out = String(probe.fillStyle)
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
    ink = parse('var(--fg)', ink)
    ink2 = parse('var(--fg-dim)', ink2)
    const ground = parse('var(--surface)', [5, 8, 15, 1])
    dark = 0.2126 * ground[0] + 0.7152 * ground[1] + 0.0722 * ground[2] < 128
    colors.clear()
    for (const a of arcs) colors.set(a.color, parse(a.color, ink))
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
    draw(now / 1000)
    if (running(now)) frameId = requestAnimationFrame(tick)
  }

  function draw(t: number) {
    const ctx = canvas?.getContext('2d')
    if (!canvas || !ctx) return
    const g = ring
    const dpr = window.devicePixelRatio || 1
    const pw = Math.round(w * dpr)
    const ph = Math.round(height * dpr)
    if (canvas.width !== pw || canvas.height !== ph) {
      canvas.width = pw
      canvas.height = ph
    }
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
    ctx.clearRect(0, 0, w, height)
    ctx.lineCap = 'round'
    ctx.lineWidth = g.thickness

    const path = (range: [number, number]) => {
      ctx.beginPath()
      ctx.arc(g.cx, g.cy, g.radius, rad(range[0]), rad(range[1]), false)
    }

    // Each node's quarter, the track its arc lights.
    ctx.strokeStyle = rgba(ink, dark ? 0.13 : 0.09)
    for (const a of arcs) {
      path(ringArc(a.spot, 1).track)
      ctx.stroke()
    }

    const glows = dark && !reduceTransparency
    const cap = ((g.thickness / 2 / g.radius) * 180) / Math.PI
    for (const a of arcs) {
      let m = motions.get(a.node)
      if (!m) motions.set(a.node, (m = new ArcMotion(a.target, t)))
      const f = m.step(a.target, t, reduceMotion)
      const k = 1 - f.idle
      const lit = ringArc(a.spot, f.fill).lit
      if (k <= 0.01 || !lit) continue
      const hue = colors.get(a.color) ?? ink
      if (glows && f.light > 0.004) {
        for (const [wide, strength] of [[2.8, 0.12], [1.8, 0.25]] as const) {
          ctx.lineWidth = g.thickness * wide
          ctx.strokeStyle = rgba(hue, strength * f.light * k)
          path(lit)
          ctx.stroke()
        }
        ctx.lineWidth = g.thickness
      }
      // Light means live: the arc's colour while the box confirms it, ink
      // once it does not, crossing over as the phosphor ignites or cools.
      const color = mix(ink2, hue, f.light)
      // With no glow, full-strength colour says live alone: the wave runs
      // shallower and the arc keeps its colour between crests.
      ctx.strokeStyle = gradient(ctx, lit, a.target.towardHome, f, color, k, cap, glows ? 1 : 0.35)
      path(lit)
      ctx.stroke()
      if (reduceMotion && a.target.flowing) chevron(ctx, lit, a.target.towardHome, alpha(f) * k)
    }
  }

  /**
   * The core's brightness along the arc as a conic gradient that starts
   * `lead` degrees before the arc's first angle, so the round cap there
   * takes the arc's first colour. Stops sit ten to a wavelength, close
   * enough that a crest running past keeps its height within 4 %.
   */
  function gradient(ctx: CanvasRenderingContext2D, lit: [number, number], clockwise: boolean, f: ArcFrame, color: RGBA, k: number, lead: number, scale: number): CanvasGradient | string {
    const span = lit[1] - lit[0]
    const strength = (deg: number) => {
      // From where the light starts: the first angle when it runs
      // clockwise, the last when it runs back.
      const s = ((clockwise ? deg : span - deg) * ring.radius * Math.PI) / 180
      return alpha(f) * (1 - depth(f) * scale * (1 - wave(s, f.phase))) * k
    }
    if (typeof ctx.createConicGradient !== 'function') return rgba(color, strength(span / 2))
    const grad = ctx.createConicGradient(rad(lit[0] - lead), ring.cx, ring.cy)
    const at = (deg: number) => (deg + lead) / 360
    grad.addColorStop(0, rgba(color, strength(0)))
    grad.addColorStop(at(0), rgba(color, strength(0)))
    const perDegree = (ring.radius * Math.PI) / 180
    if (depth(f) * scale > 0.001 && span * perDegree > 1) {
      const step = WAVELENGTH / 10 / perDegree
      for (let d = step; d < span; d += step) grad.addColorStop(at(d), rgba(color, strength(d)))
    }
    grad.addColorStop(at(span), rgba(color, strength(span)))
    // Past the arc only the end's round cap is drawn; it keeps the end's colour.
    grad.addColorStop(1, rgba(color, strength(span)))
    return grad
  }

  /** A still chevron at the middle of an arc, pointing the way the light
   *  would run, in ink. */
  function chevron(ctx: CanvasRenderingContext2D, lit: [number, number], clockwise: boolean, opacity: number) {
    const g = ring
    const mid = rad((lit[0] + lit[1]) / 2)
    const cx = g.cx + g.radius * Math.cos(mid)
    const cy = g.cy + g.radius * Math.sin(mid)
    const dir = clockwise ? 1 : -1
    const ux = -Math.sin(mid) * dir
    const uy = Math.cos(mid) * dir
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
      resolveColors()
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
      resolveColors()
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
          if (e) width = e.contentRect.width
        })
      : null
    if (root) {
      width = root.clientWidth
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
  data-live={anyLive}
>
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
