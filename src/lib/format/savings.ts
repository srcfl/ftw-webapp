/* Compact savings figures, from GET /api/savings/daily.
 *
 * The box page's compact card is a self-fetching web component. It talks
 * HTTP to the box origin, which this app does not have, so the math is
 * copied here and the fetch goes through the session. Same rounding, same
 * periods, so a person comparing the two screens sees the same money.
 */

export const SAVINGS_LOOKBACK_DAYS = 31

export interface SavingsDay {
  day: string
  savedOre: number
  resolution: string
}

export interface SavingsPeriod {
  savedMinor: number
  pricedDays: number
  totalDays: number
  available: boolean
  complete: boolean
}

export interface SavingsPeriods {
  today: SavingsPeriod
  week: SavingsPeriod
  month: SavingsPeriod
}

function finite(value: unknown): number {
  const n = Number(value)
  return Number.isFinite(n) ? n : 0
}

function summarize(rows: readonly SavingsDay[]): SavingsPeriod {
  const priced = rows.filter((row) => row.resolution !== 'no_prices')
  return {
    savedMinor: priced.reduce((sum, row) => sum + row.savedOre, 0),
    pricedDays: priced.length,
    totalDays: rows.length,
    available: priced.length > 0,
    complete: rows.length > 0 && priced.length === rows.length,
  }
}

/** One row off the wire, unknown-tolerant. */
export function toSavingsDay(row: {
  day?: unknown
  saved_ore?: unknown
  resolution?: unknown
}): SavingsDay | null {
  const day = typeof row.day === 'string' ? row.day : ''
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) return null
  return {
    day,
    savedOre: finite(row.saved_ore),
    resolution: typeof row.resolution === 'string' ? row.resolution : 'slot',
  }
}

export function buildSavingsPeriods(days: readonly SavingsDay[]): SavingsPeriods {
  const rows = [...days].sort((a, b) => a.day.localeCompare(b.day))
  const latest = rows[rows.length - 1]
  const monthKey = latest ? latest.day.slice(0, 7) : ''

  return {
    today: summarize(rows.slice(-1)),
    week: summarize(rows.slice(-7)),
    month: summarize(monthKey ? rows.filter((row) => row.day.startsWith(`${monthKey}-`)) : []),
  }
}

/**
 * Minor units in, signed major units out. The currency sits once in the
 * heading, which leaves room for the three values on a phone.
 */
export function formatCompactMinor(minor: number): string {
  const major = finite(minor) / 100
  const absolute = Math.abs(major)
  const digits = absolute >= 100 ? 0 : absolute >= 10 ? 1 : 2
  return (major >= 0 ? '+' : '−') + absolute.toFixed(digits)
}
