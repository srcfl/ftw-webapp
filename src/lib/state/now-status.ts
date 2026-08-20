/* The dashboard's own live snapshot, fetched off the first frame.
 *
 * Frozen fields on the 1 Hz stream are five aggregates. GET /api/status is
 * the document the box page already draws the hero from: per-driver
 * planets, kWh today, the fuse. Same cadence as that page — two seconds —
 * and the same rule as the charger overlay: callBox stays out of the
 * launch chunk.
 *
 * A failed ask keeps the last snapshot. A 404 is not "the house went away".
 */

import { callBox } from './box-api'
import { CAP_API_PASSTHROUGH } from '$lib/protocol/contract'
import type { SiteStatus } from './flow'
import type { SiteStore } from './site.svelte'

const PERIOD_MS = 2_000

function asStatus(wire: unknown): SiteStatus | null {
  if (!wire || typeof wire !== 'object') return null
  return wire as SiteStatus
}

/**
 * Poll /api/status while the session is live. Calls `onStatus` with each
 * snapshot that looks like one. Returns a stop function.
 */
export function watchStatus(site: SiteStore, onStatus: (status: SiteStatus) => void): () => void {
  let stopped = false
  let timer: ReturnType<typeof setTimeout> | undefined

  const tick = async () => {
    if (stopped) return
    if (site.session.phase === 'streaming' && site.session.caps.has(CAP_API_PASSTHROUGH)) {
      try {
        const wire = await callBox<unknown>(site, { method: 'GET', path: '/api/status' })
        const status = asStatus(wire)
        if (!stopped && status) onStatus(status)
      } catch {
        // Keep the last snapshot. A failed ask is not "the house went idle".
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
