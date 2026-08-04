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
  import type { SiteMode, ModeInfo } from '$lib/protocol/messages'
  import { modeLabel, modeHelp, planHeadline, slotAction, reasonText, formatPrice } from '$lib/format/plan'
  import { formatPower } from '$lib/format/power'

  interface Props {
    site: SiteStore
  }

  let { site }: Props = $props()

  // The site store is one long-lived object, not a value that changes.
  // Reading it once at construction is the intent, so say so.
  const plan = new PlanStore(untrack(() => site))

  // A ticking clock so "in about an hour" stays honest while the view is open.
  let nowMs = $state(Date.now())

  onMount(() => {
    void plan.load()
    const t = setInterval(() => (nowMs = Date.now()), 30_000)
    return () => clearInterval(t)
  })

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
</script>

<section class="head">
  <p class="headline">{headline.text}</p>
  {#if plan.problem}
    <p class="problem">{plan.problem}</p>
  {/if}
</section>

<section class="modes">
  <h2 class="label">How your home is run</h2>

  {#snippet choice(info: ModeInfo)}
    <button
      class="choice"
      role="radio"
      aria-checked={plan.shownMode === info.key}
      disabled={!plan.canControl || plan.command.kind === 'sending'}
      onclick={() => choose(info.key)}
    >
      <span class="choice-label">{modeLabel(info)}</span>
      <span class="choice-help">{modeHelp(info)}</span>
    </button>
  {/snippet}

  <div class="choices" role="radiogroup" aria-label="How your home is run">
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
  {:else if !plan.canControl}
    <p class="status">This box doesn't support changing how it runs.</p>
  {/if}
</section>

{#if slots.length > 0}
  <section class="timeline">
    <h2 class="label">Next 12 hours</h2>
    <ol>
      {#each slots as s (s.startMs)}
        {@const action = slotAction(s)}
        {@const p = formatPower(s.batteryW)}
        {@const price = formatPrice(s.priceMinor)}
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
          {#if price}<span class="price num dim">{price}</span>{/if}
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
  .status {
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
  .timeline {
    padding: 0 var(--space-4) var(--space-6);
  }

  h2 {
    margin-bottom: var(--space-3);
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

  .choice[aria-checked='true'] {
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

  .price::after {
    content: '/kWh';
    font-size: 9px;
    opacity: 0.7;
    margin-left: 0.15em;
  }

  .loading {
    padding: var(--space-5) var(--space-4);
    color: var(--fg-muted);
    font-family: var(--mono);
    font-size: 12px;
  }
</style>
