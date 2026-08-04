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

  onMount(() => {
    if (!import.meta.env.DEV) return

    // Dynamic so the simulator never reaches a production bundle.
    let stop: (() => void) | undefined
    void import('$lib/dev/simulated-site').then(({ attachSimulatedSite }) => {
      stop = attachSimulatedSite(site).stop
    })

    return () => {
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
    <FreshnessBand carrier={site.carrier} srcState={site.srcState} ageMs={site.ageMs} />
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
