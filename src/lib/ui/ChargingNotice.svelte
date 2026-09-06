<script lang="ts">
  import { untrack } from 'svelte'
  import { watchCharging, type ChargingSnapshot } from '$lib/state/charging-watch'
  import { evStatusSentence, evPlanSentence } from '$lib/format/ev'
  import type { SiteStore } from '$lib/state/site.svelte'
  let { site }: { site: SiteStore } = $props()
  let snapshot = $state<ChargingSnapshot>({ points: [], fresh: false })
  $effect(() => watchCharging(untrack(() => site), next => { snapshot = next }))
  const fresh = $derived(snapshot.fresh && site.session.phase === 'streaming')
</script>

{#each snapshot.points.filter(lp => lp.pluggedIn) as lp (lp.id)}
  <section class="charging-notice" aria-label="Car connection">
    <div class="title" role="status">{fresh && lp.charger?.available !== false ? 'Car connected' : 'Car status is out of date'}</div>
    <p>{fresh && lp.charger?.available !== false ? evStatusSentence(lp) : 'Waiting for current charger status. The last reading cannot confirm charging.'}</p>
    {#if fresh && lp.charger?.available !== false && evPlanSentence(lp)}<p class="detail">{evPlanSentence(lp)}</p>{/if}
    <a href={`#/now?charger=${encodeURIComponent(lp.id)}`}>Check charging{lp.socSource !== 'vehicle' ? ' and battery level' : ''}</a>
  </section>
{/each}

<style>
.charging-notice { margin: var(--space-3) var(--space-4); padding: var(--space-3); border: 1px solid var(--line); border-radius: var(--radius-md); background: var(--surface-raised); font-size: 14px; }
.title { font-weight: 500; margin-bottom: var(--space-2); }
p { margin: 0 0 var(--space-2); }
.detail { color: var(--fg-dim); }
a { color: var(--accent); text-decoration: underline; text-underline-offset: 3px; }
</style>
