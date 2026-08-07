<!--
  The one place freshness is expressed.

  Two orthogonal facts, never collapsed into one enum:
    carrier  — how frames are reaching us (relay, cache, nothing)
    srcState — whether the box's own sources are answering

  Collapsing them cannot say "connected, but the inverter went quiet 40
  seconds ago", which is exactly the case a user needs to see. Keeping this
  in a single component is what stops the distinction eroding as views grow.

  The band never claims live unless frames are arriving now — and never
  claims a problem it has not confirmed. Showing cache while still connecting
  is normal, not a fault, and saying "box unreachable" during the first second
  of every launch would train people to ignore the one indicator that matters.
-->
<script lang="ts">
  import { formatAge } from '$lib/format/power'
  import type { CarrierState, SourceState } from '$lib/protocol/types'
  import type { SessionPhase } from '$lib/protocol/session'

  interface Props {
    carrier: CarrierState
    /** Worst state across the sources this view depends on. */
    srcState: SourceState
    /** Age of the oldest reading on screen, in ms. */
    ageMs: number
    phase: SessionPhase
    /**
     * No carrier could be built at all, so nothing is in flight to wait for.
     *
     * Not derivable from the two facts above. A session with no carrier and a
     * session one await away from having one are the same `idle` phase and
     * the same `none` carrier, and the difference is the whole question this
     * band answers: the first is a phone that will never reach its box on its
     * own, and the second is the first second of every launch. Only the shell
     * knows which, because only the shell saw the attempt fail.
     */
    noCarrier?: boolean
  }

  let { carrier, srcState, ageMs, phase, noCarrier = false }: Props = $props()

  /** Still trying, and has not yet failed. */
  const reaching = $derived(
    !noCarrier && (phase === 'idle' || phase === 'handshaking' || phase === 'subscribing')
  )

  const tone = $derived.by(() => {
    if (carrier === 'relay' || carrier === 'webrtc') {
      return srcState === 'live' ? 'live' : 'stale'
    }
    return reaching ? 'reaching' : 'lost'
  })

  const message = $derived.by(() => {
    if (carrier === 'relay' || carrier === 'webrtc') {
      const where = carrier === 'webrtc' ? 'Live at home' : 'Live via encrypted relay'
      switch (srcState) {
        case 'live':
          return where
        case 'never':
          return `${where} · no reading yet`
        case 'down':
          return `${where} · a device stopped responding`
        default:
          // The age rides in its own element now, so the sentence says what
          // the connection is doing and nothing else.
          return `${where} · readings`
      }
    }

    // The box is perfectly reachable; it told this phone to leave. Saying it
    // cannot be reached sends somebody to check their wifi over a decision
    // that was made about them — and the screen below already says what
    // happened, so this one must not contradict it.
    if (phase === 'terminated') return 'Access ended'

    // Not connected. Say how old the readings are, which is the question
    // being asked, rather than diagnosing a connection we have not finished
    // testing.
    if (reaching) return 'Reaching your box'
    return "Can't reach your box"
  })

  /**
   * The age, as its own field.
   *
   * It used to be glued onto the end of the sentence with a middle dot, so
   * two orthogonal facts arrived as one string and neither could be found at
   * a glance. An em dash means the box's clock cannot place the reading at
   * all — after a restart, where pretending to know would be the lie the
   * whole design is built to avoid.
   */
  const ageText = $derived.by(() => {
    if (carrier === 'relay' || carrier === 'webrtc') {
      if (srcState === 'live') return null
      if (srcState === 'never') return null
    }
    if (Number.isNaN(ageMs)) return '—'
    return Number.isFinite(ageMs) ? formatAge(ageMs) : null
  })
</script>

<!-- This is the one claim the whole app rests on, and it was the first thing
     to scroll away. It now sits above the scrolling view rather than inside
     it, so it is answerable at any scroll position — which is what "you
     cannot easily see freshness" was actually about. Sticky as well, so it
     holds that position even if it is ever placed inside a scroller. -->
<div class="band" data-tone={tone} role="status" aria-live="polite">
  <span class="dot" aria-hidden="true"></span>
  <span class="text">{message}</span>
  <!-- The two fields stay two things. The carrier is the dot and the words;
       the age is its own element, in tabular figures so a number that changes
       every second does not shift the line under the reader's eye. -->
  {#if ageText}
    <span class="age num" class:unknown={ageText === '—'}>{ageText}</span>
  {/if}
</div>

<style>
  .band {
    position: sticky;
    top: 0;
    z-index: 5;
    display: flex;
    align-items: center;
    gap: var(--space-2);
    padding: var(--space-2) var(--space-4);
    font-family: var(--mono);
    font-size: 11px;
    letter-spacing: 0.06em;
    color: var(--fg-dim);
    border-bottom: 1px solid var(--line-soft);
    background: var(--surface-sunken);
  }

  .age {
    margin-left: auto;
    font-variant-numeric: tabular-nums;
    color: var(--fg-muted);
    flex: none;
  }

  .age.unknown {
    /* The box cannot place this reading in time. Saying so quietly beats
       showing a number that would be invented. */
    opacity: 0.7;
  }

  .band[data-tone='stale'] .age,
  .band[data-tone='lost'] .age {
    color: var(--fresh-stale);
  }

  .dot {
    width: 6px;
    height: 6px;
    border-radius: 50%;
    flex: none;
    background: var(--fresh-lost);
    transition: background var(--motion-base) var(--ease);
  }

  .band[data-tone='live'] .dot {
    background: var(--fresh-live);
  }

  .band[data-tone='stale'] .dot {
    background: var(--fresh-stale);
  }

  /* Reaching is a neutral, in-progress state — it pulses rather than sitting
     in the colour reserved for something being wrong. */
  .band[data-tone='reaching'] .dot {
    background: var(--fg-muted);
    animation: pulse 1.6s ease-in-out infinite;
  }

  .band[data-tone='stale'] .text,
  .band[data-tone='lost'] .text {
    color: var(--fg-label);
  }

  @keyframes pulse {
    0%,
    100% {
      opacity: 0.35;
    }
    50% {
      opacity: 1;
    }
  }

  @media (prefers-reduced-motion: reduce) {
    .band[data-tone='reaching'] .dot {
      animation: none;
      opacity: 0.6;
    }
  }
</style>
