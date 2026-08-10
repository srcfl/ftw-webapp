<!--
  One reading, live, behind a tap on its bubble.

  The Now hero answers "what is my house doing"; this answers "what is this
  one part doing, right now, and how has it moved this last minute". A sheet
  over the house, the same shape the charger opens in — a big current number
  in words, and under it a line that slides as the stream lands. The value
  and the line come from the one 1 Hz session frame, so the number over the
  chart and the chart's own leading edge are the same reading.
-->
<script lang="ts">
  import LiveChart from '$lib/ui/LiveChart.svelte'
  import { formatPower } from '$lib/format/power'
  import { FID } from '$lib/format/explanation'
  import type { SiteStore } from '$lib/state/site.svelte'

  /** Which bubble was tapped. Everything else follows from it. */
  export type LiveRole = 'grid' | 'pv' | 'battery' | 'load'

  interface Props {
    site: SiteStore
    role: LiveRole
    onclose: () => void
  }

  let { site, role, onclose }: Props = $props()

  // What each bubble is, in the terms this panel needs: the field to read,
  // the words for each direction, whether the line may cross zero, and the
  // colour it carries on the hero. Positive is into the site throughout,
  // FTW's one convention — the words below are the only place a person meets
  // a direction, never a minus sign.
  const SPECS: Record<
    LiveRole,
    {
      title: string
      fid: number
      signed: boolean
      color: string
      /** value → the sentence under the big number. */
      words: (w: number) => string
    }
  > = {
    grid: {
      title: 'Grid',
      fid: FID.GRID_W,
      signed: true,
      color: 'var(--red-e)',
      words: (w) => (Math.abs(w) < 20 ? 'balanced' : w > 0 ? 'drawing from the grid' : 'exporting to the grid'),
    },
    pv: {
      title: 'Solar',
      fid: FID.PV_W,
      signed: false,
      color: 'var(--amber)',
      words: (w) => (Math.abs(w) < 20 ? 'not producing' : 'producing'),
    },
    battery: {
      title: 'Battery',
      fid: FID.BATTERY_W,
      signed: true,
      color: 'var(--cyan)',
      words: (w) => (Math.abs(w) < 20 ? 'resting' : w > 0 ? 'charging' : 'discharging'),
    },
    load: {
      title: 'Home',
      fid: FID.LOAD_W,
      signed: false,
      color: 'var(--fg)',
      words: () => 'used by the house',
    },
  }

  const spec = $derived(SPECS[role])

  // The raw signed watts, straight off the current frame. Solar reads
  // negative while generating (site convention); the panel plots and prints
  // its magnitude, because solar only ever produces.
  const raw = $derived(site.session.fields.get(spec.fid))
  const plotValue = $derived(
    raw === undefined ? null : spec.signed ? raw : Math.abs(raw)
  )

  // The line moves on news and freezes on silence. uptimeMs advances once
  // per real frame, so it is the honest tick — a repeated cache value does
  // not move it, and neither does a quiet stream.
  const tick = $derived(site.session.uptimeMs)
  const live = $derived(
    site.session.phase === 'streaming' && site.carrier !== 'cache' && site.srcState === 'live'
  )

  const parts = $derived(plotValue === null ? null : formatPower(plotValue))

  function onkeydown(e: KeyboardEvent) {
    if (e.key === 'Escape') onclose()
  }
</script>

<svelte:window {onkeydown} />

<div class="backdrop" onclick={onclose} aria-hidden="true"></div>

<div class="sheet" role="dialog" aria-modal="true" aria-label={spec.title}>
  <header>
    <h2>{spec.title}</h2>
    <button class="close" onclick={onclose} aria-label="Close">Close</button>
  </header>

  {#if parts === null}
    <p class="note">No reading from your box yet.</p>
  {:else}
    <p class="reading" style="color: {spec.color}">
      <span class="value">{parts.text}</span>
      <span class="unit">{parts.unit}</span>
    </p>
    <p class="sub">{spec.words(spec.signed ? (raw ?? 0) : Math.abs(raw ?? 0))}{live ? '' : ' · last known'}</p>

    <div class="chart">
      <LiveChart value={plotValue} {tick} signed={spec.signed} color={spec.color} {live} />
    </div>
    <p class="axis">last two minutes</p>
  {/if}
</div>

<style>
  .backdrop {
    position: fixed;
    inset: 0;
    background: rgb(0 0 0 / 45%);
    z-index: 40;
  }

  .sheet {
    position: fixed;
    left: 0;
    right: 0;
    bottom: 0;
    z-index: 41;
    background: var(--surface-raised);
    border-top: 1px solid var(--line);
    border-radius: var(--radius-lg) var(--radius-lg) 0 0;
    padding: var(--space-4) var(--space-4)
      calc(var(--space-5) + env(safe-area-inset-bottom, 0px));
    display: flex;
    flex-direction: column;
    gap: var(--space-2);
  }

  header {
    display: flex;
    align-items: baseline;
    justify-content: space-between;
    margin-bottom: var(--space-2);
  }

  h2 {
    font-size: 13px;
    font-weight: 500;
    letter-spacing: 0.08em;
    text-transform: uppercase;
    color: var(--fg-dim);
  }

  .close {
    color: var(--fg-dim);
    font-size: 14px;
  }

  .reading {
    display: flex;
    align-items: baseline;
    gap: var(--space-2);
    font-family: var(--num);
  }

  .value {
    font-size: 40px;
    font-weight: 600;
    letter-spacing: -0.02em;
    line-height: 1;
  }

  .unit {
    font-size: 18px;
    color: var(--fg-dim);
  }

  .sub {
    font-size: 14px;
    color: var(--fg-dim);
  }

  .chart {
    height: 180px;
    margin-top: var(--space-3);
  }

  .axis {
    font-family: var(--mono);
    font-size: 10px;
    letter-spacing: 0.06em;
    text-transform: uppercase;
    color: var(--fg-muted);
    text-align: right;
  }

  .note {
    color: var(--fg-dim);
    font-size: 14px;
  }
</style>
