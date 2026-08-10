<!--
  A newer build is parked and can take over now.

  One line, in the same grammar as the freshness band, because it is the same
  kind of fact: something about the app's state that the user may want to know.
  It is not a modal. The button is the explicit safe moment to switch the
  whole cached build and reload once; nobody has to force-close an iOS app.
-->
<script lang="ts">
  import { applyAppUpdate, serviceWorker } from '$lib/pwa/service-worker.svelte'
</script>

{#if serviceWorker.waiting}
  <div class="line">
    <span role="status">{serviceWorker.applying ? 'Updating FTW…' : 'A new version is ready'}</span>
    <button type="button" disabled={serviceWorker.applying} onclick={() => applyAppUpdate()}>
      {serviceWorker.applying ? 'Updating…' : 'Update'}
    </button>
  </div>
{/if}

<style>
  .line {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: var(--space-3);
    min-height: 44px;
    padding: 0 var(--space-3) 0 var(--space-4);
    font-family: var(--mono);
    font-size: 11px;
    letter-spacing: 0.06em;
    color: var(--fg-muted);
    border-bottom: 1px solid var(--line-soft);
    background: var(--surface-sunken);
  }

  button {
    min-width: 72px;
    padding: 0 var(--space-3);
    border-radius: var(--radius-sm);
    color: var(--on-accent);
    background: var(--accent);
    letter-spacing: 0.04em;
    transition:
      transform var(--motion-fast) var(--ease),
      opacity var(--motion-fast) var(--ease);
  }

  button:active:not(:disabled) {
    transform: scale(0.96);
  }

  button:disabled {
    opacity: 0.65;
  }
</style>
