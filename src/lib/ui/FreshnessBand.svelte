<!--
  The one place freshness is expressed.

  Two orthogonal facts, never collapsed into one enum:
    carrier  — how frames are reaching us (relay, cache, nothing)
    srcState — whether the box's own sources are answering

  Collapsing them cannot say "connected, but the inverter went quiet 40
  seconds ago", which is exactly the case a user needs to see. Keeping this
  in a single component is what stops the distinction eroding as views are
  added.

  The band never claims live unless frames are arriving now.
-->
<script lang="ts">
  import { formatAge } from '$lib/format/power'
  import type { CarrierState, SourceState } from '$lib/protocol/types'

  interface Props {
    carrier: CarrierState
    /** Worst state across the sources this view depends on. */
    srcState: SourceState
    /** Age of the oldest reading on screen, in ms. */
    ageMs: number
  }

  let { carrier, srcState, ageMs }: Props = $props()

  const tone = $derived.by(() => {
    if (carrier === 'cache' || carrier === 'none') return 'lost'
    if (srcState === 'down' || srcState === 'stale' || srcState === 'never') return 'stale'
    if (srcState === 'lagging') return 'stale'
    return 'live'
  })

  const message = $derived.by(() => {
    if (carrier === 'none') return 'Offline · showing last known'
    if (carrier === 'cache') return `Box unreachable · ${formatAge(ageMs)}`

    const where = carrier === 'webrtc' ? 'Live at home' : 'Live via encrypted relay'

    switch (srcState) {
      case 'never':
        return `${where} · no reading yet`
      case 'down':
        return `${where} · a device stopped responding`
      case 'stale':
        return `${where} · readings ${formatAge(ageMs)}`
      case 'lagging':
        return `${where} · readings ${formatAge(ageMs)}`
      default:
        return where
    }
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

  .band[data-tone='live'] .text {
    color: var(--fg-dim);
  }

  .band[data-tone='stale'] .text,
  .band[data-tone='lost'] .text {
    color: var(--fg-label);
  }
</style>
