<!--
  Now — the first screen.

  The common case is a glance: phone out of pocket, one look, phone away. So
  the top is a sentence, not a chart. "Battery: -4.2 kW" is a number; "The
  battery is supplying 4.2 kW to keep grid import below 11 kW" is an answer.
  The readings sit underneath for anyone who wants them.
-->
<script lang="ts">
  import { formatPower } from '$lib/format/power'
  import type { SiteStore } from '$lib/state/site.svelte'

  interface Props {
    site: SiteStore
  }

  let { site }: Props = $props()

  const soc = $derived(site.socPercent)
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

  <section class="readings">
    {#each site.readings as r (r.fid)}
      {@const p = formatPower(r.watts ?? NaN)}
      <div class="reading" data-tone={r.tone}>
        <span class="label">{r.label}</span>
        <span class="value num">
          {r.watts === undefined ? '—' : p.text}<span class="unit">{p.unit}</span>
        </span>
        <!-- Each asset gets its own verb. "Drawing" is right for the grid and
             wrong for a panel: the sun generates, it does not draw. -->
        <span class="dir">
          {#if r.watts === undefined}
            no reading
          {:else if r.tone === 'load'}
            using
          {:else if p.direction === 'idle'}
            idle
          {:else if r.tone === 'generation'}
            generating
          {:else if r.tone === 'storage'}
            {p.direction === 'in' ? 'charging' : 'supplying'}
          {:else}
            {p.direction === 'in' ? 'drawing' : 'exporting'}
          {/if}
        </span>
      </div>
    {/each}
  </section>

  {#if soc !== null}
    <section class="soc">
      <div class="soc-head">
        <span class="label">Battery charge</span>
        <span class="num soc-value">{soc}<span class="unit">%</span></span>
      </div>
      <div class="soc-track" role="img" aria-label="Battery at {soc} percent">
        <div class="soc-fill" style:width="{soc}%"></div>
      </div>
    </section>
  {/if}
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

  .readings {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(150px, 1fr));
    gap: var(--space-2);
    padding: 0 var(--space-4) var(--space-4);
  }

  .reading {
    display: flex;
    flex-direction: column;
    gap: var(--space-2);
    background: var(--surface-raised);
    border: 1px solid var(--line);
    border-radius: var(--radius-md);
    padding: var(--pad-card);
  }

  .value {
    font-size: 28px;
    font-weight: 500;
    line-height: 1;
    letter-spacing: -0.02em;
  }

  .unit {
    font-size: 13px;
    color: var(--fg-muted);
    margin-left: 0.2em;
    letter-spacing: 0;
  }

  .dir {
    font-family: var(--mono);
    font-size: 10px;
    letter-spacing: 0.14em;
    text-transform: uppercase;
    color: var(--fg-muted);
  }

  /* Colour carries meaning here, so it is never decorative. */
  .reading[data-tone='import'] .value {
    color: var(--energy-import);
  }
  .reading[data-tone='generation'] .value {
    color: var(--energy-generation);
  }
  .reading[data-tone='storage'] .value {
    color: var(--energy-storage);
  }

  .soc {
    padding: 0 var(--space-4) var(--space-6);
  }

  .soc-head {
    display: flex;
    align-items: baseline;
    justify-content: space-between;
    margin-bottom: var(--space-2);
  }

  .soc-value {
    font-size: 18px;
    font-weight: 500;
  }

  .soc-track {
    height: 6px;
    border-radius: 3px;
    background: var(--surface-elevated);
    border: 1px solid var(--line);
    overflow: hidden;
  }

  .soc-fill {
    height: 100%;
    background: var(--energy-storage);
    transition: width var(--motion-slow) var(--ease);
  }
</style>
