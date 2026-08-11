<!--
  Energy by day — what the house used, made, bought and sold.

  The question the History chart cannot answer. A power trace says what was
  happening at four on Tuesday; this says how much of the month was bought.
  Both belong on the same screen, and this one goes first because it is the
  one people came for.

  The four figures are the whole view. The chart under them is one of those
  four at a time, chosen by tapping its card — not four grouped bars per day,
  which at thirty days on a phone is four slivers a millimetre wide.

  Every figure here is integer watt-hours until the moment it is printed, and
  it is printed by one function. The bars and the total over them must add up,
  or a household is right to distrust both.

  Drawn only when the box advertises api.passthrough. Absent means hide, never
  crash — the same rule as every other capability.
-->
<script lang="ts">
  import { onMount, untrack } from 'svelte'
  import { askWhenLive } from '$lib/state/ask.svelte'
  import { EnergyStore, ENERGY_RANGES, ENERGY_RANGE_KEYS, type EnergyRangeKey } from '$lib/state/energy.svelte'
  import { formatEnergy, energyLabel } from '$lib/format/energy'
  import type { FtwBarChartElement, FtwBarChartDatum } from '$vendor/ftw/ftw-bar-chart.js'
  import type { SiteStore } from '$lib/state/site.svelte'

  interface Props {
    site: SiteStore
    active?: boolean
  }

  let { site, active = true }: Props = $props()

  /** From contract/registry.yaml. Absent means this box has no passthrough. */
  const CAP_PASSTHROUGH = 'api.passthrough'

  // The site store is one long-lived object, not a value that changes.
  const energy = new EnergyStore(untrack(() => site))

  type SeriesKey = 'loadWh' | 'pvWh' | 'importWh' | 'exportWh'

  interface Series {
    key: SeriesKey
    label: string
    note: string
    colorVar: string
  }

  // The box's own four, in the box's own order, with the box's own wording.
  // Colour comes from tokens.css and never from a hex value written here.
  const SERIES: Series[] = [
    { key: 'loadWh', label: 'Used at home', note: 'everything the house drew', colorVar: '--fg-dim' },
    { key: 'pvWh', label: 'Made by solar', note: 'what the panels produced', colorVar: '--energy-generation' },
    { key: 'importWh', label: 'Bought', note: 'taken from the grid', colorVar: '--energy-import' },
    { key: 'exportWh', label: 'Sold', note: 'sent back to the grid', colorVar: '--energy-export' },
  ]

  let shown = $state<SeriesKey>('loadWh')

  const shownSeries = $derived(SERIES.find((s) => s.key === shown) ?? SERIES[0]!)

  // A ticking clock, coarse on purpose: all it feeds is a name that changes
  // once an hour. A bare Date.now() in the derived below reads the clock
  // exactly once and never re-fires anything.
  let nowMs = $state(Date.now())

  onMount(() => {
    const t = setInterval(() => (nowMs = Date.now()), 60_000)
    return () => clearInterval(t)
  })

  /**
   * What the box is being asked for.
   *
   * The local day is part of the name, so a screen left open overnight asks
   * again rather than heading yesterday's figures "Today" — and the hour is
   * too, because today's column keeps filling all day: a "today so far" read
   * at nine in the morning was still the figure at nine in the evening on a
   * connection that never dropped. A reconnect and a failed ask both earn a
   * fresh one without the name having to change; askWhenLive gives that.
   */
  const wanted = $derived.by(() => {
    if (!active || !site.documentVisible) return null
    if (!site.session.caps.has(CAP_PASSTHROUGH)) return null
    const at = new Date(nowMs)
    return `energy ${energy.range} ${at.toDateString()} ${at.getHours()}`
  })

  askWhenLive(untrack(() => site), () => wanted, () => energy.load())

  // A box that stops advertising the passthrough stops being asked, and what
  // is on screen came from a route this box no longer offers. Show none.
  $effect(() => {
    if (!site.session.caps.has(CAP_PASSTHROUGH)) energy.days = []
  })

  const totals = $derived(energy.totals)
  const hasDays = $derived(energy.days.length > 0)

  /** One bar per day is only a shape once there is more than one day. */
  const drawChart = $derived(hasDays && energy.days.length > 1)

  /**
   * Value tags and day labels, thinned to what the width can hold.
   *
   * The component prints whatever it is given for every column, and thirty
   * columns of "12.3" on a 375 px phone is a grey smear. An empty string is
   * the component's own way of being told to print nothing — the figure is
   * still on the column's tooltip, and the total above the chart is the
   * number the eye is actually after.
   */
  const bars = $derived.by((): FtwBarChartDatum[] => {
    const rows = energy.days
    const dense = rows.length > 7
    const fmt = new Intl.DateTimeFormat(undefined, { weekday: 'short', day: 'numeric' })

    return rows.map((row, i) => {
      const wh = row[shownSeries.key]
      // Midday, so a date never lands on the wrong side of a daylight-saving
      // seam and prints the day before.
      const at = new Date(`${row.day}T12:00:00`)
      // The endpoint always ends at today, and today is still running. Its
      // column is genuinely shorter than the days beside it and would read as
      // a quiet day rather than an unfinished one, which is the same lie as
      // a stale number styled as current. So it is named, not drawn away.
      const today = i === rows.length - 1
      const full = today ? 'today so far' : fmt.format(at)
      const label = today ? 'today' : dense ? (i % 5 === 0 ? String(at.getDate()) : '') : full

      return {
        // Kilowatt-hours, so the bar and the card over it are the same unit.
        value: wh / 1000,
        label,
        displayValue: dense ? '' : formatEnergy(wh).text,
        title: `${full}: ${energyLabel(wh)}`,
      }
    })
  })

  let chart = $state<FtwBarChartElement | null>(null)

  $effect(() => {
    if (chart) chart.data = bars
  })

  /**
   * The one sentence worth keeping from the box's "what stands out" panel.
   *
   * "As much as", never "of": solar that made 80% as much as the house used
   * did not necessarily cover 80% of it, because the sun and the kettle rarely
   * coincide. The looser claim is the true one.
   */
  const solarShare = $derived(
    totals.loadWh > 0 && totals.pvWh > 0 ? Math.round((totals.pvWh / totals.loadWh) * 100) : null
  )

  const batteryMoved = $derived(totals.batChargedWh > 0 || totals.batDischargedWh > 0)
</script>

{#if site.session.caps.has(CAP_PASSTHROUGH)}
  <section class="energy">
    <header>
      <h2 class="label">{energy.spec.title}</h2>
      <div class="ranges" role="group" aria-label="Period">
        {#each ENERGY_RANGE_KEYS as key (key)}
          <button
            type="button"
            class="range"
            aria-pressed={energy.range === key}
            onclick={() => energy.select(key as EnergyRangeKey)}
          >
            {ENERGY_RANGES[key].label}
          </button>
        {/each}
      </div>
    </header>

    <!-- Tappable, because each one is also what the chart below draws.
         Pressed buttons rather than radios, the way the range picker above
         solves the same exclusive choice: role=radio promises arrow-key
         moves between the options, and these buttons never had them. -->
    <div class="cards" role="group" aria-label="What the chart shows">
      {#each SERIES as series (series.key)}
        {@const parts = formatEnergy(totals[series.key])}
        <button
          type="button"
          class="card"
          aria-pressed={shown === series.key}
          style:--swatch="var({series.colorVar})"
          onclick={() => (shown = series.key)}
        >
          <span class="card-label">{series.label}</span>
          <span class="card-value num">
            {#if hasDays}
              {parts.text}<span class="unit">{parts.unit}</span>
            {:else}
              —
            {/if}
          </span>
          <span class="card-note">{series.note}</span>
        </button>
      {/each}
    </div>

    {#if drawChart}
      <div class="plot" style:--swatch="var({shownSeries.colorVar})">
        <p class="plot-head">
          {shownSeries.label}, kWh per day
        </p>
        <!-- The box's own component, byte for byte. Loaded when there is
             something to draw, so it never sits on the path to a first frame
             — the same rule the price chart follows. -->
        {#await import('$vendor/ftw/ftw-bar-chart.js') then _module}
          <ftw-bar-chart
            bind:this={chart}
            accent="var({shownSeries.colorVar})"
            chart-height="120"
            bar-max="26"
            empty-text="nothing recorded"
          ></ftw-bar-chart>
        {:catch}
          <!-- The chunk never arrived. The figures above are complete either
               way; silence here would read as a chart with nothing in it. -->
          <p class="note">The chart didn't load — it will try again next time you open the app.</p>
        {/await}
      </div>
    {/if}

    <p class="note">
      {#if energy.error}
        {energy.error}
      {:else if energy.loading && !hasDays}
        Reading your box…
      {:else if !hasDays}
        <!-- Three states, not two. "Nothing recorded" is a fact about the
             household's week, and it can only be said once the box has said
             it — a box that answers hello and then starts for four minutes
             sends no reading, so nothing has asked yet, and this said their
             week was empty the whole time. -->
        {energy.loaded ? 'Nothing recorded for this period yet.' : 'Reading your box…'}
      {:else}
        {#if solarShare !== null}<span
            >Solar made {solarShare}% as much energy as the home used.</span
          >{/if}
        {#if batteryMoved}<span
            >The battery took in {energyLabel(totals.batChargedWh)} and gave back {energyLabel(
              totals.batDischargedWh
            )}.</span
          >{/if}
        {#if energy.range !== 'today'}<span class="partial">Today is still running.</span>{/if}
      {/if}
    </p>
  </section>
{/if}

<style>
  .energy {
    display: flex;
    flex-direction: column;
    gap: var(--space-3);
  }

  header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: var(--space-3);
    flex-wrap: wrap;
  }

  .label {
    font-family: var(--mono);
    font-size: 11px;
    letter-spacing: 0.1em;
    text-transform: uppercase;
    color: var(--fg-muted);
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
    padding: 0 var(--space-3);
    border-radius: var(--radius-xs);
    font-family: var(--mono);
    font-size: 11px;
    letter-spacing: 0.08em;
    color: var(--fg-muted);
    transition:
      color var(--motion-fast) var(--ease),
      background var(--motion-fast) var(--ease);
  }

  .range[aria-pressed='true'] {
    background: var(--surface-elevated);
    color: var(--fg);
  }

  /* Two across on a phone, four where there is room. */
  .cards {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(140px, 1fr));
    gap: var(--space-2);
  }

  .card {
    display: flex;
    flex-direction: column;
    align-items: flex-start;
    gap: var(--space-1);
    padding: var(--space-3);
    text-align: left;
    background: var(--surface-raised);
    border: 1px solid var(--line);
    border-left: 2px solid var(--swatch);
    border-radius: var(--radius-sm);
    transition: border-color var(--motion-fast) var(--ease);
  }

  .card[aria-pressed='true'] {
    border-color: var(--swatch);
    background: var(--surface-elevated);
  }

  .card-label {
    font-size: 12px;
    color: var(--fg-dim);
  }

  .card-value {
    font-size: 20px;
    font-weight: 500;
    line-height: 1.1;
    letter-spacing: -0.01em;
    color: var(--fg);
  }

  .unit {
    font-size: 11px;
    color: var(--fg-muted);
    margin-left: 0.3em;
    letter-spacing: 0;
  }

  .card-note {
    font-size: 11px;
    color: var(--fg-muted);
  }

  .plot {
    background: var(--surface-raised);
    border: 1px solid var(--line);
    border-radius: var(--radius-md);
    padding: var(--space-3);
  }

  .plot-head {
    font-family: var(--mono);
    font-size: 10px;
    letter-spacing: 0.08em;
    text-transform: uppercase;
    color: var(--fg-muted);
    margin-bottom: var(--space-2);
  }

  .note {
    font-size: 12px;
    line-height: 1.5;
    color: var(--fg-muted);
    min-height: 1.4em;
  }

  /* Sentences in a flow, each keeping its own space from the next. Written
     as elements rather than as text with markup between them, because the
     template's own whitespace is not reliably one space. */
  .note :global(span) {
    margin-right: 0.35em;
  }

  /* Why the last column is short. Dimmer than the rest of the line: it is a
     caveat on the chart, not news. */
  .partial {
    opacity: 0.75;
  }
</style>
