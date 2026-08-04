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
  import { onMount, untrack } from 'svelte'
  import Chart from '$lib/ui/Chart.svelte'
  import type { Trace } from '$lib/ui/chart'
  import { formatPower } from '$lib/format/power'
  import { MISSING_SAMPLE } from '$lib/protocol/messages'
  import { HistoryStore, RANGES, RANGE_KEYS, type RangeKey } from '$lib/state/history.svelte'
  import type { SiteStore } from '$lib/state/site.svelte'

  interface Props {
    site: SiteStore
  }

  let { site }: Props = $props()

  // The site store is one long-lived object, not a value that changes. Reading
  // it once at construction is the intent, so say so rather than leaving a
  // warning for the next person to wonder about.
  const history = new HistoryStore(untrack(() => site))

  // Colour carries meaning here and comes from tokens.css, never from a hex
  // value written into a component.
  const traces: Trace[] = [
    { name: 'grid_w', label: 'Grid', colorVar: '--energy-import' },
    { name: 'pv_w', label: 'Solar', colorVar: '--energy-generation' },
    { name: 'battery_w', label: 'Battery', colorVar: '--energy-storage' },
    { name: 'load_w', label: 'House', colorVar: '--fg-dim' },
  ]

  onMount(() => {
    void history.load()
  })

  const frame = $derived(history.frame)
  const hasData = $derived((frame?.points ?? 0) > 0)

  /** Whole hours or whole days, whichever the span makes readable. */
  const axisLabels = $derived.by(() => {
    if (!frame || frame.points === 0) return []
    const span = frame.points * frame.stepMs
    const opts: Intl.DateTimeFormatOptions =
      span <= 36 * 3_600_000
        ? { hour: '2-digit', minute: '2-digit' }
        : { day: 'numeric', month: 'short' }
    const fmt = new Intl.DateTimeFormat(undefined, opts)

    // Three. Five fit the card and not the phone it is held on.
    return [0, 0.5, 1].map((f) => ({
      at: f,
      text: fmt.format(new Date(frame.startMs + f * (frame.points - 1) * frame.stepMs)),
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
  <header>
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

  <div class="plot">
    {#if hasData && frame}
      <Chart
        {frame}
        {traces}
        lockedDomain={history.lockedDomain}
        cursor={history.cursor}
        onCursor={(i) => (history.cursor = i)}
      />
      <div class="axis" aria-hidden="true">
        {#each axisLabels as label (label.at)}
          <span class="tick num" style:left="{label.at * 100}%">{label.text}</span>
        {/each}
      </div>
    {:else}
      <p class="placeholder">
        {history.loading ? 'Reading your box…' : 'Nothing recorded for this range yet.'}
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
             person. Never a minus sign; a direction word instead. -->
        <span class="dir">
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
      One point every {stepWords(frame.stepMs)}, from your box{#if missingMs > 0}
        · {Math.round(missingMs / 3_600_000)} h not recorded{/if}
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
    justify-content: flex-start;
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
    min-height: 34px;
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
    background: var(--surface-raised);
    border: 1px solid var(--line);
    border-radius: var(--radius-md);
    padding: var(--space-3) var(--space-3) var(--space-2);
  }

  .axis {
    position: relative;
    height: 16px;
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
    height: 220px;
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

  .dir {
    font-family: var(--mono);
    font-size: 9px;
    letter-spacing: 0.14em;
    text-transform: uppercase;
    color: var(--fg-muted);
  }

  .note {
    font-family: var(--mono);
    font-size: 10px;
    letter-spacing: 0.08em;
    color: var(--fg-muted);
    min-height: 1.4em;
  }
</style>
