<!--
  App shell.

  Paints before any data arrives and never blocks on a network round trip.
  In development it attaches a simulated box so the whole client can be built
  without hardware; in production the carrier comes from enrollment.
-->
<script lang="ts">
  import { onMount, untrack } from 'svelte'
  import FreshnessBand from '$lib/ui/FreshnessBand.svelte'
  import InstallHint from '$lib/ui/InstallHint.svelte'
  import UpdateLine from '$lib/ui/UpdateLine.svelte'
  import Now from '$views/Now.svelte'
  import Plan from '$views/Plan.svelte'
  import Pair from '$views/Pair.svelte'
  import { SiteStore } from '$lib/state/site.svelte'
  import { Router } from '$lib/state/route.svelte'

  const site = new SiteStore(__APP_BUILD__)
  const router = new Router()

  /** Reserved for the development simulator so a real pairing never collides. */
  const SIM_SITE_ID = 'sim-0001'

  // Not awaited: the shell paints now, and cached readings land a frame or
  // two later. The read itself was started by the inline script in
  // index.html, before this bundle was even parsed.
  let siteId = $state<string | null>(localStorage.getItem('ftw.site'))

  // Read once at startup, on purpose: this is the launch path, not a reaction
  // to a value that changes. Pairing calls start() itself.
  const initialSiteId = untrack(() => siteId)
  if (initialSiteId) void site.start(initialSiteId)

  /**
   * Landing on a pairing link, from a camera or a shared URL.
   *
   * With nothing paired this is checked synchronously, so the pairing screen
   * is what paints. With a site already paired the home paints first and the
   * fragment is judged in the background: after a successful pairing the
   * /p#… URL is what the browser reloads and restores, carrying a code that
   * was spent the moment it worked — re-running it would show the owner a
   * pairing error for a house they are standing in. Only a fragment that
   * points at a *different* box is a genuine invitation.
   */
  const rawFragment = location.pathname === '/p' ? location.hash : null
  let pairingFragment = $state(initialSiteId ? null : rawFragment)

  if (rawFragment && initialSiteId) {
    void import('$lib/identity/landing').then(async ({ fragmentTarget }) => {
      const target = await fragmentTarget(rawFragment)
      if (target !== null && target !== initialSiteId) {
        pairingFragment = rawFragment
      } else {
        // Same box or nothing at all: a leftover, not an invitation.
        history.replaceState(null, '', '/')
      }
    })
  }

  /** Nothing paired and nothing cached: the only screen is pairing. */
  const needsPairing = $derived(!siteId && !site.paired)

  onMount(() => {
    // The last chance to persist. 'visibilitychange' rather than 'unload',
    // which iOS does not reliably fire when an app is swiped away.
    const onHide = () => {
      if (document.visibilityState === 'hidden') void site.persistNow()
    }
    document.addEventListener('visibilitychange', onHide)
    const unlisten = router.listen()

    let stop: (() => void) | undefined

    // The simulated box has a reserved id, so a real pairing on the same
    // browser takes the relay path instead. Dynamic import keeps the simulator
    // out of production bundles entirely.
    const useSimulator = import.meta.env.DEV && (!initialSiteId || initialSiteId === SIM_SITE_ID)

    if (useSimulator) {
      void import('$lib/dev/simulated-site').then(({ attachSimulatedSite }) => {
        siteId = SIM_SITE_ID
        localStorage.setItem('ftw.site', SIM_SITE_ID)
        // Only when the launch path did not already start it: a second start
        // re-reads IndexedDB on the very path that exists to touch it once.
        if (!initialSiteId) void site.start(SIM_SITE_ID)
        stop = attachSimulatedSite(site).stop
      })
    } else if (initialSiteId) {
      // The passkey prompt lands here, after the first paint — never before.
      void connect(initialSiteId)
    }

    return () => {
      document.removeEventListener('visibilitychange', onHide)
      unlisten()
      stop?.()
      site.destroy()
    }
  })
  async function connect(id: string) {
    try {
      const { connectToSite } = await import('$lib/state/connect')
      site.connect(await connectToSite(id))
    } catch {
      // The cached readings stay on screen with an honest age. There is no
      // "try again" button because the carrier reconnects on its own; this
      // only covers the passkey being dismissed or the vault being empty.
    }
  }

  function onPaired(pairedSiteId: string) {
    siteId = pairedSiteId
    // The /p#… URL just did its one job. Left in place it becomes the URL
    // the browser reloads and restores — with a spent code — which is how
    // an owner ends up on a pairing screen for a house they are standing in.
    if (location.pathname === '/p') history.replaceState(null, '', '/')
    pairingFragment = null
    void site.start(pairedSiteId)
    void connect(pairedSiteId)
  }
</script>

<div class="app">
  <!-- Freshness describes data from a box. With nothing paired there is no
       box and no data, so the band would be answering a question nobody
       asked — and "showing last known" would be a plain lie. -->
  {#if site.paired}
    <FreshnessBand
      carrier={site.carrier}
      srcState={site.srcState}
      ageMs={site.ageMs}
      phase={site.session.phase}
    />
  {/if}

  <UpdateLine />

  <main>
    {#if needsPairing || pairingFragment}
      <Pair fragment={pairingFragment} onPaired={(s) => onPaired(s.siteId)} />
    {:else if router.current === 'plan'}
      <Plan {site} />
    {:else if router.current === 'history'}
      <!-- Loaded on demand: the chart, its canvas and the tile cache must not
           sit on the path to the first frame of the app. -->
      {#await import('$views/History.svelte') then module}
        {@const History = module.default}
        <History {site} />
      {/await}
    {:else}
      <Now {site} />
    {/if}
  </main>

  <!-- Three screens, so three buttons. The hash already works and the back
       button comes free; a router library would add a matcher and a history
       stack to decide between three names. -->
  {#if site.paired}
    <nav aria-label="Views">
      <button
        type="button"
        aria-current={router.current === 'now' ? 'page' : undefined}
        onclick={() => router.go('now')}>Now</button
      >
      <button
        type="button"
        aria-current={router.current === 'plan' ? 'page' : undefined}
        onclick={() => router.go('plan')}>Plan</button
      >
      <button
        type="button"
        aria-current={router.current === 'history' ? 'page' : undefined}
        onclick={() => router.go('history')}>History</button
      >
    </nav>
  {/if}

  <InstallHint />
</div>

<style>
  .app {
    display: flex;
    flex-direction: column;
    min-height: 100dvh;
  }

  main {
    flex: 1;
    overflow-y: auto;
    overscroll-behavior-y: contain;
  }

  /* At the bottom because that is where a thumb is, and above the home
     indicator because that is where the phone puts its own. */
  nav {
    display: flex;
    gap: var(--space-1);
    padding: var(--space-2) var(--space-3);
    padding-bottom: calc(var(--space-2) + env(safe-area-inset-bottom));
    border-top: 1px solid var(--line-soft);
    background: var(--surface-sunken);
  }

  nav button {
    flex: 1;
    border-radius: var(--radius-sm);
    font-family: var(--mono);
    font-size: 11px;
    letter-spacing: 0.1em;
    text-transform: uppercase;
    color: var(--fg-muted);
    transition: color var(--motion-fast) var(--ease), background var(--motion-fast) var(--ease);
  }

  nav button[aria-current='page'] {
    background: var(--surface-elevated);
    color: var(--fg);
  }
</style>
