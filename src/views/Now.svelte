<!--
  Now — the first screen.

  The common case is a glance: phone out of pocket, one look, phone away. So
  the top is a sentence, not a chart. "Battery: -4.2 kW" is a number; "The
  battery is supplying 4.2 kW to keep grid import below 11 kW" is an answer.
  The readings sit underneath for anyone who wants them.
-->
<script lang="ts">
  import EnergyFlow from '$lib/ui/EnergyFlow.svelte'
  import { FID } from '$lib/format/explanation'
  import type { SiteStore } from '$lib/state/site.svelte'

  interface Props {
    site: SiteStore
  }

  let { site }: Props = $props()

  const fields = $derived(site.session.fields)
  const live = $derived(site.session.phase === 'streaming' && site.carrier !== 'cache')
</script>

{#if !site.paired}
  <section class="empty">
    <h1>Nothing paired yet</h1>
    <p>
      Scan the code shown on your FTW box to connect. Everything stays between
      this app and your box — nothing readable passes through Sourceful.
    </p>
    <button class="primary" disabled>Scan code</button>
    <p class="note">Pairing lands with the enrollment flow.</p>
  </section>
{:else if site.session.phase === 'booting'}
  <section class="empty">
    <h1>Your box is starting</h1>
    <p>
      This can take a few minutes after an update while it tidies its database.
      Nothing is wrong — it will appear here as soon as it is ready.
    </p>
    {#if site.session.boot}
      <p class="note">{site.session.boot.phase} · {site.session.boot.pct}%</p>
    {/if}
  </section>
{:else if site.session.phase === 'terminated'}
  <section class="empty">
    <h1>Access ended</h1>
    <p>
      {site.session.terminated?.reason === 'revoked'
        ? 'Your access to this home was withdrawn by its owner.'
        : 'This session ended.'}
    </p>
  </section>
{:else}
  {#if site.session.needsUpdate}
    <div class="banner">
      This app is older than your box. Some things are hidden until it updates.
    </div>
  {/if}

  <section class="explanation">
    <p class="headline">{site.explanation.headline}</p>
  </section>

  <EnergyFlow
    gridW={fields.get(FID.GRID_W)}
    pvW={fields.get(FID.PV_W)}
    batteryW={fields.get(FID.BATTERY_W)}
    loadW={fields.get(FID.LOAD_W)}
    socPercent={site.socPercent}
    {live}
  />
{/if}

<style>
  .empty {
    display: flex;
    flex-direction: column;
    align-items: flex-start;
    gap: var(--space-4);
    padding: var(--space-7) var(--space-4);
    max-width: 34rem;
  }

  .empty h1 {
    font-size: 24px;
    font-weight: 500;
    letter-spacing: -0.02em;
    line-height: 1.1;
  }

  .empty p {
    color: var(--fg-dim);
    max-width: 30rem;
  }

  .note {
    font-family: var(--mono);
    font-size: 11px;
    color: var(--fg-muted);
  }

  .banner {
    margin: var(--space-3) var(--space-4) 0;
    padding: var(--space-3);
    border: 1px solid var(--line);
    border-left: 2px solid var(--accent);
    border-radius: var(--radius-xs);
    font-size: 13px;
    color: var(--fg-dim);
    background: var(--surface-raised);
  }

  .primary {
    background: var(--accent);
    color: var(--on-accent);
    border-radius: var(--radius-sm);
    padding: 0 var(--space-5);
    font-weight: 500;
  }

  .primary:disabled {
    opacity: 0.4;
    cursor: default;
  }

  .explanation {
    padding: var(--space-5) var(--space-4) var(--space-4);
  }

  .headline {
    font-size: 20px;
    line-height: 1.35;
    letter-spacing: -0.01em;
    text-wrap: balance;
  }

</style>
