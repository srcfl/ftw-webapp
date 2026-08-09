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
  manual_active?: unknown
  surplus_only?: unknown
  battery_boost?: { state?: unknown; active?: unknown }
  schedule?: { soc_pct?: unknown; time_of_day_min_utc?: unknown; recurring?: unknown } | null
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
  manualActive: boolean
  surplusOnly: boolean
  boostActive: boolean
  schedule: { socPct: number | null; timeOfDayMinUtc: number; recurring: boolean } | null
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
          },
  }
}

/** Minutes-of-day in UTC, printed on the kitchen clock. */
export function localClock(minUtc: number, at: Date = new Date()): string {
  const d = new Date(at)
  d.setUTCHours(Math.floor(minUtc / 60), minUtc % 60, 0, 0)
  return d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })
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
 * "Ready by 07:00 · every day", with the target charge in front when the
 * charger can measure it. A schedule the box does not have is null here and
 * no sentence at all — the panel says nothing rather than "no schedule",
 * because an app that cannot read one cannot claim its absence.
 */
export function evScheduleSentence(lp: Loadpoint, at: Date = new Date()): string | null {
  const s = lp.schedule
  if (!s) return null
  const when = localClock(s.timeOfDayMinUtc, at)
  const cadence = s.recurring ? 'every day' : 'once'
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
