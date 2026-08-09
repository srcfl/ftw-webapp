/* The charger, as the panel sees it.
 *
 * Two reads over the passthrough: `/api/loadpoints` for what the charger is
 * and does, `/api/mpc/plan` for when the optimiser intends to run it. The
 * first is the panel; the second is decoration on it. They fail separately
 * on purpose — a box old enough to lack the plan route still has a charger
 * worth showing, and a panel that went blank over missing decoration would
 * be the tail wagging the dog.
 *
 * Nothing here commands anything. Round two brings the schedule editor and
 * round three the buttons; until then every field is a fact the box served.
 */

import { callBox, BoxApiError } from './box-api'
import { toLoadpoint, type Loadpoint, type WireLoadpoint } from '$lib/format/ev'
import type { SiteStore } from './site.svelte'

/** One stretch the optimiser intends to charge in. */
export interface ChargeWindow {
  fromMs: number
  toMs: number
  /** The plan's peak for the window, in watts. */
  peakW: number
  /** The box's own reason token for the window's first slot. */
  reason: string
}

interface WireAction {
  slot_start_ms?: unknown
  slot_len_min?: unknown
  reason?: unknown
  loadpoint_power_w?: Record<string, unknown>
}

/**
 * Contiguous plan slots where a charger draws, folded into windows.
 *
 * Adjacent charging slots merge regardless of reason — a person asks "when
 * will it charge", not "when does the reason change" — and the first slot's
 * reason names the window. Slots the plan does not price or does not know
 * the charger in contribute nothing, which quietly carries the box that is
 * mid-replan.
 */
export function chargeWindows(actions: WireAction[], loadpointId: string): ChargeWindow[] {
  const out: ChargeWindow[] = []
  for (const a of actions) {
    const start = typeof a.slot_start_ms === 'number' ? a.slot_start_ms : null
    const len = typeof a.slot_len_min === 'number' ? a.slot_len_min : null
    const w = a.loadpoint_power_w?.[loadpointId]
    if (start === null || len === null || typeof w !== 'number' || w <= 0) continue

    const endMs = start + len * 60_000
    const last = out[out.length - 1]
    if (last && start <= last.toMs) {
      last.toMs = endMs
      last.peakW = Math.max(last.peakW, w)
    } else {
      out.push({
        fromMs: start,
        toMs: endMs,
        peakW: w,
        reason: typeof a.reason === 'string' ? a.reason : '',
      })
    }
  }
  return out
}

export class LoadpointsStore {
  /** Every charger the box reported. Empty until an answer lands. */
  points = $state.raw<Loadpoint[]>([])

  /** The optimiser's coming charge windows, per charger id. */
  windows = $state.raw<Record<string, ChargeWindow[]>>({})

  /**
   * True when the plan read failed while the charger read succeeded. The
   * panel says the windows are missing rather than pretending an empty plan
   * means an idle week.
   */
  planMissing = $state(false)

  /** True only while waiting on the box. Whatever is drawn stays drawn. */
  loading = $state(false)

  /** Whether the box has ever answered. Absence of an answer is not an empty bay. */
  loaded = $state(false)

  /** A sentence, never a code. Null when there is nothing to say. */
  error = $state<string | null>(null)

  #site: SiteStore
  /** Guards a slow answer against a panel that already asked again. */
  #token = 0

  constructor(site: SiteStore) {
    this.#site = site
  }

  /**
   * Ask the box, and keep whatever is on screen until a better answer comes.
   *
   * Rejects when the charger read failed, because the caller that heals this
   * has no other way to tell an answer from a swallowed failure. A failed
   * plan read alone does not reject — it is noted and the ask succeeded.
   */
  async load(): Promise<void> {
    const token = ++this.#token
    this.loading = true
    this.error = null

    try {
      const wire = await callBox<{ enabled?: boolean; loadpoints?: WireLoadpoint[] }>(this.#site, {
        method: 'GET',
        path: '/api/loadpoints',
      })
      if (token !== this.#token) return

      this.points = (wire.loadpoints ?? []).map(toLoadpoint)
      this.loaded = true
      this.error = null
    } catch (err) {
      if (token !== this.#token) return
      this.error =
        err instanceof BoxApiError
          ? this.points.length > 0
            ? 'Not up to date — your box is out of reach'
            : err.help
          : 'Not up to date — your box is out of reach'
      throw err
    } finally {
      if (token === this.#token) this.loading = false
    }

    // The decoration, after the panel is safe. Its failure is a note.
    try {
      const wire = await callBox<{
        plan?: { actions?: WireAction[] }
      }>(this.#site, { method: 'GET', path: '/api/mpc/plan' })
      if (token !== this.#token) return

      const actions = wire.plan?.actions ?? []
      const windows: Record<string, ChargeWindow[]> = {}
      for (const lp of this.points) windows[lp.id] = chargeWindows(actions, lp.id)
      this.windows = windows
      this.planMissing = false
    } catch {
      if (token !== this.#token) return
      this.planMissing = true
    }
  }
}
