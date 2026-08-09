<!--
  Plan — what the box means to do, and how to change it.

  A sentence first, then the choice, then the timeline. Most visits end after
  the sentence, which is the point: the answer to "what's it up to?" should
  not require reading a chart.
-->
<script lang="ts">
  import { onMount, onDestroy, untrack } from 'svelte'
  import type { SiteStore } from '$lib/state/site.svelte'
  import { PlanStore } from '$lib/state/plan.svelte'
  import { askWhenLive } from '$lib/state/ask.svelte'
  import type { SiteMode, ModeInfo } from '$lib/protocol/messages'
  import { chartPrices, hasHole } from '$lib/state/price'
  import type { FtwPriceChartElement, FtwPriceChartWindow } from '$vendor/ftw/ftw-price-chart.js'
  import { activeCurrency, unitPerKwh } from '$vendor/ftw/price-units.js'
  import { modeLabel, modeHelp, planHeadline, slotAction, reasonText, formatPrice } from '$lib/format/plan'
  import { formatPower } from '$lib/format/power'

  interface Props {
    site: SiteStore
  }

  let { site }: Props = $props()

  /** From contract/registry.yaml. Absent means this box has no prices. */
  const CAP_PRICE_SPOT = 'price.spot'

  /**
   * Two whole days from local midnight: today and tomorrow, which is
   * everything the day-ahead market ever has published at once.
   *
   * Measured from midnight rather than from now on purpose. The box answers a
   * price window in a single bulk frame with room for a few hundred slots, and
   * midnight-to-now-plus-48h reaches seventy-two hours by late evening — past
   * what quarter-hour settlement fits, so the market would quietly end early.
   */
  const PRICE_HORIZON_MS = 48 * 3_600_000

  /**
   * The hour tomorrow's rates land on the box.
   *
   * Nordic day-ahead clears in the early afternoon. An hour past that is when
   * a view left open since morning has something new to ask for.
   */
  const PRICE_PUBLISH_HOUR = 14

  // The site store is one long-lived object, not a value that changes.
  // Reading it once at construction is the intent, so say so.
  const plan = new PlanStore(untrack(() => site))

  // A ticking clock so "in about an hour" stays honest while the view is open.
  let nowMs = $state(Date.now())

  onMount(() => {
    const t = setInterval(() => (nowMs = Date.now()), 30_000)
    return () => clearInterval(t)
  })

  // Asked for when the session is up, again whenever it comes back, and again
  // after an ask the box could not answer. On mount alone the ask that a drop
  // cut short was the last one this screen ever made: the timeline stayed
  // empty under a sentence promising it would load, for as long as the view
  // was open. A lost bulk answer and E_BOOTING never move the phase at all,
  // so a reconnect was never coming to rescue those either.
  askWhenLive(untrack(() => site), () => `plan ${plan.want}`, () => plan.load())

  onDestroy(() => plan.destroy())

  const headline = $derived(planHeadline(plan.plan, nowMs))

  /** The next twelve hours. Beyond that a plan is a guess about a guess. */
  const slots = $derived(
    (plan.plan?.slots ?? []).filter((s) => s.startMs + s.durationMs > nowMs).slice(0, 48)
  )

  const peakW = $derived(Math.max(1, ...slots.map((s) => Math.abs(s.batteryW))))

  // 24-hour regardless of locale. "07:15 PM" wraps onto two lines in a
  // 48-row list on a phone, and the AM/PM buys nothing in a timeline that is
  // explicitly the next twelve hours.
  function time(ms: number): string {
    return new Date(ms).toLocaleTimeString(undefined, {
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
    })
  }

  function choose(mode: SiteMode) {
    void plan.setMode(mode)
  }

  // FTW's own split: forecast-driven strategies are the choice most people
  // want, the manual fallbacks are a drawer. Open it if the box is already in
  // one of them, so the current setting is never hidden from its owner.
  let showAdvanced = $state(false)
  $effect(() => {
    if (plan.advancedModes.some((m) => m.key === plan.actualMode)) showAdvanced = true
  })

  // ---- Prices ------------------------------------------------------------

  let prices = $state.raw<FtwPriceChartWindow | null>(null)
  let priceChart = $state<FtwPriceChartElement | null>(null)

  /** Start of the window the one on screen was asked for. Set with it. */
  let priceFromMs = $state(0)

  /** Which shape of short answer this is. See the notice under the chart. */
  const priceHole = $derived(prices !== null && hasHole(prices.slots, priceFromMs))

  /**
   * What the timeline's prices are quoted in.
   *
   * A plan slot carries a price and no currency, so it has to come from the
   * window beside it — the same place the chart takes it from, which is what
   * keeps the two columns in the same unit. Before the first window of the
   * session lands, the box's own answer for a surface that shows a price
   * without fetching one: whatever was last read, SEK until something is.
   */
  const currency = $derived(prices?.currency ?? activeCurrency())

  /**
   * The window on screen, named by what would make it out of date: the local
   * day it covers, and whether tomorrow's rates had published when it was
   * asked for.
   */
  const priceEpoch = $derived.by(() => {
    const at = new Date(nowMs)
    return `${at.toDateString()}/${at.getHours() >= PRICE_PUBLISH_HOUR ? 'published' : 'pending'}`
  })

  /**
   * Which request the chart is waiting on.
   *
   * Two asks can be out at once — the day turns over, or the publication hour
   * passes, while an earlier one is still travelling — and they can land in
   * either order. Without this the older outcome wins by arriving last: a late
   * failure wipes a chart that is already drawn and correct, or a late answer
   * redraws yesterday over today with no sign anything went wrong.
   */
  let priceGen = 0

  /**
   * What the chart is asking for, or null when this box has no prices to ask
   * about — never a timer.
   *
   * Rates publish once a day, so polling would spend a bulk round trip every
   * few minutes to learn nothing. The name changes at exactly the moments that
   * earn a fresh ask: local midnight, past which the chart is yesterday's and
   * the NOW marker has walked off the end of it; and the publication hour,
   * which is when a screen open since morning can finally offer tomorrow. A
   * reconnect earns one too — which is also when tomorrow's rates could have
   * landed while the phone was in a pocket — and so does an ask that failed;
   * askWhenLive gives both without the name having to change. On a LAN carrier
   * that stays up for days that is two extra bulk round trips a day.
   */
  const priceWanted = $derived(site.session.caps.has(CAP_PRICE_SPOT) ? priceEpoch : null)

  // A box that stops advertising price.spot — a feed removed, a driver pulled
  // — stops being asked, and without this the last window it ever sent stays
  // on screen until local midnight moves the day out from under it and the
  // chart draws its empty state instead, which reads as the market going
  // quiet. There are no prices here to show, so show none.
  $effect(() => {
    if (priceWanted === null) prices = null
  })

  /**
   * A window on screen is today's, or it is nothing.
   *
   * A failed ask leaves whatever is drawn alone, because today's prices are
   * still today's and taking away a block someone is reading costs them
   * something. That stops being true at local midnight: the bars are then
   * yesterday's, and the chart would go on heading them "today" and calling
   * yesterday's last slot "now". Steadiness is worth having and "never fake
   * live" outranks it. A fresh window is already on its way — the day is part
   * of the name asked under — and until it lands, nothing is the honest thing
   * to draw.
   */
  $effect(() => {
    if (prices && new Date(nowMs).setHours(0, 0, 0, 0) !== priceFromMs) prices = null
  })

  askWhenLive(untrack(() => site), () => priceWanted, askForPrices)

  function askForPrices(): Promise<void> {
    const mine = ++priceGen

    // From local midnight, so the chart reads like a calendar rather than a
    // sliding window — this morning is still on it at six in the evening.
    const fromMs = new Date(nowMs).setHours(0, 0, 0, 0)
    return site
      .prices({ fromMs, toMs: fromMs + PRICE_HORIZON_MS })
      .then((wire) => {
        if (mine !== priceGen) return
        prices = chartPrices(wire)
        // Set with the window, because the notice under the chart compares
        // the two: a window that starts after what was asked for is missing
        // its own morning, and nothing in the slots alone can say so.
        priceFromMs = fromMs
      })
      .catch((err: unknown) => {
        // A box with a zone configured but nothing stored answers
        // E_UNAVAILABLE, which the contract marks retryable; the eight-second
        // deadline against a busy box is the same shape. Whatever window is
        // already drawn stays drawn — today's prices are still today's, and
        // taking a block the user was reading off the screen because one
        // answer was lost costs them something and tells them nothing. A
        // newer window replaces it when one arrives. Rethrown so askWhenLive
        // asks again; a superseded ask is not, because a newer one owns the
        // answer.
        if (mine !== priceGen) return
        throw err
      })
  }

  /**
   * The component takes data by method, the way the box's dashboard feeds it.
   *
   * Fed again on every tick, not only when the window changes. The chart reads
   * the clock when it renders — the NOW marker and the "now" figure both come
   * from it — and `fed` deliberately took away the five-minute poll that used
   * to re-render it on the dashboard. Without a tick of its own it would draw
   * a marker that never moves and head a price hours old as now, on a healthy
   * box with a perfect connection. Feeding the same window again is cheap and
   * changes nothing but the clock.
   */
  $effect(() => {
    void nowMs
    if (prices) priceChart?.setPrices(prices)
  })
</script>

<section class="head">
  <p class="headline">{headline.text}</p>
  {#if plan.problem}
    <p class="problem">{plan.problem}</p>
  {/if}
</section>

<section class="modes">
  <h2 class="label">How your home is run</h2>

  <!-- Pressed buttons rather than radios, the way History's range picker
       solves the same exclusive choice: role=radio promises arrow-key moves
       between the options, and these buttons never had them. -->
  {#snippet choice(info: ModeInfo)}
    <button
      class="choice"
      aria-pressed={plan.shownMode === info.key}
      disabled={!plan.canControl || plan.command.kind === 'sending'}
      onclick={() => choose(info.key)}
    >
      <span class="choice-label">{modeLabel(info)}</span>
      <span class="choice-help">{modeHelp(info)}</span>
    </button>
  {/snippet}

  <div class="choices" role="group" aria-label="How your home is run">
    {#each plan.primaryModes as info (info.key)}
      {@render choice(info)}
    {/each}

    {#if plan.advancedModes.length > 0}
      {#if showAdvanced}
        {#each plan.advancedModes as info (info.key)}
          {@render choice(info)}
        {/each}
      {:else}
        <button class="more" onclick={() => (showAdvanced = true)}>
          More ways to run it
        </button>
      {/if}
    {/if}
  </div>

  <!-- One line, in the freshness band's voice. Never a modal: changing a
       setting should not take the screen away from someone. -->
  {#if plan.command.kind === 'sending'}
    <p class="status">Sending…</p>
  {:else if plan.command.kind === 'applied'}
    <p class="status good">Done.</p>
  {:else if plan.command.kind === 'unconfirmed'}
    <p class="status warn">
      Your box took it, but hasn't confirmed yet. It'll show here when it does.
    </p>
  {:else if plan.command.kind === 'failed'}
    <p class="status warn">{plan.command.help}</p>
  {:else if plan.whyNoControl === 'role'}
    <!-- Not "your box can't do this" — it can, and saying otherwise would
         send a guest looking for a fault that is not there. -->
    <p class="status">You have view-only access, so this is the owner's to change.</p>
  {:else if plan.whyNoControl === 'box'}
    <p class="status">This box doesn't support changing how it runs.</p>
  {/if}
</section>

<!-- Above the timeline because it is the reason the timeline looks the way
     it does. Nothing at all when the box does not advertise price.spot: an
     empty chart would claim the market went quiet rather than that this
     house has no price feed. -->
{#if prices}
  <section class="prices">
    <!-- Loaded on demand, the way History is. Imported here it costs the
         launch 10.4 kB gzip — two thirds of everything left under the bundle
         budget — for a chart on a screen most opens never reach. Fetched when
         there is a window to draw it costs 0.5 kB. -->
    {#await import('$vendor/ftw/ftw-price-chart.js') then _module}
      <ftw-price-chart fed bind:this={priceChart}></ftw-price-chart>
    {:catch}
      <!-- The chunk never arrived. The timeline below still prices its own
           rows; silence here would read as a market with nothing in it. -->
      <p class="short">The price chart didn't load — it will try again next time you open the app.</p>
    {/await}
    <!-- Said here rather than left to the component: it keeps its own stale
         state for the compact card, which this screen never renders, so a
         window short of what was asked for would otherwise pass with no
         notice at all.

         Two sentences, because `stale` covers three shapes and only one of
         them is about tomorrow. Missing hours are checked first — a gap in
         the middle or a day that never started — because it is the narrower
         claim, and a window that both misses hours and stops early is better
         described by the hours it misses than by a market that has not
         cleared. Neither is an error: the day-ahead market clears in the
         afternoon, so every morning genuinely ends short of what was asked
         for. -->
    {#if priceHole}
      <p class="short">Some hours are missing their price.</p>
    {:else if prices.stale}
      <p class="short">Tomorrow's rates aren't published yet.</p>
    {/if}
  </section>
{/if}

{#if slots.length > 0}
  <section class="timeline">
    <div class="timeline-head">
      <h2 class="label">Next 12 hours</h2>
      <!-- The chart above prices the same hours, in the same unit. Without
           naming this column, two numbers for 21:00 sit one above the other
           with nothing saying they are the same money — and the unit is here
           rather than on every row because forty-eight rows of "144.0 öre/kWh"
           on a phone is the same fact printed forty-eight times. -->
      <span class="legend">to import, {unitPerKwh(currency)}</span>
    </div>
    <ol>
      {#each slots as s (s.startMs)}
        {@const action = slotAction(s)}
        {@const p = formatPower(s.batteryW)}
        {@const price = formatPrice(s.priceMinor, currency)}
        <li class:now={nowMs >= s.startMs && nowMs < s.startMs + s.durationMs}>
          <span class="time num">{time(s.startMs)}</span>
          <span class="bar" data-action={action} aria-hidden="true">
            <span class="fill" style:width="{(Math.abs(s.batteryW) / peakW) * 100}%"></span>
          </span>
          <span class="what">
            {#if action === 'idle'}
              <span class="dim">resting</span>
            {:else}
              <span class="num">{p.text}</span><span class="unit">{p.unit}</span>
              <span class="dim">{action === 'charge' ? 'in' : 'out'}</span>
            {/if}
          </span>
          <span class="why dim">{reasonText(s.reason)}</span>
          {#if price}<span class="num dim slot-price">{price}</span>{/if}
        </li>
      {/each}
    </ol>
  </section>
{:else if plan.loading}
  <p class="loading">Asking your box…</p>
{/if}

<style>
  .head {
    padding: var(--space-5) var(--space-4) var(--space-4);
  }

  .headline {
    font-size: 20px;
    line-height: 1.35;
    letter-spacing: -0.01em;
    text-wrap: balance;
  }

  .problem,
  .status,
  .short {
    font-family: var(--mono);
    font-size: 11px;
    letter-spacing: 0.04em;
    color: var(--fg-muted);
    margin-top: var(--space-3);
  }

  .status.good {
    color: var(--energy-export);
  }
  .status.warn {
    color: var(--energy-generation);
  }

  .modes,
  .prices,
  .timeline {
    padding: 0 var(--space-4) var(--space-6);
  }

  h2 {
    margin-bottom: var(--space-3);
  }

  .timeline-head {
    display: flex;
    align-items: baseline;
    justify-content: space-between;
    gap: var(--space-2);
  }

  .legend {
    font-size: 11px;
    color: var(--fg-muted);
  }

  .choices {
    display: flex;
    flex-direction: column;
    gap: var(--space-2);
  }

  .choice {
    display: flex;
    flex-direction: column;
    align-items: flex-start;
    gap: var(--space-1);
    text-align: left;
    padding: var(--pad-card);
    background: var(--surface-raised);
    border: 1px solid var(--line);
    border-radius: var(--radius-md);
    transition:
      border-color var(--motion-base) var(--ease),
      background var(--motion-base) var(--ease);
  }

  .choice[aria-pressed='true'] {
    border-color: var(--accent);
    background: var(--surface-elevated);
  }

  .choice:disabled {
    opacity: 0.5;
    cursor: default;
  }

  .more {
    align-self: flex-start;
    color: var(--fg-dim);
    font-size: 13px;
    text-decoration: underline;
    text-underline-offset: 3px;
    min-height: 36px;
  }

  .choice-label {
    font-weight: 500;
  }

  .choice-help {
    font-size: 13px;
    color: var(--fg-dim);
    line-height: 1.4;
  }

  ol {
    list-style: none;
    padding: 0;
    display: flex;
    flex-direction: column;
    gap: 1px;
  }

  /* The reason is the column that matters — it is what makes a plan
     understandable rather than just scheduled — so it gets the free space and
     the bar is what goes first when there is none. */
  li {
    display: grid;
    grid-template-columns: 2.9rem 5rem 1fr auto;
    align-items: center;
    gap: var(--space-2);
    padding: var(--space-2) var(--space-2);
    font-size: 12px;
    border-radius: var(--radius-xs);
  }

  .bar {
    display: none;
  }

  @media (min-width: 430px) {
    li {
      grid-template-columns: 3rem 3.5rem 5rem 1fr auto;
    }

    .bar {
      display: block;
    }
  }

  li.now {
    background: var(--surface-raised);
  }

  .time {
    color: var(--fg-muted);
  }

  /* A bar, not a chart. The timeline answers "when and how much", and a
     canvas here would cost a chunk for something a div already says. */
  .bar {
    height: 4px;
    border-radius: 2px;
    background: var(--surface-elevated);
    overflow: hidden;
  }

  .fill {
    display: block;
    height: 100%;
    background: var(--fg-muted);
  }

  .bar[data-action='charge'] .fill {
    background: var(--energy-storage);
  }
  .bar[data-action='discharge'] .fill {
    background: var(--energy-generation);
  }

  .unit {
    font-size: 10px;
    color: var(--fg-muted);
    margin-left: 0.15em;
  }

  .dim {
    color: var(--fg-muted);
  }

  .why {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .loading {
    padding: var(--space-5) var(--space-4);
    color: var(--fg-muted);
    font-family: var(--mono);
    font-size: 12px;
  }
</style>
