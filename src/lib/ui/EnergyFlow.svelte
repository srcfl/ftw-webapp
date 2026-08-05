<!--
  The energy flow — the house at a glance.

  The same picture the box's own dashboard draws: sources and sinks as nodes,
  the house in the middle, power as dots moving along the lines. The dots are
  the honest part: they move only while the readings are live, in the actual
  direction of flow, at a pace that follows the size of it. A cached view
  holds still, because animation is a claim about *now* and cache is not now.

  Layout is one SVG so the lines and nodes cannot drift apart on odd screen
  widths. Text sits in <text> elements — it scales with the drawing, and the
  numbers stay selectable and readable to a screen reader.

  EV charging belongs here too, but ev_w is not on the wire yet; the fourth
  corner is reserved rather than faked. Never a dead node with an invented
  zero — "never fake live" covers assets as much as freshness.
-->
<script lang="ts">
  import { formatPower } from '$lib/format/power'

  interface Props {
    /** Site-signed watts: positive into the site. undefined = no reading. */
    gridW: number | undefined
    pvW: number | undefined
    batteryW: number | undefined
    loadW: number | undefined
    /** 0-100, or null when unknown. */
    socPercent: number | null
    /** Dots move only when this is true. */
    live: boolean
  }

  let { gridW, pvW, batteryW, loadW, socPercent, live }: Props = $props()

  /** Below this the flow reads as noise, not intent. */
  const IDLE_W = 50

  // Self-powered share of this instant: the part of the house's use that is
  // not coming through the grid meter. Clamped — export can push it past 1.
  const selfShare = $derived.by(() => {
    if (loadW === undefined || gridW === undefined || loadW <= 0) return null
    return Math.round(Math.min(1, Math.max(0, 1 - Math.max(0, gridW) / loadW)) * 100)
  })

  /** Dot period in seconds: full flow is brisk, a trickle crawls. */
  function pace(watts: number): number {
    const speed = Math.min(1, Math.abs(watts) / 5000)
    return 4.5 - 3.3 * speed
  }

  interface Edge {
    active: boolean
    /** true = toward the house along the path as drawn. */
    inward: boolean
    seconds: number
  }

  const edge = (watts: number | undefined, towardHouse: (w: number) => boolean): Edge =>
    watts === undefined || Math.abs(watts) < IDLE_W
      ? { active: false, inward: true, seconds: 4 }
      : { active: true, inward: towardHouse(watts), seconds: pace(watts) }

  // Solar generates (negative, by the site sign) and only ever feeds in.
  const solar = $derived(edge(pvW, () => true))
  // Battery: positive is charging — power leaves the house node.
  const battery = $derived(edge(batteryW, (w) => w < 0))
  // Grid: positive is import — power arrives.
  const grid = $derived(edge(gridW, (w) => w > 0))

  const fmt = (watts: number | undefined) =>
    watts === undefined ? null : formatPower(watts)

  const solarText = $derived(fmt(pvW === undefined ? undefined : Math.abs(pvW)))
  const batteryText = $derived(fmt(batteryW === undefined ? undefined : Math.abs(batteryW)))
  const gridText = $derived(fmt(gridW === undefined ? undefined : Math.abs(gridW)))
  const loadText = $derived(fmt(loadW))

  function verb(watts: number | undefined, idle: string, pos: string, neg: string): string {
    if (watts === undefined) return 'no reading'
    if (Math.abs(watts) < IDLE_W) return idle
    return watts > 0 ? pos : neg
  }

  const solarVerb = $derived(verb(pvW, 'idle', 'idle', 'generating'))
  const batteryVerb = $derived(verb(batteryW, 'idle', 'charging', 'supplying'))
  const gridVerb = $derived(verb(gridW, 'idle', 'drawing', 'exporting'))

  const summary = $derived(
    `Solar ${solarVerb}${solarText ? ` ${solarText.text} ${solarText.unit}` : ''}, ` +
      `battery ${batteryVerb}${batteryText ? ` ${batteryText.text} ${batteryText.unit}` : ''}` +
      `${socPercent !== null ? ` at ${socPercent} percent` : ''}, ` +
      `grid ${gridVerb}${gridText ? ` ${gridText.text} ${gridText.unit}` : ''}, ` +
      `house using ${loadText ? `${loadText.text} ${loadText.unit}` : 'an unknown amount'}`
  )

  // Node centres and the paths between them. One place, because the dots ride
  // the same paths the lines draw.
  const HOUSE = { x: 180, y: 178 }
  const NODES = {
    solar: { x: 84, y: 72 },
    battery: { x: 276, y: 72 },
    grid: { x: 84, y: 286 },
  }

  /** From node edge to house edge, so dots appear at a rim, not under text. */
  function path(from: { x: number; y: number }): string {
    const dx = HOUSE.x - from.x
    const dy = HOUSE.y - from.y
    const len = Math.hypot(dx, dy)
    const a = { x: from.x + (dx / len) * 48, y: from.y + (dy / len) * 48 }
    const b = { x: HOUSE.x - (dx / len) * 66, y: HOUSE.y - (dy / len) * 66 }
    return `M ${a.x.toFixed(1)} ${a.y.toFixed(1)} L ${b.x.toFixed(1)} ${b.y.toFixed(1)}`
  }
</script>

<figure class="flow" role="img" aria-label={summary}>
  <svg viewBox="0 0 360 360" xmlns="http://www.w3.org/2000/svg">
    <!-- lines under everything -->
    {#each [
      { d: path(NODES.solar), on: solar.active, tone: 'generation' },
      { d: path(NODES.battery), on: battery.active, tone: 'storage' },
      { d: path(NODES.grid), on: grid.active, tone: gridW !== undefined && gridW > 0 ? 'import' : 'export' },
    ] as line}
      <path class="line" class:on={line.on} data-tone={line.tone} d={line.d} />
    {/each}

    <!-- dots: three per active edge, evenly phased -->
    {#if live}
      {#each [
        { e: solar, d: path(NODES.solar), tone: 'generation' },
        { e: battery, d: path(NODES.battery), tone: 'storage' },
        { e: grid, d: path(NODES.grid), tone: gridW !== undefined && gridW > 0 ? 'import' : 'export' },
      ] as f}
        {#if f.e.active}
          {#each [0, 1, 2] as i}
            <circle class="dot" data-tone={f.tone} r="3">
              <animateMotion
                dur="{f.e.seconds}s"
                begin="{(i * f.e.seconds) / 3}s"
                repeatCount="indefinite"
                keyPoints={f.e.inward ? '0;1' : '1;0'}
                keyTimes="0;1"
                calcMode="linear"
                path={f.d}
              />
            </circle>
          {/each}
        {/if}
      {/each}
    {/if}

    <!-- the house -->
    <circle class="node house" class:live cx={HOUSE.x} cy={HOUSE.y} r="64" />
    <path
      class="glyph"
      d="M 170 164 L 180 155 L 190 164 M 173 162 L 173 172 L 187 172 L 187 162"
      fill="none"
    />
    <text class="value" x={HOUSE.x} y="196">
      {#if loadText}{loadText.text}<tspan class="unit"> {loadText.unit}</tspan>{:else}—{/if}
    </text>
    {#if selfShare !== null}
      <text class="note" x={HOUSE.x} y="214">{selfShare}% SELF-POWERED</text>
    {/if}

    <!-- solar -->
    <circle class="node" class:on={solar.active} data-tone="generation" cx={NODES.solar.x} cy={NODES.solar.y} r="46" />
    <text class="label" x={NODES.solar.x} y="56">SOLAR</text>
    <text class="value" data-tone={solar.active ? 'generation' : null} x={NODES.solar.x} y="78">
      {#if solarText}{solarText.text}<tspan class="unit"> {solarText.unit}</tspan>{:else}—{/if}
    </text>
    <text class="note" x={NODES.solar.x} y="94">{solarVerb}</text>

    <!-- battery -->
    <circle class="node" class:on={battery.active} data-tone="storage" cx={NODES.battery.x} cy={NODES.battery.y} r="46" />
    <text class="label" x={NODES.battery.x} y="56">BATTERY</text>
    <text class="value" data-tone={battery.active ? 'storage' : null} x={NODES.battery.x} y="78">
      {#if batteryText}{batteryText.text}<tspan class="unit"> {batteryText.unit}</tspan>{:else}—{/if}
    </text>
    <text class="note" x={NODES.battery.x} y="94">
      {socPercent !== null ? `${socPercent}% · ${batteryVerb}` : batteryVerb}
    </text>

    <!-- grid -->
    <circle
      class="node"
      class:on={grid.active}
      data-tone={gridW !== undefined && gridW > 0 ? 'import' : 'export'}
      cx={NODES.grid.x}
      cy={NODES.grid.y}
      r="46"
    />
    <text class="label" x={NODES.grid.x} y="270">GRID</text>
    <text
      class="value"
      data-tone={grid.active ? (gridW !== undefined && gridW > 0 ? 'import' : 'export') : null}
      x={NODES.grid.x}
      y="292"
    >
      {#if gridText}{gridText.text}<tspan class="unit"> {gridText.unit}</tspan>{:else}—{/if}
    </text>
    <text class="note" x={NODES.grid.x} y="308">{gridVerb}</text>
  </svg>
</figure>

<style>
  .flow {
    margin: 0;
    padding: 0 var(--space-4);
    max-width: 26rem;
  }

  svg {
    width: 100%;
    height: auto;
    display: block;
  }

  .node {
    fill: var(--surface-raised);
    stroke: var(--line);
    stroke-width: 1;
    transition: stroke var(--motion-slow) var(--ease);
  }

  .node.on[data-tone='generation'] { stroke: var(--energy-generation); }
  .node.on[data-tone='storage'] { stroke: var(--energy-storage); }
  .node.on[data-tone='import'] { stroke: var(--energy-import); }
  .node.on[data-tone='export'] { stroke: var(--energy-export); }

  .house {
    fill: var(--surface-elevated);
    stroke: var(--line);
  }
  .house.live {
    stroke: var(--accent);
  }

  .glyph {
    stroke: var(--accent);
    stroke-width: 1.6;
    stroke-linecap: round;
    stroke-linejoin: round;
  }

  .line {
    stroke: var(--line);
    stroke-width: 1;
    opacity: 0.6;
  }
  .line.on[data-tone='generation'] { stroke: var(--energy-generation); opacity: 0.45; }
  .line.on[data-tone='storage'] { stroke: var(--energy-storage); opacity: 0.45; }
  .line.on[data-tone='import'] { stroke: var(--energy-import); opacity: 0.45; }
  .line.on[data-tone='export'] { stroke: var(--energy-export); opacity: 0.45; }

  .dot[data-tone='generation'] { fill: var(--energy-generation); }
  .dot[data-tone='storage'] { fill: var(--energy-storage); }
  .dot[data-tone='import'] { fill: var(--energy-import); }
  .dot[data-tone='export'] { fill: var(--energy-export); }

  /* Motion is information here, but not for someone who asked for less of
     it. The colours and numbers carry the same facts standing still. */
  @media (prefers-reduced-motion: reduce) {
    .dot {
      display: none;
    }
  }

  text {
    text-anchor: middle;
    fill: var(--fg);
  }

  .label {
    font-family: var(--mono);
    font-size: 9px;
    letter-spacing: 0.14em;
    fill: var(--fg-muted);
  }

  .value {
    font-size: 17px;
    font-weight: 500;
    letter-spacing: -0.01em;
  }

  .value[data-tone='generation'] { fill: var(--energy-generation); }
  .value[data-tone='storage'] { fill: var(--energy-storage); }
  .value[data-tone='import'] { fill: var(--energy-import); }
  .value[data-tone='export'] { fill: var(--energy-export); }

  .unit {
    font-size: 10px;
    fill: var(--fg-muted);
    letter-spacing: 0;
  }

  .note {
    font-family: var(--mono);
    font-size: 8px;
    letter-spacing: 0.1em;
    fill: var(--fg-muted);
    text-transform: uppercase;
  }
</style>
