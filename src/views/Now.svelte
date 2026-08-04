<!--
  Now — the first screen.

  The common case is a glance: phone out of pocket, one look, phone away. So
  the top of this view is a sentence, not a chart. "Battery: -4.2 kW" is a
  number; "The battery is covering the house so nothing is drawn from the
  grid" is an answer. The numbers sit underneath for anyone who wants them.

  Scaffold: reads a stub until the protocol layer lands. The empty state is
  real and shipping — an unpaired app is a state users will see.
-->
<script lang="ts">
  import { formatPower } from '$lib/format/power'

  // Stub. Replaced by the field register once the carrier is wired.
  const paired = false

  const readings = [
    { label: 'Grid', watts: NaN, tone: 'import' },
    { label: 'Solar', watts: NaN, tone: 'generation' },
    { label: 'Battery', watts: NaN, tone: 'storage' },
    { label: 'House', watts: NaN, tone: 'load' },
  ]
</script>

{#if !paired}
  <section class="empty">
    <h1>Nothing paired yet</h1>
    <p>
      Scan the code shown on your FTW box to connect. Everything stays between
      this app and your box — nothing readable passes through Sourceful.
    </p>
    <button class="primary" disabled>Scan code</button>
    <p class="note">Pairing lands with the enrollment flow.</p>
  </section>
{:else}
  <section class="explanation">
    <p class="headline">—</p>
  </section>

  <section class="readings">
    {#each readings as r (r.label)}
      {@const p = formatPower(r.watts)}
      <div class="reading" data-tone={r.tone}>
        <span class="label">{r.label}</span>
        <span class="value num">
          {Number.isFinite(r.watts) ? p.text : '—'}<span class="unit">{p.unit}</span>
        </span>
        <span class="dir">
          {#if p.direction === 'in'}drawing{:else if p.direction === 'out'}exporting{:else}idle{/if}
        </span>
      </div>
    {/each}
  </section>
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
    line-height: 1.3;
    letter-spacing: -0.01em;
    text-wrap: balance;
  }

  .readings {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(150px, 1fr));
    gap: var(--space-2);
    padding: 0 var(--space-4) var(--space-5);
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
</style>
