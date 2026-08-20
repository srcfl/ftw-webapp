<!--
  The rest of a glance: price, what happens next, today, the fuse.

  Now's hero is the house. This is what the box page puts under it on
  Overview. Loaded after the first frame, because none of it belongs on
  the path to a reading.
-->
<script lang="ts">
  import { onDestroy, onMount, untrack } from 'svelte'
  import { PlanStore } from '$lib/state/plan.svelte'
  import { askWhenLive } from '$lib/state/ask.svelte'
  import { planHeadline, reasonText, slotAction } from '$lib/format/plan'
  import { formatEnergy, wholeWh } from '$lib/format/energy'
  import { chartPrices, hasHole } from '$lib/state/price'
  import { callBox } from '$lib/state/box-api'
  import {
    buildSavingsPeriods,
    formatCompactMinor,
    toSavingsDay,
    type SavingsPeriods,
  } from '$lib/format/savings'
  import { fuseView, type SiteStatus } from '$lib/state/flow'
  import { CAP_API_PASSTHROUGH } from '$lib/protocol/contract'
  import { activeCurrency } from '$vendor/ftw/price-units.js'
  import type { FtwPriceChartElement, FtwPriceChartWindow } from '$vendor/ftw/ftw-price-chart.js'
  import type { SiteStore } from '$lib/state/site.svelte'

  interface Props {
    site: SiteStore
    status: SiteStatus | null
    active?: boolean
  }

  let { site, status, active = true }: Props = $props()

  const CAP_PRICE_SPOT = 'price.spot'
  const PRICE_HORIZON_MS = 48 * 3_600_000
  const PRICE_PUBLISH_HOUR = 14

  const plan = new PlanStore(untrack(() => site))
  onDestroy(() => plan.destroy())

  let nowMs = $state(Date.now())
  onMount(() => {
    const t = setInterval(() => (nowMs = Date.now()), 30_000)
    return () => clearInterval(t)
  })

  askWhenLive(
    untrack(() => site),
    () => (active ? `plan ${plan.want}` : null),
    () => plan.load(),
  )

  const headline = $derived(planHeadline(plan.plan, nowMs))
  const currentSlot = $derived.by(() => {
    const slots = plan.plan?.slots ?? []
    return slots.find((s) => nowMs >= s.startMs && nowMs < s.startMs + s.durationMs) ?? null
  })
  const nextChange = $derived.by(() => {
    if (!currentSlot) return null
    const action = slotAction(currentSlot)
    const slots = plan.plan?.slots ?? []
    return slots.find((s) => s.startMs > nowMs && slotAction(s) !== action) ?? null
  })

  function openPlan(): void {
    location.hash = '#/plan'
  }

  function openHistory(): void {
    location.hash = '#/history'
  }

  // ---- Prices ------------------------------------------------------------

  let prices = $state.raw<FtwPriceChartWindow | null>(null)
  let priceChart = $state<FtwPriceChartElement | null>(null)
  let priceFromMs = $state(0)
  const priceHole = $derived(prices !== null && hasHole(prices.slots, priceFromMs))
  const priceEpoch = $derived.by(() => {
    const at = new Date(nowMs)
    return `${at.toDateString()}/${at.getHours() >= PRICE_PUBLISH_HOUR ? 'published' : 'pending'}`
  })
  let priceGen = 0
  const priceWanted = $derived(
    active && site.session.caps.has(CAP_PRICE_SPOT) ? priceEpoch : null,
  )

  $effect(() => {
    if (priceWanted === null) prices = null
  })
  $effect(() => {
    if (prices && new Date(nowMs).setHours(0, 0, 0, 0) !== priceFromMs) prices = null
  })

  askWhenLive(untrack(() => site), () => priceWanted, askForPrices)

  function askForPrices(): Promise<void> {
    const mine = ++priceGen
    const fromMs = new Date(nowMs).setHours(0, 0, 0, 0)
    return site
      .prices({ fromMs, toMs: fromMs + PRICE_HORIZON_MS })
      .then((wire) => {
        if (mine !== priceGen) return
        prices = chartPrices(wire)
        priceFromMs = fromMs
      })
      .catch((err: unknown) => {
        if (mine !== priceGen) return
        throw err
      })
  }

  $effect(() => {
    void nowMs
    if (prices) priceChart?.setPrices(prices)
  })

  $effect(() => {
    const el = priceChart
    if (!el) return
    const onClick = (e: Event) => {
      const path = e.composedPath()
      for (const node of path) {
        if (!(node instanceof Element)) continue
        if (node.classList.contains('compact-link')) {
          e.preventDefault()
          openPlan()
          return
        }
        if (node.classList.contains('compact-setup')) {
          e.preventDefault()
        }
      }
    }
    el.addEventListener('click', onClick)
    return () => el.removeEventListener('click', onClick)
  })

  // ---- Today / savings ---------------------------------------------------

  const today = $derived.by(() => {
    const t = status?.energy?.today
    if (!t) return null
    return {
      importWh: wholeWh(t.import_wh),
      exportWh: wholeWh(t.export_wh),
      pvWh: wholeWh(t.pv_wh),
    }
  })

  let savings = $state.raw<SavingsPeriods | null>(null)
  const savingsWanted = $derived.by(() => {
    if (!active || !site.session.caps.has(CAP_API_PASSTHROUGH)) return null
    const at = new Date(nowMs)
    return `savings ${at.toDateString()}`
  })

  askWhenLive(untrack(() => site), () => savingsWanted, loadSavings)

  async function loadSavings(): Promise<void> {
    const wire = await callBox<{ days?: unknown[] }>(site, {
      method: 'GET',
      path: '/api/savings/daily',
      query: { days: '31' },
    })
    const days = (wire.days ?? [])
      .map((row) => (row && typeof row === 'object' ? toSavingsDay(row) : null))
      .filter((row): row is NonNullable<typeof row> => row !== null)
    const next = buildSavingsPeriods(days)
    savings = next.today.available || next.week.available ? next : null
  }

  const fuse = $derived(status ? fuseView(status) : null)
  const currency = $derived(prices?.currency ?? activeCurrency())
</script>

<section class="outlook" aria-label="Immediate outlook">
  {#if prices}
    <section class="card price">
      {#await import('$vendor/ftw/ftw-price-chart.js') then _module}
        <ftw-price-chart compact fed bind:this={priceChart}></ftw-price-chart>
      {:catch}
        <p class="note">The price chart didn't load — it will try again next time you open the app.</p>
      {/await}
      {#if priceHole}
        <p class="note">Some hours are missing their price.</p>
      {:else if prices.stale}
        <p class="note">Tomorrow's rates aren't published yet.</p>
      {/if}
    </section>
  {/if}

  <section class="card plan">
    <div class="card-head">
      <div>
        <p class="kicker">Automation</p>
        <h2>What FTW does next</h2>
      </div>
    </div>
    <p class="plan-action">{headline.text}</p>
    {#if nextChange}
      <p class="plan-time">
        Next change {new Date(nextChange.startMs).toLocaleTimeString(undefined, {
          hour: '2-digit',
          minute: '2-digit',
          hour12: false,
        })}
      </p>
    {/if}
    {#if currentSlot}
      <p class="plan-reason">{reasonText(currentSlot.reason)}.</p>
    {/if}
    <button class="detail" type="button" onclick={openPlan}>
      Open full plan <span aria-hidden="true">→</span>
    </button>
  </section>
</section>

{#if today}
  <section class="card today" aria-labelledby="today-title">
    <div class="card-head">
      <div>
        <p class="kicker">Since midnight</p>
        <h2 id="today-title">Today</h2>
      </div>
    </div>
    <div class="today-grid">
      <div class="tile">
        <span>Imported</span>
        <strong class="num is-import">{formatEnergy(today.importWh).text}
          <small>{formatEnergy(today.importWh).unit}</small></strong>
      </div>
      <div class="tile">
        <span>Exported</span>
        <strong class="num is-export">{formatEnergy(today.exportWh).text}
          <small>{formatEnergy(today.exportWh).unit}</small></strong>
      </div>
      <div class="tile">
        <span>Solar</span>
        <strong class="num is-solar">{formatEnergy(today.pvWh).text}
          <small>{formatEnergy(today.pvWh).unit}</small></strong>
      </div>
      {#if savings}
        <div class="tile">
          <span>Saved <small class="ccy">{currency}</small></span>
          {#if savings.today.available}
            <strong
              class="num"
              class:is-export={savings.today.savedMinor >= 0}
              class:is-import={savings.today.savedMinor < 0}
            >{formatCompactMinor(savings.today.savedMinor)}</strong>
          {:else}
            <strong class="num">—</strong>
          {/if}
          {#if savings.week.available}
            <em class="week">{formatCompactMinor(savings.week.savedMinor)} this week</em>
          {/if}
        </div>
      {/if}
    </div>
    <button class="detail" type="button" onclick={openHistory}>
      Open history <span aria-hidden="true">→</span>
    </button>
  </section>
{/if}

{#if fuse}
  <section class="card fuse" aria-label="Fuse">
    <div class="card-head">
      <p class="kicker">Live safety</p>
      <h2>Fuse</h2>
    </div>
    {#if fuse.phases.length > 0}
      <div class="phases" style:--n={fuse.phases.length}>
        {#each fuse.phases as phase (phase.label)}
          <div class="phase">
            <span class="phase-lab">{phase.label}</span>
            <span class="phase-val num">{phase.amps.toFixed(1)} A</span>
            <div class="bar" aria-hidden="true">
              <div
                class="fill"
                class:warn={phase.pct >= 70}
                class:crit={phase.pct >= 90}
                class:is-out={phase.exporting}
                style:width="{phase.pct}%"
              ></div>
            </div>
          </div>
        {/each}
      </div>
    {:else if fuse.fallback}
      <div class="fallback">
        <span class="phase-val num">{fuse.fallback.amps.toFixed(1)} A</span>
        <div class="bar" aria-hidden="true">
          <div
            class="fill"
            class:warn={fuse.fallback.pct >= 70}
            class:crit={fuse.fallback.pct >= 90}
            style:width="{fuse.fallback.pct}%"
          ></div>
        </div>
        <span class="cap num">{fuse.maxAmps} A</span>
      </div>
    {/if}
  </section>
{/if}

<style>
  .outlook {
    display: grid;
    gap: var(--space-3);
    padding: 0 var(--space-4) var(--space-3);
  }

  .card {
    display: flex;
    flex-direction: column;
    min-width: 0;
    background: var(--surface-raised);
    border: 1px solid var(--line);
    border-radius: var(--radius-md);
    padding: var(--pad-card);
  }

  .today,
  .fuse {
    margin: 0 var(--space-4) var(--space-3);
  }

  .card-head {
    display: flex;
    align-items: flex-start;
    justify-content: space-between;
    gap: var(--space-3);
    margin-bottom: var(--space-3);
  }

  .kicker {
    font-family: var(--mono);
    font-size: 10px;
    letter-spacing: 0.12em;
    text-transform: uppercase;
    color: var(--fg-muted);
    margin-bottom: 4px;
  }

  h2 {
    font-size: 16px;
    font-weight: 550;
    letter-spacing: -0.02em;
    line-height: 1.2;
  }

  .plan-action {
    font-size: 16px;
    line-height: 1.35;
    letter-spacing: -0.015em;
    text-wrap: balance;
  }

  .plan-time {
    margin-top: 4px;
    font-family: var(--mono);
    font-size: 11px;
    color: var(--accent);
  }

  .plan-reason,
  .note {
    margin-top: var(--space-2);
    font-size: 12px;
    color: var(--fg-dim);
  }

  .note {
    font-family: var(--mono);
    font-size: 11px;
    color: var(--fg-muted);
  }

  .detail {
    align-self: flex-start;
    margin-top: var(--space-4);
    min-height: 36px;
    padding: 0;
    font-family: var(--mono);
    font-size: 10px;
    font-weight: 650;
    letter-spacing: 0.08em;
    text-transform: uppercase;
    color: var(--accent);
  }

  .today-grid {
    display: grid;
    grid-template-columns: repeat(2, minmax(0, 1fr));
    gap: var(--space-2);
  }

  .tile {
    display: flex;
    min-width: 0;
    min-height: 74px;
    flex-direction: column;
    justify-content: center;
    gap: 5px;
    padding: 12px 14px;
    background: var(--surface-sunken);
    border: 1px solid var(--line);
    border-radius: var(--radius-md);
  }

  .tile span {
    color: var(--fg-muted);
    font-family: var(--mono);
    font-size: 9px;
    letter-spacing: 0.1em;
    text-transform: uppercase;
  }

  .tile strong {
    overflow: hidden;
    font-size: 1.05rem;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .tile small,
  .tile em {
    font-style: normal;
    font-weight: 400;
    font-size: 11px;
    color: var(--fg-muted);
  }

  .ccy {
    letter-spacing: 0.06em;
  }

  .week {
    font-family: var(--mono);
    font-size: 10px;
  }

  .is-import { color: var(--energy-import); }
  .is-export { color: var(--energy-export); }
  .is-solar { color: var(--energy-generation); }

  .phases {
    display: grid;
    grid-template-columns: repeat(var(--n, 3), minmax(0, 1fr));
    gap: var(--space-2);
  }

  .phase,
  .fallback {
    display: flex;
    flex-direction: column;
    gap: 6px;
    padding: 10px 12px;
    background: var(--surface-sunken);
    border: 1px solid var(--line);
    border-radius: var(--radius-md);
  }

  .phase-lab {
    font-family: var(--mono);
    font-size: 9px;
    letter-spacing: 0.1em;
    text-transform: uppercase;
    color: var(--fg-muted);
  }

  .phase-val {
    font-size: 1rem;
  }

  .bar {
    height: 6px;
    border-radius: 99px;
    background: var(--line);
    overflow: hidden;
  }

  .fill {
    height: 100%;
    border-radius: 99px;
    background: var(--energy-export);
  }

  /* Direction first, load after: a phase that both exports and sits on
     the fuse must still read as a warning, not as a calm storage colour. */
  .fill.is-out { background: var(--energy-storage); }
  .fill.warn { background: var(--energy-generation); }
  .fill.crit { background: var(--energy-import); }

  .fallback {
    flex-direction: row;
    align-items: center;
    gap: var(--space-3);
  }

  .fallback .bar {
    flex: 1;
  }

  .cap {
    font-size: 11px;
    color: var(--fg-muted);
  }

  @media (min-width: 720px) {
    .outlook {
      grid-template-columns: 1fr 1fr;
    }

    .today-grid {
      grid-template-columns: repeat(4, minmax(0, 1fr));
    }
  }
</style>
