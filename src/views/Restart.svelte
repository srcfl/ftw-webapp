<!--
  Restart — ask this box to come back up, from the phone.

  Not a setting. The Box screen is about the pairing, and this is a
  recovery act on that same box: a device stuck after a blip, and the
  owner is not at home. It lives here because this is the screen that
  already names the box, and because a restart is not a preference to
  hunt for.

  Owner only, with a step-up, because the box prices POST /api/restart
  as configure. A viewer is shown nothing. An old box without the
  passthrough is shown nothing — the session cannot carry the route.

  Confirm before sending. A stray tap that bounced the process would
  drop every phone for a minute, and the confirm is the same shape as
  signing out on this screen.
-->
<script lang="ts">
  import { callBox, BoxApiError } from '$lib/state/box-api'
  import type { SiteStore } from '$lib/state/site.svelte'

  interface Props {
    site: SiteStore
  }

  let { site }: Props = $props()

  /** From contract/registry.yaml. Absent means this box has no passthrough. */
  const CAP_PASSTHROUGH = 'api.passthrough'

  const canAsk = $derived(site.canConfigure && site.session.caps.has(CAP_PASSTHROUGH))

  type Stage = 'idle' | 'confirming' | 'restarting'
  let stage = $state<Stage>('idle')
  let error = $state<string | null>(null)

  async function restart(): Promise<void> {
    if (stage === 'restarting') return
    error = null
    stage = 'restarting'
    try {
      await callBox<{ status?: unknown }>(site, { method: 'POST', path: '/api/restart' })
    } catch (err) {
      stage = 'idle'
      error = err instanceof BoxApiError ? err.help : "That didn't work. Nothing has changed."
    }
  }
</script>

{#if site.heardFromBox && canAsk}
  <hr />
  {#if stage === 'confirming'}
    <h2>Restart this box?</h2>
    <p>
      The software restarts. Devices keep running on their own until it comes
      back, usually within a minute. This phone reconnects by itself.
    </p>
    <button class="danger" onclick={() => void restart()}>Restart now</button>
    <button class="quiet" onclick={() => (stage = 'idle')}>Cancel</button>
  {:else if stage === 'restarting'}
    <h2>Restarting</h2>
    <p>Your box is coming back on its own. This usually takes a minute.</p>
  {:else}
    <h2>Restart</h2>
    <p>
      Restarts the software on this box. Use it when a device is stuck and will
      not come back on its own.
    </p>
    <button class="quiet outline" onclick={() => (stage = 'confirming')}>Restart this box</button>
  {/if}
  {#if error}
    <p class="problem">{error}</p>
  {/if}
{/if}

<style>
  h2 {
    font-size: 17px;
    font-weight: 500;
    letter-spacing: -0.01em;
    margin-top: var(--space-2);
  }

  p {
    color: var(--fg-dim);
    max-width: 30rem;
  }

  .problem {
    color: var(--fresh-stale);
  }

  .quiet {
    color: var(--fg-dim);
    font-size: 14px;
  }

  .outline {
    border: 1px solid var(--line);
    border-radius: var(--radius-sm);
    padding: 0 var(--space-4);
    min-height: 34px;
  }

  .danger {
    border: 1px solid var(--fresh-stale);
    color: var(--fresh-stale);
    border-radius: var(--radius-sm);
    padding: 0 var(--space-5);
    font-weight: 500;
  }

  hr {
    width: 100%;
    height: 1px;
    border: 0;
    background: var(--line-soft);
    margin: var(--space-3) 0 0;
  }
</style>
