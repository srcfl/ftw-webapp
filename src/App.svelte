<!--
  App shell.

  Paints before any data arrives and never blocks on a network round trip.
  In development it attaches a simulated box so the whole client can be built
  without hardware; in production the carrier comes from enrollment.
-->
<script lang="ts">
  import { onMount } from 'svelte'
  import FreshnessBand from '$lib/ui/FreshnessBand.svelte'
  import Now from '$views/Now.svelte'
  import { SiteStore } from '$lib/state/site.svelte'

  const site = new SiteStore(__APP_BUILD__)

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

  <main>
    <Now {site} />
  </main>
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
    padding-bottom: env(safe-area-inset-bottom);
  }
</style>
