<!--
  The charger, behind a tap on its bubble.

  A sheet over the Now screen rather than a fifth tab: the charger is part
  of the house, and the way in is the house diagram. Everything on it is a
  fact the box served — what flows now, what this session has delivered,
  what the schedule says, and when the optimiser intends to charge next.
  The controls express intent — a hold at a chosen current, a bounded boost
  from the house battery, a corrected charge level, solar surplus only — and
  the box decides; the panel repaints from what the box then reports.
-->
<script lang="ts">
  import { untrack, onDestroy } from 'svelte'
  import { LoadpointsStore, type Control, type Outcome } from '$lib/state/loadpoints.svelte'
  import { askWhenLive } from '$lib/state/ask.svelte'
  import { callBox, BoxApiError } from '$lib/state/box-api'
  import {
    evStatusSentence,
    evScheduleSentence,
    evSessionSentence,
    utcMinutesToLocalInput,
    localInputToUtcMinutes,
    chargeCurrent,
    wattsToAmps,
    currentReadout,
    boostActiveSentence,
    boostStoppedSentence,
    socSourceSentence,
    SOC_DEFAULT_PCT,
    BOOST_DURATIONS,
    BOOST_DURATION_DEFAULT_S,
    BOOST_RESERVE_DEFAULT_PCT,
    BOOST_RESERVE_MIN_PCT,
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

  const sending = $derived(store.command.kind === 'sending')

  /**
   * One sentence per thing the box did, under the control that asked. The
   * level names the figure the box read back, in the box page's own words.
   */
  function did(o: Outcome, lp: Loadpoint): string {
    switch (o) {
      case 'hold':
        return 'Done — your box holds that current now.'
      case 'release':
        return 'Stopped — the plan decides again.'
      case 'boost':
        return 'Boost on — the house battery is helping the car.'
      case 'unboost':
        return 'Boost stopped — the plan decides again.'
      case 'soc':
        return `Plan updated from ${socFor(lp)} %.`
      case 'surplus_on':
        return 'Done — the car charges from spare solar only now.'
      case 'surplus_off':
        return 'Done — the grid and the house battery may charge the car again.'
    }
  }

  /**
   * The slider's amps per charger — the panel's own until Charge now sends
   * them. Seeded the first time a charger is drawn, at the running hold's
   * current when there is one and the charger's ceiling otherwise, as the
   * box's page seeds its own slider; then left alone through rereads, so a
   * thumb mid-drag is not snapped back by the minute's ask.
   */
  let amps = $state<Record<string, number>>({})

  function heldAmps(lp: Loadpoint): number | null {
    return lp.manualActive && lp.manualChargeW !== null ? wattsToAmps(lp, lp.manualChargeW) : null
  }

  function ampsFor(lp: Loadpoint): number {
    const range = chargeCurrent(lp)
    const chosen = amps[lp.id] ?? heldAmps(lp) ?? range.maxA
    return Math.min(range.maxA, Math.max(range.minA, chosen))
  }

  /**
   * The car's level per charger while a thumb has the slider: from the
   * first move until the box has answered the release and the panel has
   * reread it. Outside that window the slider follows the box, because the
   * estimate climbs as the car charges; inside it, the minute's reread must
   * not snap the thumb from under a finger.
   */
  let socDraft = $state<Record<string, number>>({})

  function socFor(lp: Loadpoint): number {
    return socDraft[lp.id] ?? lp.socPct ?? SOC_DEFAULT_PCT
  }

  /** Written on release, as the box's page does. There is no button. */
  async function setSoc(lp: Loadpoint, pct: number): Promise<void> {
    socDraft[lp.id] = pct
    await store.setSoc(lp, pct)
    delete socDraft[lp.id]
  }

  /**
   * The switch's position while its command is out. Without it a refused
   * toggle would leave the switch on beside a box that says off: the reread
   * brings the same value back, and an unchanged value repaints nothing.
   */
  let surplusDraft = $state<Record<string, boolean>>({})

  async function setSurplusOnly(lp: Loadpoint, on: boolean): Promise<void> {
    surplusDraft[lp.id] = on
    await store.setSurplusOnly(lp, on)
    delete surplusDraft[lp.id]
  }

  /** The boost under edit: a reserve and a bound, sent as one lease. */
  let boostDraft = $state<{ lpId: string; reservePct: number; durationS: number } | null>(null)

  // What the box's own validator accepts, so the button never offers a
  // lease the box would turn down; the box still checks it.
  const boostDraftValid = $derived(
    boostDraft !== null &&
      Number.isInteger(boostDraft.reservePct) &&
      boostDraft.reservePct >= BOOST_RESERVE_MIN_PCT &&
      boostDraft.reservePct <= 100
  )

  function beginBoost(lp: Loadpoint): void {
    boostDraft = {
      lpId: lp.id,
      reservePct: BOOST_RESERVE_DEFAULT_PCT,
      durationS: BOOST_DURATION_DEFAULT_S,
    }
  }

  async function startBoost(lp: Loadpoint): Promise<void> {
    if (!boostDraft || !boostDraftValid) return
    await store.boost(lp, boostDraft.reservePct, boostDraft.durationS)
    // The editor closes on the box's yes alone; a refusal stays on screen
    // under the values that were refused.
    if (store.command.kind === 'applied') boostDraft = null
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

<!-- The fate of the last command, under the control that sent it. One
     command is in flight at a time, so the outcome belongs to exactly one. -->
{#snippet outcome(of: Control, lp: Loadpoint)}
  {#if store.command.kind === 'applied' && store.command.of === of}
    <p class="hint">{did(store.command.did, lp)}</p>
  {:else if store.command.kind === 'unconfirmed' && store.command.of === of}
    <p class="hint">Your box took it. The charger hasn't confirmed yet.</p>
  {:else if store.command.kind === 'failed' && store.command.of === of}
    <p class="hint">{store.command.help}</p>
  {/if}
{/snippet}

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
          <p class="badge">{boostActiveSentence(lp)}</p>
          {#if site.canConfigure}
            <div class="actions">
              <button class="quiet edit" disabled={sending} onclick={() => void store.stopBoost(lp)}>
                Stop boost
              </button>
            </div>
            {@render outcome('boost', lp)}
          {/if}
        {/if}

        <!-- The door, not the panel, decides: the buttons express intent
             with an expiry, and the box revalidates before anything moves.
             Hidden from viewers as presentation — the box's refusal is the
             actual gate. Absent when the bay is empty, because "charge now"
             with no cable is a promise nobody can keep. -->
        {#if site.canConfigure && lp.pluggedIn}
          {@const range = chargeCurrent(lp)}
          {@const chosen = ampsFor(lp)}
          {@const held = heldAmps(lp)}
          {@const level = socFor(lp)}
          <!-- The car's level, above the charging controls as on the box's
               own page: the estimate the plan runs from, and a slider to
               correct it. Written on release, no button; the box replans
               before it answers. Absent when the bay is empty, because
               there is no car to hold a level. -->
          <div class="control">
            <div class="row">
              <span class="label">Car is at</span>
              <span class="readout">{level} %</span>
            </div>
            <input
              class="slider"
              type="range"
              min="0"
              max="100"
              step="1"
              value={level}
              aria-label="Car's current charge, percent"
              disabled={sending}
              oninput={(e) => (socDraft[lp.id] = Number(e.currentTarget.value))}
              onchange={(e) => void setSoc(lp, Number(e.currentTarget.value))}
            />
            {#if store.command.kind === 'sending' && store.command.of === 'soc'}
              <p class="hint">Replanning from {level} %…</p>
            {:else if store.command.kind !== 'idle' && store.command.of === 'soc'}
              {@render outcome('soc', lp)}
            {:else}
              <p class="hint">{socSourceSentence(lp)}</p>
            {/if}
          </div>

          <!-- The slider is the box's own page's: whole amps between the
               charger's floor and ceiling, sent as watts for a hold that
               runs until the car is full, Stop, or an unplug. -->
          <div class="control">
            <div class="row">
              <span class="label">Charge now</span>
              <span class="readout">{currentReadout(lp, chosen)}</span>
            </div>
            <input
              class="slider"
              type="range"
              min={range.minA}
              max={range.maxA}
              step="1"
              value={chosen}
              aria-label="Charging current"
              disabled={sending}
              oninput={(e) => (amps[lp.id] = Number(e.currentTarget.value))}
            />
            <div class="actions">
              {#if lp.manualActive}
                <button
                  class="primary"
                  disabled={sending || chosen === held}
                  onclick={() => void store.chargeNow(lp, chosen)}
                >
                  {sending ? 'Asking your box…' : 'Update'}
                </button>
                <button class="quiet" disabled={sending} onclick={() => void store.stopCharging(lp)}>
                  Stop charging
                </button>
              {:else}
                <button
                  class="primary"
                  disabled={sending}
                  onclick={() => void store.chargeNow(lp, chosen)}
                >
                  {sending ? 'Asking your box…' : 'Charge now'}
                </button>
              {/if}
            </div>
            <p class="hint">
              {#if lp.manualActive}
                Charging now{held !== null ? ` at ${held} A` : ''} until the car is full. Stop it,
                or unplug, and the plan takes back over.
              {:else}
                Runs at this current until the car is full, you stop it, or you unplug.
              {/if}
            </p>
            {@render outcome('hold', lp)}
          </div>

          <!-- The boost: a bounded lease the box caps at four hours. The
               box refuses one while a hold runs or the charger is on spare
               solar only, so the offer says so up front from what the box
               served, instead of drawing a button that leads to a refusal. -->
          {#if !lp.boostActive}
            {#if boostDraft?.lpId === lp.id}
              <div class="editor">
                <div class="row">
                  <span class="label">Battery boost</span>
                  <span>Let the house battery charge the car for a while.</span>
                </div>
                <div class="row">
                  <span class="label">Keep</span>
                  <input
                    type="number"
                    min={BOOST_RESERVE_MIN_PCT}
                    max="100"
                    step="5"
                    bind:value={boostDraft.reservePct}
                    disabled={sending}
                    aria-label="House battery reserve"
                  />
                  <span>% in the house battery</span>
                </div>
                <div class="chips" role="group" aria-label="For how long">
                  {#each BOOST_DURATIONS as d (d.s)}
                    <button
                      class="chip"
                      aria-pressed={boostDraft.durationS === d.s}
                      disabled={sending}
                      onclick={() => {
                        if (boostDraft) boostDraft.durationS = d.s
                      }}
                    >
                      {d.label}
                    </button>
                  {/each}
                </div>
                <div class="actions">
                  <button
                    class="primary"
                    disabled={sending || !boostDraftValid}
                    onclick={() => void startBoost(lp)}
                  >
                    {sending ? 'Asking your box…' : 'Start boost'}
                  </button>
                  <button class="quiet" disabled={sending} onclick={() => (boostDraft = null)}>
                    Cancel
                  </button>
                </div>
                <p class="hint">
                  Ends when the time is up, the house battery reaches the reserve, or you stop it.
                </p>
                {@render outcome('boost', lp)}
              </div>
            {:else}
              <div class="row">
                <span class="label">Battery boost</span>
                {#if lp.manualActive}
                  <span class="hint">Not while charging now — stop that first.</span>
                {:else if lp.surplusOnly}
                  <span class="hint">Not while the charger uses spare solar only.</span>
                {:else}
                  <button class="quiet edit" onclick={() => beginBoost(lp)}>
                    Boost from the house battery
                  </button>
                {/if}
              </div>
              {@render outcome('boost', lp)}
            {/if}
          {/if}
        {/if}

        {#if boostStoppedSentence(lp)}
          <p class="hint">{boostStoppedSentence(lp)}</p>
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
        {#if site.canConfigure}
          <!-- A standing setting rather than a hold: it outlives an unplug,
               so it is offered whether or not a car is on the cable. The
               box refuses a boost while it is on, and the boost row above
               reads the same flag. -->
          <label class="switch">
            <input
              type="checkbox"
              role="switch"
              checked={surplusDraft[lp.id] ?? lp.surplusOnly}
              disabled={sending}
              onchange={(e) => void setSurplusOnly(lp, e.currentTarget.checked)}
            />
            <span>Charge from solar surplus only (no grid, no home battery)</span>
          </label>
          {#if store.command.kind === 'sending' && store.command.of === 'surplus'}
            <p class="hint">Asking your box…</p>
          {:else}
            {@render outcome('surplus', lp)}
          {/if}
        {:else if lp.surplusOnly}
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
    background: var(--scrim);
    z-index: var(--z-overlay);
  }

  .sheet {
    position: fixed;
    left: 0;
    right: 0;
    bottom: 0;
    z-index: var(--z-sheet);
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
    /* The sentence beside it wraps; the label does not. */
    flex-shrink: 0;
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

  .control {
    display: flex;
    flex-direction: column;
    gap: var(--space-2);
  }

  .readout {
    margin-left: auto;
    font-family: var(--num);
  }

  /* The app's one slider. The browser draws it; only the accent is ours. */
  .slider {
    width: 100%;
    margin: 0;
    accent-color: var(--accent);
  }

  /* Its one switch, likewise. */
  .switch {
    display: flex;
    gap: var(--space-2);
    align-items: baseline;
    font-size: 14px;
  }

  .switch input {
    margin: 0;
    accent-color: var(--accent);
  }
</style>
