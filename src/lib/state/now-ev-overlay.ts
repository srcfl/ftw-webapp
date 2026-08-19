/* Charger watts for the Now diagram, fetched off the first frame.
 *
 * Field 10 on the 1 Hz stream is supposed to be this sum. Until a box
 * counts a charger that cannot take a command, the house node absorbs
 * it. The overlay asks /api/loadpoints — the same SmoothedW the LAN
 * page uses — and Now subtracts it from house.
 *
 * Loaded only after Now has painted. callBox and the loadpoint decoder
 * belong in History and the charger sheet, not the launch chunk, and
 * putting them on Now pushed the entry bundle 33 bytes over the budget.
 */

import { callBox } from './box-api'
import { toLoadpoint, type WireLoadpoint } from '$lib/format/ev'
import { loadpointChargeW } from './flow'
import { CAP_API_PASSTHROUGH } from '$lib/protocol/contract'
import type { SiteStore } from './site.svelte'

const PERIOD_MS = 5_000

/**
 * Poll charger power while the session is live. Calls `onWatts` with the
 * sum of loadpoints that are actually drawing. Returns a stop function.
 */
export function watchLoadpointCharge(site: SiteStore, onWatts: (w: number) => void): () => void {
  let stopped = false
  let timer: ReturnType<typeof setTimeout> | undefined

  const tick = async () => {
    if (stopped) return
    if (site.session.phase === 'streaming' && site.session.caps.has(CAP_API_PASSTHROUGH)) {
      try {
        const wire = await callBox<{ loadpoints?: WireLoadpoint[] }>(site, {
          method: 'GET',
          path: '/api/loadpoints',
        })
        if (!stopped) onWatts(loadpointChargeW((wire.loadpoints ?? []).map(toLoadpoint)))
      } catch {
        // Keep the last reading. A failed ask is not "the car went to 0 W".
      }
    }
    if (!stopped) timer = setTimeout(() => void tick(), PERIOD_MS)
  }

  void tick()
  return () => {
    stopped = true
    clearTimeout(timer)
  }
}
