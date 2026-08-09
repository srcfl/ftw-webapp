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
  import { untrack } from 'svelte'
  import '$vendor/ftw/ftw-energy-flow.js'
  import type { FtwEnergyFlowElement } from '$vendor/ftw/ftw-energy-flow.js'
  import { flowReadings } from '$lib/state/flow'
  import { CAP_API_PASSTHROUGH } from '$lib/protocol/contract'
  import EvPanel from './EvPanel.svelte'
  import type { SiteStore } from '$lib/state/site.svelte'

  interface Props {
    site: SiteStore
    /**
     * Whether this view is the one on screen.
     *
     * The shell hides Now rather than destroying it while another tab is up,
     * so without this the 1 Hz stream would keep feeding a display-none SVG
     * for as long as someone reads their history. The feed below reads the
     * current fields the moment this turns true, so nothing is missed by
     * having skipped the ones nobody could see.
     */
    active?: boolean
    /**
     * What to do when no carrier could be built. Null while one exists.
     *
     * The difference decides what this screen may promise: with a carrier,
     * waiting is genuinely the right thing to do, and without one nothing is
     * happening at all.
     */
    connectHelp?: string | null
    /**
     * Open the pairing screen from a phone that already has a home.
     *
     * The one screen that can put back a missing key, spend a code the box
     * read out, or open the sealed copy — and until this existed it was
     * mounted only for a phone pointed at no home at all. Every state below
     * that offers it is a state where waiting heals nothing, which is what
     * makes an offer the honest thing and a promise to keep trying a lie.
     */
    wayBack?: (() => void) | null
  }

  let { site, active = true, connectHelp = null, wayBack = null }: Props = $props()

  // Live is three claims at once, and every one has failed on its own: a
  // session still connecting, a cache being shown, and a stream whose socket
  // is open while its frames — or one inverter behind them — have gone
  // quiet. That last one is the exact case the static switch exists for,
  // and phase and carrier cannot see it.
  const live = $derived(
    site.session.phase === 'streaming' && site.carrier !== 'cache' && site.srcState === 'live'
  )

  let flow = $state<FtwEnergyFlowElement | null>(null)

  // The component takes data by method, the way the dashboard feeds it.
  // An effect rather than an attribute because setReadings() is the
  // component's whole API, and inventing a second one would fork it. Only
  // while this view is the one on screen — fed hidden it is 1 Hz of work
  // nobody can see — and because the effect reads the fields as they are
  // when `active` returns, coming back starts from the present.
  $effect(() => {
    if (active) flow?.setReadings(flowReadings(site.session.fields))
  })

  /** The charger's sheet, opened by a tap on its bubble. */
  let evOpen = $state(false)

  // The hero says which bubble was tapped; only the charger's opens
  // anything, and only when the session can actually read the box's API —
  // a panel that could never fill would be a door painted on a wall.
  $effect(() => {
    const el = flow
    if (!el) return
    const onPlanet = (e: Event) => {
      const role = (e as CustomEvent<{ role?: string }>).detail?.role
      if (role === 'ev' && untrack(() => site).session.caps.has(CAP_API_PASSTHROUGH)) {
        evOpen = true
      }
    }
    el.addEventListener('ftw-planet-click', onPlanet)
    return () => el.removeEventListener('ftw-planet-click', onPlanet)
  })

  /**
   * The boot phase, said in this screen's own voice.
   *
   * The wire's names are shared with the box and stable for machines —
   * 'vacuum' is a database being compacted, not a sentence anyone should
   * meet on their phone. The box sends codes; this app owns all prose, and
   * a phase this app does not know is still a box getting ready.
   */
  function bootWords(phase: string): string {
    switch (phase) {
      case 'vacuum':
        return 'tidying its records'
      case 'migrate':
        return 'bringing its records up to date'
      case 'drivers':
        return 'waking the equipment'
      default:
        return 'getting ready'
    }
  }
</script>

{#if site.session.phase === 'booting'}
  <section class="empty">
    <h1>Your box is starting</h1>
    <p>
      This can take a few minutes after an update while it tidies its database.
      Nothing is wrong — it will appear here as soon as it is ready.
    </p>
    {#if site.session.boot}
      <p class="note">{bootWords(site.session.boot.phase)} · {site.session.boot.pct}%</p>
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
    <!-- The box stopped taking this key and said so, which is the one case
         where it does say so. Whoever is standing at it can let this phone
         back in with a code from its screen, so the floor is offered here as
         well — quietly, because being let back in is the owner's decision and
         not this phone's. -->
    {#if wayBack && site.session.terminated?.reason === 'revoked'}
      <button class="quiet" onclick={wayBack}>Your box won't let this phone in?</button>
    {/if}
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
    {#if wayBack}
      {#if connectHelp}
        <!-- No carrier was built at all, so nothing is being retried and no
             amount of waiting changes that. This is the only screen in the
             app where the person has to act, and it is the only one with a
             button on it. -->
        <button class="primary" onclick={wayBack}>Get this phone back in</button>
      {:else}
        <!-- The box is quiet, and quiet is what a refused handshake sounds
             like — the box answers one with silence on purpose. So this asks
             rather than diagnoses: it is equally true of a box that is off,
             and the app goes on trying either way. -->
        <button class="quiet" onclick={wayBack}>Your box won't let this phone in?</button>
      {/if}
    {/if}
  </section>
{:else}
  <!-- Cached readings, and no carrier to replace them with fresher ones. The
       band above dates what is on screen honestly, but a house that can never
       move again is not a freshness problem — and this branch used to be the
       one place the sentence never appeared, so a phone with a cache and no
       key showed a still house and no way in at all. -->
  {#if connectHelp}
    <div class="banner">
      <p>{connectHelp}</p>
      {#if wayBack}
        <button class="quiet" onclick={wayBack}>Get this phone back in</button>
      {/if}
    </div>
  {/if}

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

  {#if evOpen}
    <EvPanel {site} onclose={() => (evOpen = false)} />
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
    display: flex;
    flex-direction: column;
    align-items: flex-start;
    gap: var(--space-2);
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

  /* The same pair of weights the pairing screen uses, because they lead to the
     same screen: the primary is for a phone that cannot get in at all, and the
     quiet one is a question asked while the app is still trying. */
  .quiet {
    color: var(--fg-dim);
    font-size: 14px;
    text-align: left;
  }

  .banner .quiet {
    font-size: 13px;
    text-decoration: underline;
    text-underline-offset: 3px;
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
