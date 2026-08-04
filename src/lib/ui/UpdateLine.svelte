<!--
  A newer build is parked and starts at the next launch.

  One line, in the same grammar as the freshness band, because it is the same
  kind of fact: something about the app's state that the user may want to know
  and does not have to act on. It is not a modal, and there is no button —
  the update installs itself the next time the app is opened from cold, so a
  button could only offer to make that happen a few minutes sooner in exchange
  for reloading the screen someone is currently looking at.
-->
<script lang="ts">
  import { serviceWorker } from '$lib/pwa/service-worker.svelte'
</script>

{#if serviceWorker.waiting}
  <div class="line" role="status">A new version is ready · it starts next time you open FTW</div>
{/if}

<style>
  .line {
    padding: var(--space-2) var(--space-4);
    font-family: var(--mono);
    font-size: 11px;
    letter-spacing: 0.06em;
    color: var(--fg-muted);
    border-bottom: 1px solid var(--line-soft);
    background: var(--surface-sunken);
  }
</style>
