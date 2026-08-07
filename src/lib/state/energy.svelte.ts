/* What the house used, made, bought and sold — day by day.
 *
 * The first view built on the API passthrough, and it is the reason the
 * passthrough exists: this is one GET against a route the box has served for
 * a year, and before now it would have needed a new message type, a new box
 * release, and a wait.
 *
 * Everything here is integer watt-hours. The box answers in floating point,
 * this rounds once at the door, and the totals are sums of integers — so the
 * figure over the chart is exactly the sum of the bars under it.
 */

import { callBox, BoxApiError } from './box-api'
import { wholeWh } from '$lib/format/energy'
import type { SiteStore } from './site.svelte'

export type EnergyRangeKey = 'today' | '7d' | '30d'

export interface EnergyRangeSpec {
  label: string
  /** Days to ask the box for, today included. */
  days: number
  /** What the summary is a total of, in the household's own words. */
  title: string
}

export const ENERGY_RANGES: Record<EnergyRangeKey, EnergyRangeSpec> = {
  today: { label: 'Today', days: 1, title: 'Today' },
  '7d': { label: '7 days', days: 7, title: 'Last 7 days' },
  '30d': { label: '30 days', days: 30, title: 'Last 30 days' },
}

export const ENERGY_RANGE_KEYS: EnergyRangeKey[] = ['today', '7d', '30d']

/** One local day, as the box's `/api/energy/daily` reports it. */
export interface EnergyDay {
  /** YYYY-MM-DD in the box's own time zone. */
  day: string
  loadWh: number
  pvWh: number
  importWh: number
  exportWh: number
  batChargedWh: number
  batDischargedWh: number
}

export interface EnergyTotals {
  loadWh: number
  pvWh: number
  importWh: number
  exportWh: number
  batChargedWh: number
  batDischargedWh: number
}

const ZERO: EnergyTotals = {
  loadWh: 0,
  pvWh: 0,
  importWh: 0,
  exportWh: 0,
  batChargedWh: 0,
  batDischargedWh: 0,
}

interface WireDay {
  day?: unknown
  load_wh?: unknown
  pv_wh?: unknown
  import_wh?: unknown
  export_wh?: unknown
  bat_charged_wh?: unknown
  bat_discharged_wh?: unknown
}

export class EnergyStore {
  range = $state<EnergyRangeKey>('7d')

  /** Oldest first, today last. Empty until an answer lands. */
  days = $state.raw<EnergyDay[]>([])

  /** True only while waiting on the box. Whatever is drawn stays drawn. */
  loading = $state(false)

  /**
   * Whether the box has ever answered with a set of days.
   *
   * Three states, not two, for the same reason the roster needs three: a
   * period this app has not read is not a period with nothing in it. Without
   * this, a box that answers the handshake and then starts for four minutes —
   * capabilities known, no reading yet, so nothing has asked — has its
   * household told that nothing was recorded all week. That is a claim about
   * their home built out of an empty array.
   */
  loaded = $state(false)

  /** A sentence, never a code. Null when there is nothing to say. */
  error = $state<string | null>(null)

  #site: SiteStore
  /** Guards a slow answer for a range the user has already moved off. */
  #token = 0

  constructor(site: SiteStore) {
    this.#site = site
  }

  get spec(): EnergyRangeSpec {
    return ENERGY_RANGES[this.range]
  }

  get totals(): EnergyTotals {
    return this.days.reduce<EnergyTotals>(
      (sum, d) => ({
        loadWh: sum.loadWh + d.loadWh,
        pvWh: sum.pvWh + d.pvWh,
        importWh: sum.importWh + d.importWh,
        exportWh: sum.exportWh + d.exportWh,
        batChargedWh: sum.batChargedWh + d.batChargedWh,
        batDischargedWh: sum.batDischargedWh + d.batDischargedWh,
      }),
      ZERO
    )
  }

  /**
   * Choose what the figures cover.
   *
   * Only sets the range, exactly as the history chart does: the range is the
   * question `askWhenLive` asks under, so changing it is already what fetches
   * and what heals a tap whose answer never arrives. Fetching here as well
   * would spend a second round trip on one tap.
   */
  select(range: EnergyRangeKey): void {
    this.range = range
  }

  /**
   * Ask the box, and keep whatever is on screen until a better answer comes.
   *
   * Rejects when the box did not answer, because the caller that heals this
   * has no other way to tell an answer from a failure that was swallowed.
   */
  async load(): Promise<void> {
    const token = ++this.#token
    const days = this.spec.days

    this.loading = true
    this.error = null

    try {
      const wire = await callBox<{ days?: WireDay[] }>(this.#site, {
        method: 'GET',
        path: '/api/energy/daily',
        query: { days: String(days) },
      })
      if (token !== this.#token) return

      this.days = (wire.days ?? []).map(toDay)
      this.loaded = true
      this.error = null
    } catch (err) {
      // An answer for a range the user has already moved off is not this
      // range's news, and not a reason to ask for this one again.
      if (token !== this.#token) return

      // What happens now. Whatever was drawn stays drawn — last week's totals
      // are still last week's — with a line saying they are not current.
      this.error =
        err instanceof BoxApiError
          ? this.days.length > 0
            ? 'Not up to date — your box is out of reach'
            : err.help
          : 'Not up to date — your box is out of reach'
      throw err
    } finally {
      if (token === this.#token) this.loading = false
    }
  }
}

function toDay(row: WireDay): EnergyDay {
  return {
    day: typeof row.day === 'string' ? row.day : '',
    loadWh: wholeWh(row.load_wh),
    pvWh: wholeWh(row.pv_wh),
    importWh: wholeWh(row.import_wh),
    exportWh: wholeWh(row.export_wh),
    batChargedWh: wholeWh(row.bat_charged_wh),
    batDischargedWh: wholeWh(row.bat_discharged_wh),
  }
}
