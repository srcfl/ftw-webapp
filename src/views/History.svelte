<!--
  History — the second screen.

  Now answers "what is my house doing". This answers "what did it do", which
  is a different question and needs a different shape: a range, a chart, and
  the numbers under wherever the finger is.

  Everything around the series is DOM and CSS — labels reflow, respect the
  text size the user set, and are readable to a screen reader. Only the series
  itself is canvas, because that is the part with two thousand points in it.

  Loaded on demand, so none of this sits on the path to the first frame.
-->
<script lang="ts">
  import { onDestroy, onMount, untrack } from 'svelte'
  import Chart from '$lib/ui/Chart.svelte'
  import Energy from '$views/Energy.svelte'
  import { axisOf, ticksOf, trendSpanMs, type Domain, type Trace } from '$lib/ui/chart'
  import { formatPower, formatScaleWatts } from '$lib/format/power'
  import { MISSING_SAMPLE } from '$lib/protocol/messages'
  import { HistoryStore, RANGES, RANGE_KEYS, type RangeKey } from '$lib/state/history.svelte'
  import { askWhenLive } from '$lib/state/ask.svelte'
  import type { SiteStore } from '$lib/state/site.svelte'

  interface Props {
    site: SiteStore
    /** Kept mounted by the shell, but only the visible panel refreshes. */
    active?: boolean
  }

  let { site, active = true }: Props = $props()

  // The site store is one long-lived object, not a value that changes. Reading
  // it once at construction is the intent, so say so rather than leaving a
  // warning for the next person to wonder about.
  const history = new HistoryStore(untrack(() => site))
  onDestroy(() => history.destroy())

  // Colour carries meaning here and comes from tokens.css, never from a hex
  // value written into a component.
  const traces: Trace[] = [
    { name: 'grid_w', label: 'Grid', colorVar: '--energy-import' },
    { name: 'pv_w', label: 'Solar', colorVar: '--energy-generation' },
    { name: 'battery_w', label: 'Battery', colorVar: '--energy-storage' },
    { name: 'load_w', label: 'House', colorVar: '--fg-dim' },
  ]

  // A ticking clock, coarse on purpose: the only thing it feeds is a name
  // that changes every five minutes. A bare Date.now() in the closure below
  // would never re-fire the effect it lives in.
  let nowMs = $state(Date.now())

  onMount(() => {
    const t = setInterval(() => (nowMs = Date.now()), 60_000)
    return () => clearInterval(t)
  })

  // Asked for when the session is up, again whenever it comes back, and again
  // after a window the box could not serve. The cached tiles are already on
  // screen by then; what a drop cost was the difference between them and now,
  // and on mount alone nothing ever went back for it. The range in flight is
  // whichever one is selected, so a reconnect refills the chart the user is
  // actually looking at.
  //
  // The window always ends at this moment, so which five minutes "this
  // moment" is belongs in the name — the chart's own step, and the note
  // below promises a point for each of them. Without it a connection that
  // never drops never re-asks, and the right edge is labelled "now" all
  // afternoon. Each re-ask is a cheap delta: the have-list already covers
  // everything held.
  askWhenLive(
    untrack(() => site),
    () =>
      active && site.documentVisible
        ? `${history.range} ${Math.floor(nowMs / 300_000)}`
        : null,
    () => history.load()
  )

  const frame = $derived(history.frame)
  const hasData = $derived((frame?.points ?? 0) > 0)

  /** Tall enough for a day to have a shape, short enough to sit above the fold. */
  const CHART_H = 200

  // The axis is computed here, not inside the chart, so the numbers printed
  // down the side and the rules drawn on the canvas come from one call. They
  // used to be two, and the canvas was the only one that knew about them.
  const axis = $derived.by((): Domain => (frame ? axisOf(frame.columns, history.lockedDomain) : [0, 0]))

  const ticks = $derived(ticksOf(axis))

  /**
   * The gridline numbers, and which way is which.
   *
   * Magnitudes only — the wire's minus sign is right for the wire and wrong
   * for a person, so the direction is a word on the outermost rule each side
   * rather than a sign on every one of them.
   */
  const yLabels = $derived.by(() => {
    const [min, max] = axis
    const span = max - min || 1
    const positive = ticks.filter((t) => t > 0)
    const negative = ticks.filter((t) => t < 0)
    const highest = positive[positive.length - 1]
    const lowest = negative[0]

    return ticks.map((value) => ({
      value,
      at: (max - value) / span,
      text: value === 0 ? '0' : formatScaleWatts(value),
      dir: value === highest ? 'in' : value === lowest ? 'out' : null,
    }))
  })

  /** Whole hours or whole days, whichever the span makes readable. */
  const axisLabels = $derived.by(() => {
    if (!frame || frame.points === 0) return []
    const span = frame.points * frame.stepMs
    const opts: Intl.DateTimeFormatOptions =
      span <= 36 * 3_600_000
        ? { hour: '2-digit', minute: '2-digit' }
        : { day: 'numeric', month: 'short' }
    const fmt = new Intl.DateTimeFormat(undefined, opts)

    // Three. Five fit the card and not the phone it is held on. The window
    // always ends at this moment, and on a 24 h range both ends otherwise
    // print the same clock time, which reads as a fault rather than a day.
    return [0, 0.5, 1].map((f) => ({
      at: f,
      text:
        f === 1
          ? 'now'
          : fmt.format(new Date(frame.startMs + f * (frame.points - 1) * frame.stepMs)),
    }))
  })

  /**
   * How far apart the points are, in words.
   *
   * Taken from the frame's step rather than the resolution: a wide window is
   * served from the hourly store with whole buckets averaged together, so
   * "every hour" would be the wrong answer even though the store was hourly.
   */
  function stepWords(stepMs: number): string {
    if (stepMs < 3_600_000) return `${Math.round(stepMs / 60_000)} minutes`
    const hours = Math.round(stepMs / 3_600_000)
    if (hours === 1) return 'hour'
    if (hours === 24) return 'day'
    return `${hours} hours`
  }

  /** The chart only trends resolutions finer than its 30-minute window. */
  function trendWords(stepMs: number): string | null {
    const spanMs = trendSpanMs(stepMs)
    if (spanMs === 0) return null
    return `${Math.round(spanMs / 60_000)} min trend · ${Math.round(stepMs / 60_000)} min box readings · exact on touch`
  }

  /**
   * How much of the window went missing, in the unit a person would say.
   *
   * Rounded to hours alone, every gap under thirty minutes printed "0 h" —
   * a note that names a fault and then measures it at nothing. Minutes
   * under an hour, whole hours from there, and never a zero of any unit:
   * the note only exists because something is missing.
   */
  function missingWords(ms: number): string {
    if (ms < 3_600_000) return `${Math.max(1, Math.round(ms / 60_000))} min`
    return `${Math.round(ms / 3_600_000)} h`
  }

  const stamp = $derived.by(() => {
    const at = history.cursorAtMs
    if (at === null) return null
    return new Intl.DateTimeFormat(undefined, {
      day: 'numeric',
      month: 'short',
      hour: '2-digit',
      minute: '2-digit',
    }).format(new Date(at))
  })

  function valueAt(name: string): number | null {
    if (!frame) return null
    const column = frame.columns[frame.names.indexOf(name)]
    if (!column || column.length === 0) return null

    // With no cursor the latest reading is the useful one — it is what the
    // eye lands on anyway, and it matches the Now screen.
    const index = history.cursor ?? column.length - 1
    const v = column[index]
    return v === undefined || v === MISSING_SAMPLE ? null : v
  }

  /** How much of the window the box had nothing for. */
  const missingMs = $derived(history.gaps.reduce((sum, g) => sum + (g.toMs - g.fromMs), 0))
</script>

<section class="history">
  <!-- What the house used, made, bought and sold, day by day. First because
       it is the question people open this screen with; the power trace under
       it answers a different and narrower one. -->
  <Energy {site} {active} />

  <hr />

  <header>
    <h2 class="label">Power, minute by minute</h2>
    <div class="ranges" role="group" aria-label="Time range">
      {#each RANGE_KEYS as key (key)}
        <button
          type="button"
          class="range"
          aria-pressed={history.range === key}
          onclick={() => history.select(key as RangeKey)}
        >
          {RANGES[key].label}
        </button>
      {/each}
    </div>
  </header>

  <!-- The chart's height is published to the CSS so the placeholder can be
       sized from it: the card must not jump when one swaps for the other. -->
  <div class="plot" style:--chart-h="{CHART_H}px">
    {#if hasData && frame}
      <!-- The scale is DOM text beside the canvas, not pixels on it, so it
           reflows and respects the text size the reader chose. It is hidden
           from a screen reader on purpose: rungs on an axis are no use read
           aloud, and the readout below carries the same numbers in words. -->
      <div class="frame">
        <div class="scale" aria-hidden="true" style:height="{CHART_H}px">
          {#each yLabels as label (label.value)}
            <span class="ytick num" style:top="{label.at * 100}%">
              {label.text}
              {#if label.dir}<em class="label">{label.dir}</em>{/if}
            </span>
          {/each}
        </div>
        <Chart
          {frame}
          {traces}
          {axis}
          {ticks}
          height={CHART_H}
          cursor={history.cursor}
          onCursor={(i) => (history.cursor = i)}
        />
        <div class="axis" aria-hidden="true">
          {#each axisLabels as label (label.at)}
            <span class="tick num" style:left="{label.at * 100}%">{label.text}</span>
          {/each}
        </div>
      </div>
    {:else}
      <!-- Three states, not two. "Nothing recorded" is a fact about the
           household's records, and only the box can state it: before the
           first answer this chart is one nobody has filled, not a range with
           nothing in it. The note under the chart carries the news when an
           answer went missing. -->
      <p class="placeholder">
        {history.loaded ? 'Nothing recorded for this range yet.' : 'Reading your box…'}
      </p>
    {/if}
  </div>

  <div class="readout">
    <span class="label when">{stamp ?? 'Latest'}</span>
    {#each traces as trace (trace.name)}
      {@const watts = valueAt(trace.name)}
      {@const parts = formatPower(watts ?? NaN)}
      <div class="cell" style:--swatch="var({trace.colorVar})">
        <span class="label">{trace.label}</span>
        <span class="value num">
          {#if watts === null}
            —
          {:else}
            {parts.text}<span class="unit">{parts.unit}</span>
          {/if}
        </span>
        <!-- The wire's sign convention is right for the wire and wrong for a
             person. Never a minus sign; a direction word instead, set in the
             shared .label grammar like every other small caps word here. -->
        <span class="label">
          {#if watts === null}
            no reading
          {:else if trace.name === 'load_w'}
            used
          {:else if parts.direction === 'idle'}
            idle
          {:else if trace.name === 'pv_w'}
            generated
          {:else if trace.name === 'battery_w'}
            {parts.direction === 'in' ? 'charged' : 'supplied'}
          {:else}
            {parts.direction === 'in' ? 'drawn' : 'exported'}
          {/if}
        </span>
      </div>
    {/each}
  </div>

  <!-- What the box actually served, and what it could not. Both are answers
       to questions the chart otherwise leaves the user guessing at. -->
  <p class="note">
    {#if history.error}
      {history.error}
    {:else if history.loading}
      Reading your box…
    {:else if frame && history.resActual}
      {#if trendWords(frame.stepMs)}
        {trendWords(frame.stepMs)}
      {:else}
        One point every {stepWords(frame.stepMs)}, from your box
      {/if}{#if missingMs > 0}
        · {missingWords(missingMs)} not recorded{/if}
    {/if}
  </p>
</section>

<style>
  .history {
    display: flex;
    flex-direction: column;
    gap: var(--space-4);
    padding: var(--space-4);
  }

  header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: var(--space-3);
    flex-wrap: wrap;
  }

  hr {
    width: 100%;
    height: 1px;
    border: 0;
    background: var(--line-soft);
    margin: var(--space-2) 0 0;
  }

  .ranges {
    display: flex;
    gap: 2px;
    padding: 2px;
    background: var(--surface-sunken);
    border: 1px solid var(--line);
    border-radius: var(--radius-sm);
  }

  .range {
    /* Height comes from base.css: 44px is the smallest reliably hittable
       target on a phone held one-handed. */
    padding: 0 var(--space-4);
    border-radius: var(--radius-xs);
    font-family: var(--mono);
    font-size: 11px;
    letter-spacing: 0.08em;
    color: var(--fg-muted);
    transition: color var(--motion-fast) var(--ease), background var(--motion-fast) var(--ease);
  }

  .range[aria-pressed='true'] {
    background: var(--surface-elevated);
    color: var(--fg);
  }

  .plot {
    /* The x-axis strip under the canvas. Named once, because the placeholder
       below adds it to the chart's height and the two must agree. */
    --axis-h: 16px;
    background: var(--surface-raised);
    border: 1px solid var(--line);
    border-radius: var(--radius-md);
    padding: var(--space-3) var(--space-3) var(--space-2);
  }

  /* Two columns: the scale, then everything measured against it. The x-axis
     sits in the second column so its ends line up with the plot's ends. */
  .frame {
    display: grid;
    grid-template-columns: 34px 1fr;
    column-gap: var(--space-2);
  }

  .scale {
    position: relative;
  }

  .ytick {
    position: absolute;
    right: 0;
    transform: translateY(-50%);
    text-align: right;
    font-size: 10px;
    line-height: 1.2;
    color: var(--fg-muted);
    white-space: nowrap;
  }

  /* The direction word, under its number. The chart never shows a minus
     sign; this is what carries the sign convention instead. The word itself
     follows the shared .label grammar from base.css; placement and dimming
     are all this chart adds. */
  .ytick em {
    display: block;
    font-style: normal;
    opacity: 0.75;
  }

  .axis {
    grid-column: 2;
    position: relative;
    height: var(--axis-h);
    margin-top: var(--space-2);
  }

  .tick {
    position: absolute;
    transform: translateX(-50%);
    font-size: 10px;
    color: var(--fg-muted);
    white-space: nowrap;
  }

  /* The first and last labels would otherwise hang off the card. */
  .tick:first-child {
    transform: none;
  }
  .tick:last-child {
    transform: translateX(-100%);
  }

  .placeholder {
    display: flex;
    align-items: center;
    justify-content: center;
    /* Exactly what the drawn frame occupies — chart, axis strip and the gap
       between — so the card holds still when one replaces the other. */
    height: calc(var(--chart-h) + var(--axis-h) + var(--space-2));
    color: var(--fg-muted);
    font-size: 13px;
    text-align: center;
  }

  .readout {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(90px, 1fr));
    gap: var(--space-3);
    align-items: start;
  }

  .when {
    grid-column: 1 / -1;
    color: var(--fg-dim);
  }

  .cell {
    display: flex;
    flex-direction: column;
    gap: var(--space-2);
    border-left: 2px solid var(--swatch);
    padding-left: var(--space-3);
  }

  .value {
    font-size: 17px;
    font-weight: 500;
    line-height: 1;
    letter-spacing: -0.01em;
  }

  .unit {
    font-size: 11px;
    color: var(--fg-muted);
    margin-left: 0.3em;
    letter-spacing: 0;
  }

  .note {
    font-family: var(--mono);
    font-size: 10px;
    letter-spacing: 0.08em;
    color: var(--fg-muted);
    min-height: 1.4em;
  }
</style>
