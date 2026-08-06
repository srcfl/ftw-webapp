/* Types for the vendored component — the surface the app actually uses.
 * The implementation is the box's own file, untouched; see the header there.
 */

/** One slot in the component's own vocabulary. Minor units per kWh. */
export interface FtwPriceChartSlot {
  tsMs: number
  lenMin: number
  spot: number
  /** With tariff and tax added. Absent means the component computes it. */
  total?: number
}

export interface FtwPriceChartWindow {
  zone: string
  currency: string
  slots: FtwPriceChartSlot[]
  /** The prices stop short of the window asked for. */
  stale: boolean
}

export interface FtwPriceChartElement extends HTMLElement {
  setPrices(window: FtwPriceChartWindow): void
}
