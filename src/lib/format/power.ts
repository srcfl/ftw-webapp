/* Power formatting.
 *
 * FTW's sign convention: positive watts flow INTO the site, negative out.
 * That convention is right for the wire and wrong for a person — nobody
 * reads "-4200 W" and thinks "the battery is covering the house". So the
 * UI never renders a raw minus sign. It renders a direction word and a
 * magnitude, and the caller supplies the vocabulary for its own context.
 */

export type Direction = 'in' | 'out' | 'idle'

/**
 * Below this, a reading is sensor noise rather than a real flow.
 *
 * Exported and shared with the explanation layer on purpose. Two different
 * thresholds put contradictions on screen: the headline said solar was
 * covering everything while the grid card underneath read "23 W drawing".
 * One threshold, one truth.
 */
export const NOISE_W = 50

export interface PowerParts {
  /** Magnitude, already scaled to `unit`. Never negative. */
  value: number
  unit: 'W' | 'kW' | 'MW'
  direction: Direction
  /** Ready to render: "4.2" — fixed decimals so digits do not jump. */
  text: string
}

export function directionOf(watts: number): Direction {
  if (!Number.isFinite(watts) || Math.abs(watts) < NOISE_W) return 'idle'
  return watts > 0 ? 'in' : 'out'
}

/**
 * Split a signed wattage into magnitude, unit and direction.
 *
 * Decimals are chosen so the number holds roughly three significant figures
 * and, more importantly, so the digit count is stable across a plausible
 * range. A value flipping between "1.9 kW" and "12 kW" must not resize its
 * own container mid-stream.
 */
export function formatPower(watts: number): PowerParts {
  const direction = directionOf(watts)
  const abs = Number.isFinite(watts) ? Math.abs(watts) : 0

  if (abs < 1000) {
    return { value: Math.round(abs), unit: 'W', direction, text: String(Math.round(abs)) }
  }

  if (abs < 1_000_000) {
    const kw = abs / 1000
    // Under 10 kW one decimal reads naturally; above it the decimal is noise.
    const decimals = kw < 10 ? 1 : 0
    return { value: kw, unit: 'kW', direction, text: kw.toFixed(decimals) }
  }

  const mw = abs / 1_000_000
  return { value: mw, unit: 'MW', direction, text: mw.toFixed(mw < 10 ? 2 : 1) }
}

/**
 * A wattage for a chart's vertical scale.
 *
 * Separate from formatPower because a scale has a different job from a
 * reading. Its numbers are round by construction — a 1, 2 or 5 step — so a
 * forced decimal only makes "5.0 kW" sit under "10 kW" and look like a
 * mistake. Same rule about the sign, though: the magnitude and nothing else,
 * because the direction is a word on the axis, not a minus on every rung.
 */
export function formatScaleWatts(watts: number): string {
  if (!Number.isFinite(watts)) return ''
  const abs = Math.abs(watts)
  if (abs < 1000) return `${Math.round(abs)} W`
  if (abs < 1_000_000) return `${trim(abs / 1000)} kW`
  return `${trim(abs / 1_000_000)} MW`
}

/** One decimal, and not even that when it would be a zero. */
function trim(value: number): string {
  return String(Math.round(value * 10) / 10)
}

/** State of charge arrives as permille to keep deltas integral. */
export function formatSoc(permille: number): string {
  if (!Number.isFinite(permille)) return '—'
  return String(Math.round(permille / 10))
}

/**
 * How old a reading is, in words.
 *
 * Ages come from the box's uptime, never its wall clock — a Pi has no RTC and
 * reads 1970 until NTP answers. See docs/protocol.md.
 *
 * Deliberately coarse: a number ticking up second by second draws the eye to
 * the staleness rather than to the reading, and past a minute the precision
 * is false comfort anyway.
 */
export function formatAge(ageMs: number): string {
  if (!Number.isFinite(ageMs) || ageMs < 0) return 'unknown'
  const s = Math.floor(ageMs / 1000)
  if (s < 5) return 'just now'
  if (s < 60) return `${s}s ago`
  const m = Math.floor(s / 60)
  if (m < 60) return `${m} min ago`
  const h = Math.floor(m / 60)
  if (h < 24) return `${h} h ago`
  const d = Math.floor(h / 24)
  return `${d} d ago`
}
