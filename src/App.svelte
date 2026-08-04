<!--
  App shell.

  Scaffold: the carrier, store and protocol layers are not wired yet, so this
  renders the Now view against a stub. What is real here is the shape — the
  freshness band above content, the shell painting before any data arrives,
  and no loading state on the path to first paint.
-->
<script lang="ts">
  import FreshnessBand from '$lib/ui/FreshnessBand.svelte'
  import Now from '$views/Now.svelte'
  import type { CarrierState, SourceState } from '$lib/protocol/types'

  // Stub until the carrier lands. Deliberately not 'live': the app must
  // never claim a connection it does not have, including while being built.
  const carrier: CarrierState = 'none'
  const srcState: SourceState = 'never'
  const ageMs = NaN
</script>

<div class="app">
  <FreshnessBand {carrier} {srcState} {ageMs} />
  <main>
    <Now />
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
