/* Words for the charger.
 *
 * The box reports state; every sentence a person reads is this app's. The
 * schedule crosses the wire as minutes-of-day in UTC because that is what the
 * box stores — the conversion to the kitchen clock happens here, at the last
 * moment, the same place every other wire convention is translated.
 *
 * No sentence here claims what the box has not said. A charger that does not
 * know the car's charge is described by what it does know — power, time,
 * energy delivered — never by an invented percentage.
 */

import { formatPower } from './power'

/** The box's own field names for one charger, as `/api/loadpoints` serves them. */
export interface WireLoadpoint {
  id?: unknown
  driver_name?: unknown
  plugged_in?: unknown
  current_soc_pct?: unknown
  current_power_w?: unknown
  delivered_wh_session?: unknown
  target_soc_pct?: unknown
  updated_at_ms?: unknown
  soc_source?: unknown
  max_charge_w?: unknown
  manual_active?: unknown
  surplus_only?: unknown
  battery_boost?: { state?: unknown; active?: unknown }
  schedule?: {
    soc_pct?: unknown
    time_of_day_min_utc?: unknown
    recurring?: unknown
    days?: unknown
  } | null
}

export interface Loadpoint {
  id: string
  /** Whether a cable is in. False means the rest is about an empty bay. */
  pluggedIn: boolean
  /** Watts flowing into the car right now. */
  powerW: number
  /** The car's charge, or null for a charger that honestly does not know. */
  socPct: number | null
  targetSocPct: number | null
  /** What this session has delivered, in watt-hours. */
  sessionWh: number
  /** The charger's ceiling, for a charge-now hold. Null when unreported. */
  maxChargeW: number | null
  manualActive: boolean
  surplusOnly: boolean
  boostActive: boolean
  schedule: {
    socPct: number | null
    timeOfDayMinUtc: number
    recurring: boolean
    /** 7-bit weekday mask, bit 0 = Monday. Zero means every day. */
    days: number
  } | null
}

const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null)

/** One charger off the wire, unknown-tolerant the way every decoder here is. */
export function toLoadpoint(w: WireLoadpoint): Loadpoint {
  const sched = w.schedule
  const schedMin = sched ? num(sched.time_of_day_min_utc) : null
  return {
    id: typeof w.id === 'string' ? w.id : '',
    pluggedIn: w.plugged_in === true,
    powerW: num(w.current_power_w) ?? 0,
    socPct: num(w.current_soc_pct),
    targetSocPct: num(w.target_soc_pct),
    sessionWh: Math.max(0, Math.round(num(w.delivered_wh_session) ?? 0)),
    maxChargeW: num(w.max_charge_w),
    manualActive: w.manual_active === true,
    surplusOnly: w.surplus_only === true,
    boostActive: w.battery_boost?.active === true,
    schedule:
      schedMin === null
        ? null
        : {
            socPct: num(sched!.soc_pct),
            timeOfDayMinUtc: schedMin,
            recurring: sched!.recurring === true,
            days: (num(sched!.days) ?? 0) & 0x7f,
          },
  }
}

/** Minutes-of-day in UTC, printed on the kitchen clock. */
export function localClock(minUtc: number, at: Date = new Date()): string {
  const d = new Date(at)
  d.setUTCHours(Math.floor(minUtc / 60), minUtc % 60, 0, 0)
  return d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })
}

/** The same conversion, for an <input type="time"> value: "HH:MM" local. */
export function utcMinutesToLocalInput(minUtc: number, at: Date = new Date()): string {
  const d = new Date(at)
  d.setUTCHours(Math.floor(minUtc / 60), minUtc % 60, 0, 0)
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
}

/**
 * A local "HH:MM" back to the wire's UTC minutes-of-day.
 *
 * Anchored on `at`, so it is exact for today's offset — the same rule the
 * box's own page uses when it saves. The stored minute is fixed; a DST
 * change shifts the local deadline an hour until re-saved, a known drift
 * the box documents where it computes the deadline.
 */
export function localInputToUtcMinutes(hhmm: string, at: Date = new Date()): number | null {
  const m = hhmm.match(/^(\d{1,2}):(\d{2})$/)
  if (!m) return null
  const h = Number(m[1])
  const min = Number(m[2])
  // setHours would roll "25:99" into tomorrow rather than refuse it.
  if (h > 23 || min > 59) return null
  const d = new Date(at)
  d.setHours(h, min, 0, 0)
  return d.getUTCHours() * 60 + d.getUTCMinutes()
}

/** ISO order, matching the wire mask: bit 0 = Monday. */
export const DAY_LABELS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'] as const

/**
 * The weekday mask as a person says it.
 *
 * Whole-week, weekday and weekend masks get their own words; anything
 * else is the short names in week order. Zero is every day — the wire's
 * meaning for a schedule saved before masks existed.
 */
export function daysWord(mask: number): string {
  const m = mask & 0x7f
  if (m === 0 || m === 0x7f) return 'every day'
  if (m === 0b0011111) return 'weekdays'
  if (m === 0b1100000) return 'weekends'
  return DAY_LABELS.filter((_, i) => m & (1 << i)).join(', ')
}

/**
 * The headline: what the charger is doing at this moment.
 *
 * Power leads when there is any, because "Charging at 7.2 kW" is the one
 * fact someone opens this panel for. The idle cases say what is true about
 * the bay, never what might happen later — the schedule line owns later.
 */
export function evStatusSentence(lp: Loadpoint): string {
  if (!lp.pluggedIn) return 'Not plugged in'
  if (lp.powerW > 0) {
    const p = formatPower(lp.powerW)
    return `Charging at ${p.text} ${p.unit}`
  }
  return 'Plugged in — not charging right now'
}

/**
 * The schedule, as one sentence.
 *
 * "Ready by 07:00 · weekdays", with the target charge in front when the
 * charger can measure it. A schedule the box does not have is null here and
 * no sentence at all — the panel says nothing rather than "no schedule",
 * because an app that cannot read one cannot claim its absence.
 */
export function evScheduleSentence(lp: Loadpoint, at: Date = new Date()): string | null {
  const s = lp.schedule
  if (!s) return null
  const when = localClock(s.timeOfDayMinUtc, at)
  const cadence = s.recurring ? daysWord(s.days) : 'once'
  const target = s.socPct !== null && lp.socPct !== null ? `${Math.round(s.socPct)} % ` : ''
  return `${target}Ready by ${when} · ${cadence}`
}

/** "3.0 kWh this session", rounded the way a person says it. */
export function evSessionSentence(lp: Loadpoint): string | null {
  if (!lp.pluggedIn || lp.sessionWh < 50) return null
  const kwh = lp.sessionWh / 1000
  const text = kwh >= 10 ? String(Math.round(kwh)) : kwh.toFixed(1)
  return `${text} kWh this session`
}
