<!--
  App shell.

  Paints before any data arrives and never blocks on a network round trip.
  In development it attaches a simulated box so the whole client can be built
  without hardware; in production the carrier comes from enrollment.
-->
<script lang="ts">
  import { onMount } from 'svelte'
  import FreshnessBand from '$lib/ui/FreshnessBand.svelte'
  import InstallHint from '$lib/ui/InstallHint.svelte'
  import UpdateLine from '$lib/ui/UpdateLine.svelte'
  import Now from '$views/Now.svelte'
  import { SiteStore } from '$lib/state/site.svelte'
  import { Router } from '$lib/state/route.svelte'

  const site = new SiteStore(__APP_BUILD__)
  const router = new Router()

  // Not awaited: the shell paints now, and cached readings land a frame or
  // two later. The read itself was started by the inline script in
  // index.html, before this bundle was even parsed.
  const SITE_ID = localStorage.getItem('ftw.site') ?? 'sim-0001'
  void site.start(SITE_ID)

  onMount(() => {
    // The last chance to persist. 'visibilitychange' rather than 'unload',
    // which iOS does not reliably fire when an app is swiped away.
    const onHide = () => {
      if (document.visibilityState === 'hidden') void site.persistNow()
    }
    document.addEventListener('visibilitychange', onHide)
    const unlisten = router.listen()

    let stop: (() => void) | undefined
    if (import.meta.env.DEV) {
      // Dynamic so the simulator never reaches a production bundle.
      void import('$lib/dev/simulated-site').then(({ attachSimulatedSite }) => {
        localStorage.setItem('ftw.site', 'sim-0001')
        stop = attachSimulatedSite(site).stop
      })
    }

    return () => {
      document.removeEventListener('visibilitychange', onHide)
      unlisten()
      stop?.()
      site.destroy()
    }
  })
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
    {#if router.current === 'history'}
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

  <!-- Two screens, so two buttons. A router library would bring a matcher and
       a history stack to decide between them; the hash already works and the
       back button comes free. -->
  {#if site.paired}
    <nav aria-label="Views">
      <button
        type="button"
        aria-current={router.current === 'now' ? 'page' : undefined}
        onclick={() => router.go('now')}>Now</button
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
