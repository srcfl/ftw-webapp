/* History, as the view sees it.
 *
 * The order matters more than anything else here: paint from cache first,
 * then ask the box for the difference, then replace. Opening the chart must
 * never show an empty rectangle while a request is in flight, for the same
 * reason the Now screen paints from its snapshot — a spinner on a white
 * background is what makes an app feel like a web page.
 *
 * The vertical axis is held still while that swap happens. A chart that
 * rescales the moment sharper data lands makes the house look like it did
 * something, and it did not.
 */

import type { HistChunk, HistEnd, Resolution } from '$lib/protocol/messages'
import {
  RESOLUTIONS,
  planQuery,
  assembleFrame,
  clipFrame,
  type SeriesFrame,
  type TileData,
} from '$lib/protocol/history'
import { loadTiles, saveTile, haveList, pruneTiles } from '$lib/store/tiles'
import { domainOf, type Domain } from '$lib/ui/chart'
import type { SiteStore } from './site.svelte'

export type RangeKey = '24h' | '7d' | '30d' | '1y'

export interface RangeSpec {
  label: string
  spanMs: number
  /** What to ask for. The box clamps it coarser when the window is too wide. */
  res: Resolution
}

const DAY_MS = 86_400_000

export const RANGES: Record<RangeKey, RangeSpec> = {
  '24h': { label: '24 h', spanMs: DAY_MS, res: '5m' },
  '7d': { label: '7 d', spanMs: 7 * DAY_MS, res: '5m' },
  '30d': { label: '30 d', spanMs: 30 * DAY_MS, res: '5m' },
  '1y': { label: '1 y', spanMs: 365 * DAY_MS, res: '1h' },
}

export const RANGE_KEYS: RangeKey[] = ['24h', '7d', '30d', '1y']

/** Names from contract/registry.yaml, in the order they are drawn. */
export const SERIES = ['grid_w', 'pv_w', 'battery_w', 'load_w'] as const

/** Roughly four points per pixel on a phone. Past that the wire carries detail
 *  no display can show. */
const MAX_POINTS = 1500

export class HistoryStore {
  range = $state<RangeKey>('24h')

  /** What the chart draws. Never null once anything has been cached. */
  frame = $state.raw<SeriesFrame | null>(null)

  /** What the box actually served, which may be coarser than asked for. */
  resActual = $state<Resolution | null>(null)

  gaps = $state.raw<HistEnd['gaps']>([])

  /** Held while a request is in flight, so the axis cannot jump under a swap. */
  lockedDomain = $state.raw<Domain | null>(null)

  /** True only while waiting for the box; the chart is drawn either way. */
  loading = $state(false)

  /** Prose, not a code. Null when there is nothing to say. */
  error = $state<string | null>(null)

  cursor = $state<number | null>(null)

  #site: SiteStore
  /** Guards against a slow reply for a range the user already moved off. */
  #token = 0

  constructor(site: SiteStore) {
    this.#site = site
  }

  /** Time of the sample under the cursor, or null. */
  get cursorAtMs(): number | null {
    const frame = this.frame
    if (!frame || this.cursor === null) return null
    return frame.startMs + this.cursor * frame.stepMs
  }

  select(range: RangeKey): void {
    if (range === this.range && this.frame) return
    this.range = range
    void this.load()
  }

  /**
   * Fill the chart: cache first, box second.
   *
   * Never rejects. A history request that fails leaves whatever was cached on
   * screen with a line saying it is not current, because that is more useful
   * than an empty chart and an apology.
   */
  async load(): Promise<void> {
    const token = ++this.#token
    const spec = RANGES[this.range]
    const siteId = this.#site.siteId

    const toMs = Date.now()
    const fromMs = toMs - spec.spanMs
    const plan = planQuery(spec.res, fromMs, toMs, MAX_POINTS)
    const names = [...SERIES]

    const tiles = new Map<string, TileData>()
    const cached = siteId ? await loadTiles(siteId, plan.tiles.map((t) => t.tileId)) : new Map()
    if (token !== this.#token) return

    for (const [id, tile] of cached) tiles.set(id, tile)

    const show = () => {
      const frame = clipFrame(assembleFrame(plan, names, tiles), fromMs, toMs)
      this.frame = frame
      return frame
    }

    if (tiles.size > 0) {
      // Whatever is on disk goes up now, and the axis it implies is the axis
      // the sharper data will land on.
      this.lockedDomain = domainOf(show().columns)
    }

    this.loading = true
    this.error = null

    try {
      const end = await this.#site.history(
        {
          series: names,
          res: spec.res,
          fromMs,
          toMs,
          have: haveList(cached),
          maxPoints: MAX_POINTS,
        },
        (chunk: HistChunk) => {
          if (token !== this.#token) return
          tiles.set(chunk.tileId, chunk)
          if (siteId) void saveTile(siteId, chunk)
          show()
        }
      )

      if (token !== this.#token) return

      this.resActual = end.resActual
      this.gaps = end.gaps
      show()

      if (siteId) void pruneTiles(siteId, toMs - RESOLUTIONS[end.resActual].retentionMs)
    } catch {
      if (token !== this.#token) return
      // What happens now, not what broke inside. The cached chart stays up.
      this.error = tiles.size > 0 ? 'Not up to date — your box is out of reach' : 'No history yet'
    } finally {
      if (token === this.#token) {
        this.loading = false
        // The new series is in. Release the axis so it can fit what is there.
        this.lockedDomain = null
      }
    }
  }
}
