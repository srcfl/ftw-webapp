<!--
  The charger, behind a tap on its bubble.

  A sheet over the Now screen rather than a fifth tab: the charger is part
  of the house, and the way in is the house diagram. Everything on it is a
  fact the box served — what flows now, what this session has delivered,
  what the schedule says, and when the optimiser intends to charge next.
  Round two puts an editor under the schedule line; nothing here commands.
-->
<script lang="ts">
  import { untrack, onDestroy } from 'svelte'
  import { LoadpointsStore } from '$lib/state/loadpoints.svelte'
  import { askWhenLive } from '$lib/state/ask.svelte'
  import { callBox, BoxApiError } from '$lib/state/box-api'
  import {
    evStatusSentence,
    evScheduleSentence,
    evSessionSentence,
    utcMinutesToLocalInput,
    localInputToUtcMinutes,
    DAY_LABELS,
    type Loadpoint,
  } from '$lib/format/ev'
  import { formatPower } from '$lib/format/power'
  import { portal } from '$lib/ui/portal'
  import type { SiteStore } from '$lib/state/site.svelte'

  interface Props {
    site: SiteStore
    /** Close the sheet. The panel never decides that itself. */
    onclose: () => void
  }

  let { site, onclose }: Props = $props()

  const store = new LoadpointsStore(untrack(() => site))
  onDestroy(() => store.destroy())

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

  /**
   * The schedule under edit, or null while the panel only reads.
   *
   * One draft, saved in one PUT: every field rides together, so a save
   * costs exactly one passkey ceremony rather than one per field. Nothing
   * is applied optimistically — the box's answer repaints the panel, and
   * until it does the old schedule stands on screen as the truth it is.
   */
  let draft = $state<{ lpId: string; time: string; days: number; socPct: number } | null>(null)
  let saving = $state(false)
  let saveError = $state<string | null>(null)

  function beginEdit(lp: Loadpoint): void {
    saveError = null
    // The wire's zero means every day; the draft holds all seven bits
    // instead, so tapping Saturday off an every-day schedule means "not
    // Saturday" — with a raw zero it would have meant "only Saturday",
    // the exact opposite of the thumb's intent.
    const wireDays = lp.schedule?.days ?? 0
    draft = {
      lpId: lp.id,
      time: utcMinutesToLocalInput(lp.schedule?.timeOfDayMinUtc ?? 6 * 60),
      days: wireDays === 0 ? 0x7f : wireDays & 0x7f,
      socPct: Math.round(lp.schedule?.socPct ?? lp.targetSocPct ?? 80),
    }
  }

  function toggleDay(bit: number): void {
    if (draft) draft.days ^= 1 << bit
  }

  async function saveDraft(): Promise<void> {
    if (!draft) return
    const minUtc = localInputToUtcMinutes(draft.time)
    if (minUtc === null) {
      saveError = 'That is not a time this app understands.'
      return
    }
    saving = true
    saveError = null
    try {
      await callBox(untrack(() => site), {
        method: 'PUT',
        path: `/api/loadpoints/${draft.lpId}/schedule`,
        body: {
          soc_pct: draft.socPct,
          time_of_day_min_utc: minUtc,
          recurring: true,
          // All seven days is the wire's zero — the canonical spelling of
          // "every day", and what every schedule saved before masks
          // existed already carries.
          days: draft.days === 0x7f ? 0 : draft.days & 0x7f,
        },
      })
      draft = null
      await store.load()
    } catch (err) {
      saveError =
        err instanceof BoxApiError ? err.help : "Your box didn't answer. Nothing was changed."
    } finally {
      saving = false
    }
  }

  async function removeSchedule(lpId: string): Promise<void> {
    saving = true
    saveError = null
    try {
      await callBox(untrack(() => site), {
        method: 'DELETE',
        path: `/api/loadpoints/${lpId}/schedule`,
      })
      draft = null
      await store.load()
    } catch (err) {
      saveError =
        err instanceof BoxApiError ? err.help : "Your box didn't answer. Nothing was changed."
    } finally {
      saving = false
    }
  }
</script>

<svelte:window {onkeydown} />

<!-- Parked on the app shell, with the live-line sheet: inside the scrolling
     view a "fixed" sheet is the bottom of the page. -->
<div class="layer" use:portal>
<!-- The backdrop is the close control, as every sheet's is. The sheet itself
     is a dialog, so what is behind it is inert to a screen reader. -->
<div class="backdrop" onclick={onclose} aria-hidden="true"></div>

<div class="sheet" role="dialog" aria-modal="true" aria-label="EV charger" tabindex="-1">
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

        <!-- The door, not the panel, decides: the button expresses intent
             with an expiry, and the box revalidates before anything moves.
             Hidden from viewers as presentation — the box's refusal is the
             actual gate. Absent when the bay is empty, because "charge now"
             with no cable is a promise nobody can keep. -->
        {#if site.canConfigure && lp.pluggedIn}
          <div class="actions">
            {#if lp.manualActive}
              <button
                class="quiet outline"
                disabled={store.command.kind === 'sending'}
                onclick={() => void store.stopCharging(lp)}
              >
                Stop charging
              </button>
            {:else}
              <button
                class="primary"
                disabled={store.command.kind === 'sending'}
                onclick={() => void store.chargeNow(lp)}
              >
                {store.command.kind === 'sending' ? 'Asking your box…' : 'Charge now'}
              </button>
            {/if}
          </div>
          {#if store.command.kind === 'applied'}
            <p class="hint">
              {store.command.holding
                ? 'Charging at full power. Stop it and the plan takes back over.'
                : 'Stopped — the plan decides again.'}
            </p>
          {:else if store.command.kind === 'unconfirmed'}
            <p class="hint">Your box took it. The charger hasn't confirmed yet.</p>
          {:else if store.command.kind === 'failed'}
            <p class="hint">{store.command.help}</p>
          {/if}
        {/if}

        {#if draft?.lpId === lp.id}
          <!-- One draft, one save, one ceremony. The box revalidates and
               answers; what it stores is what the panel then rereads. -->
          <div class="editor">
            <div class="row">
              <span class="label">Ready by</span>
              <input type="time" bind:value={draft.time} disabled={saving} />
            </div>
            <div class="chips" role="group" aria-label="Days">
              {#each DAY_LABELS as day, bit (day)}
                <button
                  class="chip"
                  aria-pressed={(draft.days & (1 << bit)) !== 0}
                  disabled={saving}
                  onclick={() => toggleDay(bit)}
                >
                  {day}
                </button>
              {/each}
            </div>
            <div class="row">
              <span class="label">Charge to</span>
              <input
                type="number"
                min="10"
                max="100"
                step="5"
                bind:value={draft.socPct}
                disabled={saving}
              />
              <span>%</span>
            </div>
            <div class="actions">
              <!-- Every day off is not a schedule — the wire has no way to
                   say it, and zero would silently mean the opposite. -->
              <button
                class="primary"
                disabled={saving || draft.days === 0}
                onclick={() => void saveDraft()}
              >
                {saving ? 'Saving…' : 'Save schedule'}
              </button>
              <button class="quiet" disabled={saving} onclick={() => (draft = null)}>
                Cancel
              </button>
              {#if lp.schedule}
                <button
                  class="quiet"
                  disabled={saving}
                  onclick={() => void removeSchedule(lp.id)}
                >
                  Remove
                </button>
              {/if}
            </div>
            {#if saveError}
              <p class="hint">{saveError}</p>
            {/if}
          </div>
        {:else}
          {#if evScheduleSentence(lp)}
            <div class="row">
              <span class="label">Schedule</span>
              <span>{evScheduleSentence(lp)}</span>
              {#if site.canConfigure}
                <button class="quiet edit" onclick={() => beginEdit(lp)}>Change</button>
              {/if}
            </div>
          {:else if store.loaded && site.canConfigure}
            <div class="row">
              <span class="label">Schedule</span>
              <button class="quiet edit" onclick={() => beginEdit(lp)}>
                Set a charging schedule
              </button>
            </div>
          {/if}
          {#if saveError}
            <p class="hint">{saveError}</p>
          {/if}
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
</div>
</div>

<style>
  .layer {
    isolation: isolate;
  }

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
    overflow-anchor: none;
    outline: none;
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

  .editor {
    display: flex;
    flex-direction: column;
    gap: var(--space-3);
    border-left: 2px solid var(--accent);
    padding-left: var(--space-3);
  }

  .editor input {
    background: var(--surface-sunken);
    border: 1px solid var(--line);
    border-radius: var(--radius-xs);
    color: var(--fg);
    font-family: var(--num);
    font-size: 14px;
    padding: var(--space-1) var(--space-2);
  }

  .editor input[type='number'] {
    /* Three digits plus the browser's own spinner, or "84" clips to "8". */
    width: 8ch;
  }

  .chips {
    display: flex;
    gap: var(--space-1);
    flex-wrap: wrap;
  }

  /* The same honest pattern as every exclusive-ish choice in the app:
     buttons that say whether they are pressed, no radio ceremony. A zero
     mask means every day, so with nothing chosen every chip reads on. */
  .chip {
    font-size: 12px;
    font-family: var(--mono);
    padding: var(--space-1) var(--space-2);
    border: 1px solid var(--line);
    border-radius: var(--radius-xs);
    color: var(--fg-dim);
  }

  .chip[aria-pressed='true'] {
    background: var(--surface-elevated);
    color: var(--fg);
    border-color: var(--accent);
  }

  .actions {
    display: flex;
    gap: var(--space-3);
    align-items: center;
  }

  .primary {
    background: var(--accent);
    color: var(--on-accent);
    border-radius: var(--radius-sm);
    padding: var(--space-1) var(--space-4);
    font-weight: 500;
  }

  .quiet {
    color: var(--fg-dim);
    font-size: 13px;
  }

  .edit {
    text-decoration: underline;
    text-underline-offset: 3px;
  }
</style>
