/* Types for the vendored units table — the surface the app actually uses.
 * The implementation is the box's own file, untouched; see the header there.
 *
 * What a price is quoted in is the box's vocabulary, not this app's: öre for
 * SEK, cent for EUR, and the two currencies that are quoted in the major unit
 * instead. Naming any of that here would be hand-writing a name shared with
 * the box, so the table comes across with the component that reads it.
 */

export interface FtwPriceUnit {
  /** The unit on its own: "öre", "cent", "Kč". */
  label: string
  /** The unit per kWh: "öre/kWh", "cent/kWh". */
  perKwh: string
  /** What a stored minor unit is multiplied by for display. */
  scale: number
  /** How many decimals this currency is worth showing. */
  decimals: number
}

export function unitFor(currency: string): FtwPriceUnit
export function unitLabel(currency: string): string
export function unitPerKwh(currency: string): string
export function toDisplay(minorPerKwh: number, currency: string): number

/**
 * A stored minor-unit value as text with its unit: "144.0 öre".
 *
 * The whole rendering, unit and all, which is what the chart draws. Used as
 * the reference the timeline's own column is tested against — a number this
 * app writes and a number the box writes have to agree.
 */
export function formatPrice(minorPerKwh: number, currency: string, decimals?: number): string

/**
 * The currency of the last price window anyone read, "SEK" until one lands.
 *
 * For the surfaces that show a price without ever fetching one — the plan
 * timeline here, the plan tooltip and the diagnose page on the box.
 */
export function activeCurrency(): string
