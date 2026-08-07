/* Energy in words.
 *
 * Watt-hours cross the wire and kilowatt-hours go on screen, and the
 * conversion happens exactly once, here. Two numbers that appear beside each
 * other — a bar's label and the total above it — must come through this same
 * function, or the column tops will not add up to the figure over them and the
 * household will be right to distrust both.
 *
 * The thresholds are the box's own `formatKWh` in web/energy-history.js: one
 * decimal below ten, none above. Copied deliberately rather than improved, so
 * a person comparing this screen with their box's own page sees the same
 * figure rather than two roundings of it.
 */

/**
 * Watt-hours as an integer, from whatever the box sent.
 *
 * The box integrates in floating point and answers with a real number. This is
 * the one rounding step: everything downstream adds and formats integers, so
 * no two screens can round the same quantity differently.
 *
 * Clamped at zero because every figure the daily endpoint returns is a
 * magnitude by construction — import is grid above zero, export is the size of
 * grid below it, solar is the size of a PV reading that is never positive. A
 * negative one is a counter fault on the box, and a bar below the axis would
 * be this app inventing a meaning for it.
 */
export function wholeWh(value: unknown): number {
  const n = Number(value)
  if (!Number.isFinite(n) || n <= 0) return 0
  return Math.round(n)
}

export interface EnergyText {
  text: string
  unit: string
}

/** Kilowatt-hours, split so the unit can be styled apart from the figure. */
export function formatEnergy(wh: number): EnergyText {
  const kwh = wh / 1000
  const digits = kwh < 10 ? 1 : 0
  return {
    text: kwh.toLocaleString(undefined, {
      minimumFractionDigits: digits,
      maximumFractionDigits: digits,
    }),
    unit: 'kWh',
  }
}

/** The same figure as one string, for a tooltip or a bar's own label. */
export function energyLabel(wh: number): string {
  const parts = formatEnergy(wh)
  return `${parts.text} ${parts.unit}`
}
