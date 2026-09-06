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
    evPlanSentence,
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
    loadpointId?: string | null
  }

  let { site, onclose, loadpointId = null }: Props = $props()

  const store = new LoadpointsStore(untrack(() => site))
  onDestroy(() => store.destroy())

  // Fresh while open: the ask name changes every five seconds, so askWhenLive
  // re-asks as the window ages — the same rule History and Energy follow.
  // The panel mounts when it opens and unmounts when it closes, so the
  // ticker lives exactly as long as someone is looking.
  let visible = $state(!document.hidden)
  $effect(() => {
    const changed = () => { visible = !document.hidden }
    document.addEventListener('visibilitychange', changed)
    return () => document.removeEventListener('visibilitychange', changed)
  })
  let pollEpoch = $state(Math.floor(Date.now() / 5_000))
  $effect(() => {
    const t = setInterval(() => {
      pollEpoch = Math.floor(Date.now() / 5_000)
    }, 1_000)
    return () => clearInterval(t)
  })

  askWhenLive(
    untrack(() => site),
    () => visible ? `loadpoints ${pollEpoch}` : null,
    () => store.load()
  )

  function clock(ms: number): string {
    return new Date(ms).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })
  }

  let sheet: HTMLDivElement | undefined
  $effect(() => {
    if (!sheet) return
    const previous = document.activeElement
    sheet.focus()
    return () => { if (previous instanceof HTMLElement && previous.isConnected) previous.focus() }
  })

  function onkeydown(e: KeyboardEvent) {
    if (e.key === 'Escape') { e.preventDefault(); onclose(); return }
    if (e.key !== 'Tab' || !sheet) return
    const items = [...sheet.querySelectorAll<HTMLElement>('button:not(:disabled), input:not(:disabled), select:not(:disabled), a[href], summary, [tabindex="0"]')].filter(el => !el.hidden && el.getClientRects().length > 0)
    const first = items[0], last = items.at(-1)
    if (!first || !last) { e.preventDefault(); return }
    if (e.shiftKey && (document.activeElement === first || document.activeElement === sheet)) {
      e.preventDefault(); last.focus()
    } else if (!e.shiftKey && document.activeElement === last) {
      e.preventDefault(); first.focus()
    }
  }

  const sending = $derived(store.command.kind === 'sending')
  const stale = $derived(!!store.error || site.session.phase !== 'streaming')

  /**
   * One sentence per thing the box did, under the control that asked. The
   * level names the figure the box read back, in the box page's own words.
   */
  function did(o: Outcome, lp: Loadpoint): string {
    switch (o) {
      case 'hold':
        return stale ? 'Waiting for current charger status.' : lp.manual ? evStatusSentence(lp) : 'FTW received your charge request. Waiting for charger status.'
      case 'release':
        return 'Manual charge ended. The plan decides when to charge.'
      case 'boost':
        return 'Battery boost selected. The power readings show what the house battery supplies.'
      case 'unboost':
        return 'Boost stopped — the plan decides again.'
      case 'soc':
        return `Charge level saved: ${lp.socPct ?? socFor(lp)} %.` +
          (!lp.schedule && !lp.manualActive && !lp.surplusOnly ? ' Set a ready time, or choose Charge now.' : ' Reading the updated plan…')
      case 'surplus_on':
        return 'Solar rule saved. The plan uses spare solar only.'
      case 'surplus_off':
        return 'Solar rule saved. The plan may use grid power again.'
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
  const ampVersion: Record<string, number> = {}
  function editAmps(lp: Loadpoint, value: number): void {
    amps[lp.id] = value
    ampVersion[lp.id] = (ampVersion[lp.id] ?? 0) + 1
  }
  async function setAmps(lp: Loadpoint, value: number): Promise<void> {
    editAmps(lp, value)
    const version = ampVersion[lp.id]
    await store.chargeNow(lp, value)
    if (ampVersion[lp.id] === version) delete amps[lp.id]
  }

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
  const socVersion: Record<string, number> = {}
  function editSoc(lp: Loadpoint, value: number): void {
    socDraft[lp.id] = value
    socVersion[lp.id] = (socVersion[lp.id] ?? 0) + 1
  }

  function socFor(lp: Loadpoint): number {
    return socDraft[lp.id] ?? lp.socPct ?? SOC_DEFAULT_PCT
  }

  /** Written on release, as the box's page does. There is no button. */
  async function setSoc(lp: Loadpoint, pct: number): Promise<void> {
    editSoc(lp, pct)
    const version = socVersion[lp.id]
    await store.setSoc(lp, pct)
    if (socVersion[lp.id] === version) delete socDraft[lp.id]
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
  let draft = $state<{ lpId: string; time: string; days: number; socPct: number; recurring: boolean; surplusUnlockPct: number } | null>(null)
  let saving = $state(false)
  let saveError = $state<string | null>(null)

  function beginEdit(lp: Loadpoint): void {
    saveError = null
    scheduleNote = lp.schedule ? 'Changes apply as you make them.' : 'No goal set yet. Choose this goal, or change the level or time.'
    // The wire's zero means every day; the draft holds all seven bits
    // instead, so tapping Saturday off an every-day schedule means "not
    // Saturday" — with a raw zero it would have meant "only Saturday",
    // the exact opposite of the thumb's intent.
    const wireDays = lp.schedule?.days ?? 0
    draft = {
      lpId: lp.id,
      time: lp.schedule ? utcMinutesToLocalInput(lp.schedule.timeOfDayMinUtc) : '07:00',
      days: wireDays === 0 ? 0x7f : wireDays & 0x7f,
      socPct: Math.round(lp.schedule?.socPct ?? lp.targetSocPct ?? 80),
      recurring: lp.schedule?.recurring ?? false,
      surplusUnlockPct: lp.schedule?.surplusUnlockPct ?? 0,
    }
  }

  function toggleDay(bit: number): void {
    if (draft) draft.days ^= 1 << bit
    scheduleSave()
  }

  let scheduleNote = $state('Changes apply as you make them.')
  let saveTimer: ReturnType<typeof setTimeout> | undefined
  let pendingSchedule = $state(false)
  let scheduleRevision = 0
  onDestroy(() => {
    // A released control is an instruction, including when the sheet closes.
    if (saveTimer) { clearTimeout(saveTimer); saveTimer = undefined; void saveDraft() }
  })

  function scheduleSave(): void {
    scheduleRevision++
    saveError = null
    scheduleNote = 'Applying schedule…'
    pendingSchedule = true
    clearTimeout(saveTimer)
    saveTimer = setTimeout(() => { saveTimer = undefined; void saveDraft() }, 400)
  }

  async function saveDraft(): Promise<void> {
    if (!draft || saving) return
    const next = { ...draft }
    const revision = scheduleRevision
    const minUtc = localInputToUtcMinutes(next.time)
    pendingSchedule = false
    if (!Number.isFinite(next.surplusUnlockPct) || next.surplusUnlockPct < 0 || next.surplusUnlockPct > 100) { saveError = 'Choose a home battery level from 1 to 100 %.'; return }
    if (minUtc === null || (next.recurring && next.days === 0) || !Number.isFinite(next.socPct) || next.socPct < 10 || next.socPct > 100) {
      saveError = minUtc === null ? 'Choose a valid ready time.' : next.recurring && next.days === 0 ? 'Choose at least one day.' : 'Choose a charge target from 10 to 100 %.'
      return
    }
    saving = true
    saveError = null
    try {
      await callBox(untrack(() => site), {
        method: 'PUT',
        path: `/api/loadpoints/${encodeURIComponent(next.lpId)}/schedule`,
        body: {
          soc: next.socPct / 100,
          time_of_day_min_utc: minUtc,
          recurring: next.recurring,
          days: !next.recurring || next.days === 0x7f ? 0 : next.days & 0x7f,
          surplus_unlock_bat_soc: next.surplusUnlockPct / 100,
        },
      })
      if (revision === scheduleRevision) scheduleNote = 'Schedule saved. Reading the plan…'
      await store.load()
      if (revision === scheduleRevision) scheduleNote = store.error ? 'Schedule saved. Current charging status is unavailable.' : 'Schedule saved.'
    } catch (err) {
      if (revision === scheduleRevision) {
        saveError = err instanceof BoxApiError ? err.help : "Your box didn't confirm the change. Check the current settings before trying again."
      }
    } finally {
      saving = false
      if (pendingSchedule) void saveDraft()
    }
  }

  async function removeSchedule(lpId: string): Promise<void> {
    clearTimeout(saveTimer)
    saveTimer = undefined
    pendingSchedule = false
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
        err instanceof BoxApiError ? err.help : "Your box didn't confirm the change. Reading its current settings…"
    } finally {
      saving = false
    }
  }
</script>

<svelte:window {onkeydown} />

<!-- The fate of the last command, under the control that sent it. One
     command is in flight at a time, so the outcome belongs to exactly one. -->
{#snippet outcome(of: Control, lp: Loadpoint)}
  {#if store.commandLpId === lp.id && store.command.kind === 'applied' && store.command.of === of}
    <p class="hint" role="status">{did(store.command.did, lp)}</p>
  {:else if store.commandLpId === lp.id && store.command.kind === 'unconfirmed' && store.command.of === of}
    <p class="hint" role="status">FTW received the request. Its result is not confirmed yet.</p>
  {:else if store.commandLpId === lp.id && store.command.kind === 'failed' && store.command.of === of}
    <p class="hint" role="alert">{store.command.help}</p>
  {/if}
{/snippet}

<!-- Parked on the app shell, with the live-line sheet: inside the scrolling
     view a "fixed" sheet is the bottom of the page. -->
<div class="layer" use:portal>
<!-- The backdrop is the close control, as every sheet's is. The sheet itself
     is a dialog, so what is behind it is inert to a screen reader. -->
<div class="backdrop" onclick={onclose} aria-hidden="true"></div>

<div class="sheet" bind:this={sheet} role="dialog" aria-modal="true" aria-label="EV charger" tabindex="-1">
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
    {#each store.points.filter(lp => !loadpointId || lp.id === loadpointId) as lp (lp.id)}
      <div class="charger">
        <p class="status" role="status" aria-live="polite">{stale ? 'Waiting for current charger status. The last reading is out of date.' : evStatusSentence(lp)}</p>
        {#if !stale && evPlanSentence(lp)}<p class="hint">{evPlanSentence(lp)}</p>{/if}
        {#if lp.charger?.updated_at_ms || lp.manual?.charger_updated_at_ms}
          <p class="hint">Charger last seen: {clock(Number(lp.charger?.updated_at_ms ?? lp.manual?.charger_updated_at_ms))}</p>
        {/if}

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
          {@const level = socFor(lp)}
          <!-- The car's level, above the charging controls as on the box's
               own page: the estimate the plan runs from, and a slider to
               correct it. Written on release, no button; the box replans
               before it answers. Absent when the bay is empty, because
               there is no car to hold a level. -->
          <div class="control">
            <div class="row">
              <span class="label">Battery now</span>
              <span class="readout">{lp.socSource === 'assumed' && socDraft[lp.id] === undefined ? 'Not confirmed' : `${level} %`}</span>
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
              oninput={(e) => editSoc(lp, Number(e.currentTarget.value))}
              onchange={(e) => void setSoc(lp, Number(e.currentTarget.value))}
            />
            {#if store.commandLpId === lp.id && store.command.kind === 'sending' && store.command.of === 'soc'}
              <p class="hint">Sending charge level: {level} %…</p>
            {:else if store.commandLpId === lp.id && store.command.kind !== 'idle' && store.command.of === 'soc'}
              {@render outcome('soc', lp)}
            {:else}
              <p class="hint">{socSourceSentence(lp)}</p>
            {/if}
          </div>

          <!-- The slider is the box's own page's: whole amps between the
               charger's floor and ceiling, sent as watts for a hold that
               runs until the car is full, Stop, or an unplug. -->
          <div class="control">
            {#if lp.manualActive}
            <div class="row">
              <span class="label">Charge now is active</span>
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
              oninput={(e) => editAmps(lp, Number(e.currentTarget.value))}
              onchange={(e) => { if (lp.manualActive) void setAmps(lp, Number(e.currentTarget.value)) }}
            />
            {/if}
            <div class="actions">
              {#if lp.manualActive}
                <button class="quiet" disabled={sending} onclick={() => void store.stopCharging(lp)}>
                  Return to plan
                </button>
              {:else}
                <button
                  class="primary"
                  disabled={sending}
                  onclick={() => void store.chargeNow(lp, chosen)}
                >
                  {store.command.kind === 'sending' && store.commandLpId === lp.id && store.command.of === 'hold' ? 'Sending charge request…' : 'Charge now'}
                </button>
              {/if}
            </div>
            <p class="hint">
              {#if lp.manualActive}
                Changes apply when you release the slider. Return to plan restores your schedule and solar settings.
              {:else}
                Starts at up to {currentReadout(lp, chosen)}. Ignores the goal and solar rule until you return to the plan or unplug.
              {/if}
            </p>
            {@render outcome('hold', lp)}
          </div>

        {/if}

        <section class="goal" aria-label="Your goal">
          <h3>Your goal</h3>
          {#if lp.manualActive}
            <p class="hint">Charge now overrides this goal. Edits apply when you return to the plan.</p>
          {/if}
        {#if draft?.lpId === lp.id}
          <!-- Released controls write in order; the draft stays during rereads. -->
          <div class="editor">
            <div class="row">
              <span class="label">Ready by</span>
              <input type="time" aria-label="Ready by" bind:value={draft.time} onchange={scheduleSave} />
            </div>
            <label class="switch">
              <input type="checkbox" bind:checked={draft.recurring} onchange={scheduleSave} />
              <span>Repeat on chosen days</span>
            </label>
            {#if draft.recurring}
            <div class="chips" role="group" aria-label="Days">
              {#each DAY_LABELS as day, bit (day)}
                <button
                  class="chip"
                  aria-pressed={(draft.days & (1 << bit)) !== 0}
                  onclick={() => toggleDay(bit)}
                >
                  {day}
                </button>
              {/each}
            </div>
            {/if}
            <div class="row">
              <span class="label">Charge to</span>
              <input
                type="range"
                class="slider"
                aria-label="Target charge, percent"
                min="10"
                max="100"
                step="5"
                bind:value={draft.socPct}
                onchange={scheduleSave}
              />
              <span class="readout">{draft.socPct} %</span>
            </div>
            <details class="extras">
              <summary>Solar timing</summary>
              <label class="switch">
                <input type="checkbox" checked={draft.surplusUnlockPct > 0}
                  onchange={(e) => { if (draft) draft.surplusUnlockPct = e.currentTarget.checked ? 50 : 0; scheduleSave() }} />
                <span>Also use spare solar before the planned hours</span>
              </label>
              {#if draft.surplusUnlockPct > 0}
                <label class="row">
                  <span>Keep home battery above</span>
                  <input type="number" min="1" max="100" step="1" bind:value={draft.surplusUnlockPct}
                    onchange={scheduleSave} aria-label="Home battery solar threshold, percent" />
                  <span>%</span>
                </label>
              {/if}
            </details>
            <div class="actions">
              {#if !lp.schedule}
                <button class="primary" disabled={saving || pendingSchedule} onclick={scheduleSave}>
                  Use {draft.socPct} % by {draft.time}
                </button>
              {/if}
              <button class="quiet" disabled={saving || pendingSchedule} onclick={() => (draft = null)}>
                Close goal settings
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
            <p class="hint" role="status">{saveError ?? scheduleNote}</p>
            {#if saveError}
              <button class="quiet" disabled={saving} onclick={scheduleSave}>Try again</button>
            {/if}
          </div>
        {:else}
          {#if evScheduleSentence(lp)}
            <div class="row">
              <span>{evScheduleSentence(lp)}</span>
              {#if site.canConfigure}
                <button class="quiet edit" onclick={() => beginEdit(lp)}>Change goal</button>
              {/if}
            </div>
          {:else if store.loaded && site.canConfigure}
            <div class="row">
              <button class="quiet edit" onclick={() => beginEdit(lp)}>
                Set a ready time
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
              disabled={sending || lp.manualActive}
              onchange={(e) => void setSurplusOnly(lp, e.currentTarget.checked)}
            />
            <span>Only spare solar</span>
          </label>
          <p class="hint">{lp.manualActive
            ? 'Charge now overrides this rule. It resumes when you return to the plan.'
            : (surplusDraft[lp.id] ?? lp.surplusOnly)
              ? 'No grid or home battery. Your target may not be reached in time.'
              : 'The plan may use grid power to reach your target.'}</p>
          {#if store.command.kind === 'sending' && store.command.of === 'surplus'}
            <p class="hint">Asking your box…</p>
          {:else}
            {@render outcome('surplus', lp)}
          {/if}
        {:else if lp.surplusOnly}
          <p class="hint">Charges from spare solar only.</p>
        {/if}

        </section>

        {#if site.canConfigure && lp.pluggedIn}
          <details class="extras">
            <summary>Home battery boost</summary>
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
                  <span class="hint">Available after returning to the plan.</span>
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
          </details>
        {/if}

        {#if boostStoppedSentence(lp)}
          <p class="hint">{boostStoppedSentence(lp)}</p>
        {/if}

        {#if !lp.manualActive && !stale && (store.windows[lp.id] ?? []).length > 0}
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
        {:else if !lp.manualActive && store.planMissing}
          <!-- The plan read failed while the charger read did not. An empty
               list here would claim an idle week the app has not read. -->
          <p class="hint">Charging times aren't readable right now.</p>
        {/if}
      </div>
    {:else}
      <!-- The box answered, and the answer is: no charger. The bubble that
           opened this panel draws from a live field, so meeting this means
           the charger left between two reads — say so plainly. -->
      <p class="note">Charging control is not set up. Open Settings → Chargers on your box’s page to add the charger.</p>
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
    max-width: 34rem;
    margin-inline: auto;
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

  .goal {
    padding: var(--space-3);
    border: 1px solid var(--line);
    border-radius: var(--radius-md);
    display: flex;
    flex-direction: column;
    gap: var(--space-3);
  }

  .goal h3 { font-size: 15px; font-weight: 500; }
  .extras summary { cursor: pointer; font-size: 13px; color: var(--fg-dim); }
  .extras[open] summary { margin-bottom: var(--space-3); }

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
    white-space: nowrap;
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
