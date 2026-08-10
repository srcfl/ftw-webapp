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
    /** Open transport, which may exist before it has delivered a reading. */
    transport?: CarrierState
    /** Worst state across the sources this view depends on. */
    srcState: SourceState
    /** Age of the oldest reading on screen, in ms. */
    ageMs: number
    phase: SessionPhase
    /** Time since this attempt began. Driven by the store's one shared clock. */
    waitMs?: number
    /** The last frame restarts the live dot's short beat. */
    frameAtMs?: number | null
    /** Real progress sent by a box that is starting. */
    bootPct?: number | null
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

  let {
    carrier,
    transport = 'none',
    srcState,
    ageMs,
    phase,
    waitMs = 0,
    frameAtMs = null,
    bootPct = null,
    noCarrier = false,
  }: Props = $props()

  /** Still trying, and has not yet failed. */
  const reaching = $derived(
    !noCarrier &&
      (phase === 'idle' ||
        phase === 'handshaking' ||
        phase === 'subscribing' ||
        phase === 'failed' ||
        phase === 'booting')
  )

  const tone = $derived.by(() => {
    if (carrier === 'relay' || carrier === 'webrtc') {
      return srcState === 'live' ? 'live' : 'stale'
    }
    return reaching ? 'reaching' : 'lost'
  })

  const message = $derived.by(() => {
    if (carrier === 'relay' || carrier === 'webrtc') {
      const liveWhere = carrier === 'webrtc' ? 'Live at home' : 'Live via encrypted relay'
      const connected = carrier === 'webrtc' ? 'Home link connected' : 'Encrypted relay connected'
      switch (srcState) {
        case 'live':
          return liveWhere
        case 'never':
          return `${connected} · no reading yet`
        case 'down':
          return `${connected} · a device stopped responding`
        default:
          // The age rides in its own element now, so the sentence says what
          // the connection is doing and nothing else.
          return `${connected} · readings`
      }
    }

    // The box is perfectly reachable; it told this phone to leave. Saying it
    // cannot be reached sends somebody to check their wifi over a decision
    // that was made about them — and the screen below already says what
    // happened, so this one must not contradict it.
    if (phase === 'terminated') return 'Access ended'

    if (phase === 'booting') return 'Your box is starting'

    // Not connected. Say how old the readings are, which is the question
    // being asked, rather than diagnosing a connection we have not finished
    // testing.
    if (reaching) {
      if (phase === 'failed') return 'Reconnecting to your box'
      if (phase === 'subscribing') return 'Waiting for live readings'
      if (phase === 'handshaking' && transport === 'relay') return 'Securing encrypted relay'
      if (phase === 'handshaking' && transport === 'webrtc') return 'Securing home link'
      return 'Connecting to your box'
    }
    return "Can't reach your box"
  })

  const waitText = $derived.by(() => {
    if (!reaching) return null
    if (phase === 'booting' && bootPct !== null) return `${Math.round(bootPct)}%`
    return `${Math.max(0, Math.floor(waitMs / 1_000))}s`
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
  {#key frameAtMs}
    <span class="dot" data-beat={tone === 'live' && frameAtMs !== null} aria-hidden="true"></span>
  {/key}
  <span class="text">{message}</span>
  {#if waitText}
    <!-- This changes every second. Keep it visual so VoiceOver announces the
         state change, not a spoken countdown on every tick. -->
    <span class="wait num" aria-hidden="true">{waitText}</span>
  {/if}
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

  .wait {
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

  .band[data-tone='live'] .dot[data-beat='true'] {
    animation: live-beat 680ms var(--ease) both;
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

  @keyframes live-beat {
    0% {
      opacity: 0.55;
      transform: scale(0.78);
    }
    35% {
      opacity: 1;
      transform: scale(1.35);
    }
    100% {
      opacity: 1;
      transform: scale(1);
    }
  }

  @media (prefers-reduced-motion: reduce) {
    .band[data-tone='reaching'] .dot {
      animation: none;
      opacity: 0.6;
    }

    .band[data-tone='live'] .dot[data-beat='true'] {
      animation: none;
    }
  }
</style>
