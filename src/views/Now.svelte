<!--
  Now — the first screen.

  The common case is a glance: phone out of pocket, one look, phone away. So
  the top is a sentence, not a chart. "Battery: -4.2 kW" is a number; "The
  battery is supplying 4.2 kW to keep grid import below 11 kW" is an answer.
  The readings sit underneath for anyone who wants them.
-->
<script lang="ts">
  // The box's own hero component, vendored verbatim. Importing registers
  // <ftw-energy-flow>; the app and the on-box dashboard render one file.
  import '$vendor/ftw/ftw-energy-flow.js'
  import type { FtwEnergyFlowElement } from '$vendor/ftw/ftw-energy-flow.js'
  import { flowReadings } from '$lib/state/flow'
  import type { SiteStore } from '$lib/state/site.svelte'

  interface Props {
    site: SiteStore
    /**
     * This phone is pointed at a home, whether or not one has painted yet.
     *
     * Not `site.paired`, which is really "a reading has arrived". A phone that
     * is paired, cannot reach its box and has nothing cached fails that test
     * while being as paired as a phone gets — and this screen told it to scan
     * a code, under a tab bar leading to a Box screen naming the very box it
     * had just denied. The shell owns the answer, so both read the same one.
     */
    hasHome: boolean
    /**
     * What to do when no carrier could be built. Null while one exists.
     *
     * The difference decides what this screen may promise: with a carrier,
     * waiting is genuinely the right thing to do, and without one nothing is
     * happening at all.
     */
    connectHelp?: string | null
  }

  let { site, hasHome, connectHelp = null }: Props = $props()

  const live = $derived(site.session.phase === 'streaming' && site.carrier !== 'cache')

  let flow = $state<FtwEnergyFlowElement | null>(null)

  // The component takes data by method, the way the dashboard feeds it.
  // An effect rather than an attribute because setReadings() is the
  // component's whole API, and inventing a second one would fork it.
  $effect(() => {
    flow?.setReadings(flowReadings(site.session.fields))
  })
</script>

{#if !hasHome}
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
{:else if site.session.fields.size === 0}
  <!-- Paired, and not one reading has ever arrived — from the box or off the
       disk. The house diagram below would draw itself hollow, which reads as a
       home sitting at zero rather than as a phone that has heard nothing. So
       say the second thing, and say what is being done about it: nothing, by
       the person holding the phone. -->
  <section class="empty">
    <h1>Nothing from your box yet</h1>
    <p>
      {#if connectHelp}
        {connectHelp}
      {:else}
        This phone is paired to it and keeps trying on its own. Your house
        appears here as soon as the box answers.
      {/if}
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

  <div class="flow">
    <!-- static is the honesty switch: a cached view holds still, because a
         moving particle claims power is flowing at this very moment. -->
    <ftw-energy-flow bind:this={flow} embedded static={live ? undefined : true}
    ></ftw-energy-flow>
  </div>
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

  .flow {
    padding: 0 var(--space-3) var(--space-5);
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
