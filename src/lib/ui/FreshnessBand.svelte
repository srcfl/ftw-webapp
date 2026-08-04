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
  }

  let { carrier, srcState, ageMs, phase }: Props = $props()

  /** Still trying, and has not yet failed. */
  const reaching = $derived(phase === 'idle' || phase === 'handshaking' || phase === 'subscribing')

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
          return `${where} · readings ${formatAge(ageMs)}`
      }
    }

    // Not connected. Say how old the readings are, which is the question
    // being asked, rather than diagnosing a connection we have not finished
    // testing.
    const age = Number.isFinite(ageMs) ? formatAge(ageMs) : null
    if (reaching) return age ? `Reaching your box · ${age}` : 'Reaching your box'
    return age ? `Can't reach your box · ${age}` : "Can't reach your box"
  })
</script>

<div class="band" data-tone={tone} role="status" aria-live="polite">
  <span class="dot" aria-hidden="true"></span>
  <span class="text">{message}</span>
</div>

<style>
  .band {
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
