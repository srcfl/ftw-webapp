<!--
  The charger, behind a tap on its bubble.

  A sheet over the Now screen rather than a fifth tab: the charger is part
  of the house, and the way in is the house diagram. Everything on it is a
  fact the box served — what flows now, what this session has delivered,
  what the schedule says, and when the optimiser intends to charge next.
  Round two puts an editor under the schedule line; nothing here commands.
-->
<script lang="ts">
  import { untrack } from 'svelte'
  import { LoadpointsStore } from '$lib/state/loadpoints.svelte'
  import { askWhenLive } from '$lib/state/ask.svelte'
  import { evStatusSentence, evScheduleSentence, evSessionSentence } from '$lib/format/ev'
  import { formatPower } from '$lib/format/power'
  import type { SiteStore } from '$lib/state/site.svelte'

  interface Props {
    site: SiteStore
    /** Close the sheet. The panel never decides that itself. */
    onclose: () => void
  }

  let { site, onclose }: Props = $props()

  const store = new LoadpointsStore(untrack(() => site))

  // Fresh while open: the ask name carries a minute epoch, so askWhenLive
  // re-asks as the window ages — the same rule History and Energy follow.
  // The panel mounts when it opens and unmounts when it closes, so the
  // ticker lives exactly as long as someone is looking.
  let epochMin = $state(Math.floor(Date.now() / 60_000))
  $effect(() => {
    const t = setInterval(() => {
      epochMin = Math.floor(Date.now() / 60_000)
    }, 15_000)
    return () => clearInterval(t)
  })

  askWhenLive(
    untrack(() => site),
    () => `loadpoints ${epochMin}`,
    () => store.load()
  )

  function clock(ms: number): string {
    return new Date(ms).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })
  }

  function onkeydown(e: KeyboardEvent) {
    if (e.key === 'Escape') onclose()
  }
</script>

<svelte:window {onkeydown} />

<!-- The backdrop is the close control, as every sheet's is. The sheet itself
     is a dialog, so what is behind it is inert to a screen reader. -->
<div class="backdrop" onclick={onclose} aria-hidden="true"></div>

<section class="sheet" role="dialog" aria-modal="true" aria-label="EV charger">
  <header>
    <h2>EV charger</h2>
    <button class="close" onclick={onclose} aria-label="Close">Close</button>
  </header>

  {#if store.error}
    <p class="note">{store.error}</p>
  {/if}

  {#if !store.loaded && !store.error}
    <p class="note">Reading your box…</p>
  {:else}
    {#each store.points as lp (lp.id)}
      <div class="charger">
        <p class="status">{evStatusSentence(lp)}</p>

        {#if evSessionSentence(lp)}
          <p class="session">{evSessionSentence(lp)}</p>
        {/if}

        {#if lp.boostActive}
          <p class="badge">Battery boost is on — the house battery is helping the car.</p>
        {/if}

        {#if evScheduleSentence(lp)}
          <div class="row">
            <span class="label">Schedule</span>
            <span>{evScheduleSentence(lp)}</span>
          </div>
        {/if}
        {#if lp.surplusOnly}
          <p class="hint">Charges from spare solar only.</p>
        {/if}

        {#if (store.windows[lp.id] ?? []).length > 0}
          <div class="windows">
            <span class="label">Charging ahead</span>
            <ul>
              {#each store.windows[lp.id] ?? [] as w (w.fromMs)}
                <li>
                  <span class="when">{clock(w.fromMs)}–{clock(w.toMs)}</span>
                  <span class="power">
                    up to {formatPower(w.peakW).text} {formatPower(w.peakW).unit}
                  </span>
                </li>
              {/each}
            </ul>
          </div>
        {:else if store.planMissing}
          <!-- The plan read failed while the charger read did not. An empty
               list here would claim an idle week the app has not read. -->
          <p class="hint">Charging times aren't readable right now.</p>
        {/if}
      </div>
    {:else}
      <!-- The box answered, and the answer is: no charger. The bubble that
           opened this panel draws from a live field, so meeting this means
           the charger left between two reads — say so plainly. -->
      <p class="note">Your box no longer reports a charger.</p>
    {/each}
  {/if}
</section>

<style>
  .backdrop {
    position: fixed;
    inset: 0;
    background: rgb(0 0 0 / 45%);
    z-index: 40;
  }

  .sheet {
    position: fixed;
    left: 0;
    right: 0;
    bottom: 0;
    z-index: 41;
    background: var(--surface-raised);
    border-top: 1px solid var(--line);
    border-radius: var(--radius-lg) var(--radius-lg) 0 0;
    padding: var(--space-4) var(--space-4)
      calc(var(--space-5) + env(safe-area-inset-bottom, 0px));
    display: flex;
    flex-direction: column;
    gap: var(--space-3);
    max-height: 75dvh;
    overflow-y: auto;
  }

  header {
    display: flex;
    align-items: baseline;
    justify-content: space-between;
  }

  h2 {
    font-size: 13px;
    font-weight: 500;
    letter-spacing: 0.08em;
    text-transform: uppercase;
    color: var(--fg-dim);
  }

  .close {
    color: var(--fg-dim);
    font-size: 14px;
  }

  .charger {
    display: flex;
    flex-direction: column;
    gap: var(--space-3);
  }

  .status {
    font-size: 20px;
    line-height: 1.3;
    letter-spacing: -0.01em;
  }

  .session {
    color: var(--fg-dim);
    font-size: 14px;
  }

  .badge {
    font-size: 13px;
    color: var(--fg-dim);
    border-left: 2px solid var(--accent);
    padding-left: var(--space-3);
  }

  .row {
    display: flex;
    gap: var(--space-3);
    align-items: baseline;
    font-size: 14px;
  }

  .label {
    font-family: var(--mono);
    font-size: 11px;
    letter-spacing: 0.06em;
    text-transform: uppercase;
    color: var(--fg-muted);
  }

  .hint {
    font-size: 13px;
    color: var(--fg-muted);
  }

  .windows {
    display: flex;
    flex-direction: column;
    gap: var(--space-2);
  }

  .windows ul {
    list-style: none;
    display: flex;
    flex-direction: column;
    gap: var(--space-1);
  }

  .windows li {
    display: flex;
    justify-content: space-between;
    gap: var(--space-3);
    font-size: 14px;
  }

  .when {
    font-family: var(--num);
  }

  .power {
    color: var(--fg-dim);
  }

  .note {
    color: var(--fg-dim);
    font-size: 14px;
  }
</style>
