/* The dashboard's own live snapshot, fetched off the first frame.
 *
 * Frozen fields on the 1 Hz stream are five aggregates. GET /api/status is
 * the document the box page already draws the hero from: per-driver
 * planets, kWh today, the fuse. Same cadence as that page — two seconds —
 * and the same rule as the charger overlay: callBox stays out of the
 * launch chunk.
 *
 * A failed or overdue ask marks the retained snapshot as old.
 */

import { callBox } from './box-api'
import { CAP_API_PASSTHROUGH } from '$lib/protocol/contract'
import type { SiteStatus } from './flow'
import type { SiteStore } from './site.svelte'

const PERIOD_MS = 2_000
export const STATUS_MAX_AGE_MS = 15_000

export interface StatusSnapshot {
  status: SiteStatus | null
  receivedAt: number | null
  fresh: boolean
}

function asStatus(wire: unknown): SiteStatus | null {
  if (!wire || typeof wire !== 'object') return null
  return wire as SiteStatus
}

/**
 * Poll /api/status while the session is live. Calls `onStatus` with each
 * snapshot that looks like one. Returns a stop function.
 */
export function watchStatus(site: SiteStore, onStatus: (snapshot: StatusSnapshot) => void): () => void {
  let stopped = false
  let timer: ReturnType<typeof setTimeout> | undefined
  let expiry: ReturnType<typeof setTimeout> | undefined
  let snapshot: StatusSnapshot = { status: null, receivedAt: null, fresh: false }

  const expire = () => {
    if (stopped) return
    snapshot = { ...snapshot, fresh: false }
    onStatus(snapshot)
  }

  const tick = async () => {
    if (stopped) return
    if (site.session.phase === 'streaming' && site.session.caps.has(CAP_API_PASSTHROUGH)) {
      try {
        const startedAt = performance.now()
        const wire = await callBox<unknown>(site, { method: 'GET', path: '/api/status' })
        const status = asStatus(wire)
        if (stopped) return
        if (!status) throw new Error('Missing status')
        const age = performance.now() - startedAt
        snapshot = {
          status,
          receivedAt: Date.now(),
          fresh: age < STATUS_MAX_AGE_MS && site.session.phase === 'streaming',
        }
        clearTimeout(expiry)
        onStatus(snapshot)
        // Expire even if the next request remains pending. Timers use elapsed
        // time; changing the phone's wall clock must not extend freshness.
        expiry = setTimeout(expire, Math.max(0, STATUS_MAX_AGE_MS - age))
      } catch {
        clearTimeout(expiry)
        expire()
      }
    } else expire()
    if (stopped) return
    timer = setTimeout(() => void tick(), PERIOD_MS)
  }

  void tick()
  return () => {
    expire()
    stopped = true
    clearTimeout(timer)
    clearTimeout(expiry)
  }
}
