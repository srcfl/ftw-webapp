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
  vehicle_capacity_wh?: unknown
  capacity_source?: unknown
  soc_retention?: unknown
  charging_declined?: unknown
  /** A 0–1 fraction since srcfl/ftw#962; `current_soc_pct` is what older boxes served. */
  current_soc?: unknown
  current_soc_pct?: unknown
  current_power_w?: unknown
  delivered_wh_session?: unknown
  target_soc?: unknown
  target_soc_pct?: unknown
  manual?: WireManualStatus
  charger?: { known?: unknown; available?: unknown; updated_at_ms?: unknown; reason?: unknown; limit_a?: unknown }
  grid_deferred?: unknown
  plan_next_start_ms?: unknown
  plan_next_end_ms?: unknown
  updated_at_ms?: unknown
  soc_source?: unknown
  min_charge_w?: unknown
  max_charge_w?: unknown
  phases?: unknown
  voltage_v?: unknown
  commanded_w?: unknown
  commanded_reason?: unknown
  commanded_known?: unknown
  manual_save_error?: unknown
  manual_restore_unconfirmed?: unknown
  manual_active?: unknown
  manual_charge_w?: unknown
  surplus_only?: unknown
  battery_boost?: {
    state?: unknown
    active?: unknown
    expires_at_ms?: unknown
    min_battery_soc?: unknown
    stop_reason?: unknown
    stopped_at_ms?: unknown
  }
  schedule?: {
    soc?: unknown
    soc_pct?: unknown
    time_of_day_min_utc?: unknown
    surplus_unlock_bat_soc?: unknown
    recurring?: unknown
    days?: unknown
  } | null
}

export interface WireManualStatus {
  active?: unknown
  state?: unknown
  requested_a?: unknown
  requested_w?: unknown
  commanded_a?: unknown
  charger_reason?: unknown
  limit_reason?: unknown
  since_ms?: unknown
  charger_updated_at_ms?: unknown
}

export interface Loadpoint {
  id: string
  /** Whether a cable is in. False means the rest is about an empty bay. */
  pluggedIn: boolean
  /** Watts flowing into the car right now. */
  powerW: number
  /** The car's charge, or null for a charger that honestly does not know. */
  socPct: number | null
  /**
   * Where that level came from, in the box's own token: `vehicle` from the
   * car, `inferred` from energy delivered, `assumed` until confirmed.
   * Older boxes may still send `completed`; that is never a BMS reading.
   */
  socSource: string
  vehicleCapacityWh?: number | null
  capacitySource?: string
  socRetention?: string
  chargingDeclined?: boolean
  targetSocPct: number | null
  /** What this session has delivered, in watt-hours. */
  sessionWh: number
  /** The charger's floor and ceiling for a hold, in watts. Null when unreported. */
  minChargeW: number | null
  maxChargeW: number | null
  /** Phase count and phase voltage, for the amp slider. Null when the box did not say. */
  phases: number | null
  voltageV: number | null
  manualSaveError?: boolean
  manualRestoreUnconfirmed?: boolean
  manualActive: boolean
  manual?: WireManualStatus
  charger?: WireLoadpoint['charger']
  commandedW?: number | null
  commandedReason?: string
  commandedKnown?: boolean
  updatedAtMs?: number | null
  gridDeferred?: boolean
  planStartMs?: number | null
  planEndMs?: number | null
  /** What the running hold asks for, in watts. Null when there is none, or the box did not say. */
  manualChargeW: number | null
  surplusOnly: boolean
  boostActive: boolean
  /** When the running boost ends, wall clock. Null when none, or unreported. */
  boostExpiresAtMs: number | null
  /** The floor the running boost keeps in the house battery, whole percent. */
  boostReservePct: number | null
  /** The box's own token for why the last boost stopped. Null until it has. */
  boostStopReason: string | null
  schedule: {
    socPct: number | null
    timeOfDayMinUtc: number
    surplusUnlockPct?: number
    recurring: boolean
    /** 7-bit weekday mask, bit 0 = Monday. Zero means every day. */
    days: number
  } | null
}

const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null)

/**
 * A state of charge off the wire, in whole percent.
 *
 * The box stores fractions and its status reports carry them, but its
 * decoders also take a legacy percent, so a value above one is read the
 * same way the box would read it. Zero is "unset" on the wire and null here.
 */
const pct = (v: unknown): number | null => {
  const f = num(v)
  if (f === null || f <= 0) return null
  return Math.round(f > 1 ? f : f * 100)
}

/** One charger off the wire, unknown-tolerant the way every decoder here is. */
export function toLoadpoint(w: WireLoadpoint): Loadpoint {
  const sched = w.schedule
  const schedMin = sched ? num(sched.time_of_day_min_utc) : null
  const schedPct = pct(sched?.soc) ?? num(sched?.soc_pct)
  const socFraction = num(w.current_soc)
  const boost = w.battery_boost
  return {
    id: typeof w.id === 'string' ? w.id : '',
    pluggedIn: w.plugged_in === true,
    powerW: num(w.current_power_w) ?? 0,
    socPct: w.plugged_in === false ? null : socFraction !== null && socFraction >= 0 && socFraction <= 1
      ? Math.round(socFraction * 100) : num(w.current_soc_pct),
    socSource: typeof w.soc_source === 'string' ? w.soc_source : '',
    vehicleCapacityWh: num(w.vehicle_capacity_wh),
    capacitySource: typeof w.capacity_source === 'string' ? w.capacity_source : '',
    socRetention: typeof w.soc_retention === 'string' ? w.soc_retention : '',
    chargingDeclined: w.charging_declined === true,
    targetSocPct: pct(w.target_soc) ?? num(w.target_soc_pct),
    sessionWh: Math.max(0, Math.round(num(w.delivered_wh_session) ?? 0)),
    minChargeW: num(w.min_charge_w),
    maxChargeW: num(w.max_charge_w),
    phases: num(w.phases),
    voltageV: num(w.voltage_v),
    manualActive: w.manual_active === true,
    manualRestoreUnconfirmed: w.manual_restore_unconfirmed === true,
    manualSaveError: w.manual_save_error === true,
    ...(w.manual ? { manual: w.manual } : {}),
    ...(w.charger ? { charger: w.charger } : {}),
    commandedW: num(w.commanded_w),
    commandedReason: typeof w.commanded_reason === 'string' ? w.commanded_reason : '',
    commandedKnown: w.commanded_known === true,
    updatedAtMs: num(w.updated_at_ms),
    gridDeferred: w.grid_deferred === true,
    planStartMs: num(w.plan_next_start_ms),
    planEndMs: num(w.plan_next_end_ms),
    manualChargeW: w.manual_active === true ? num(w.manual_charge_w) : null,
    surplusOnly: w.surplus_only === true,
    boostActive: boost?.active === true,
    boostExpiresAtMs: boost?.active === true ? num(boost.expires_at_ms) : null,
    boostReservePct: boost?.active === true ? pct(boost.min_battery_soc) : null,
    boostStopReason:
      boost?.active !== true && typeof boost?.stop_reason === 'string' && boost.stop_reason !== ''
        ? boost.stop_reason
        : null,
    schedule:
      schedMin === null || schedPct === null || schedPct <= 0
        ? null
        : {
            socPct: schedPct,
            timeOfDayMinUtc: schedMin,
            recurring: sched!.recurring === true,
            surplusUnlockPct: typeof sched!.surplus_unlock_bat_soc === 'number' ? sched!.surplus_unlock_bat_soc * 100 : 0,
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

export const MANUAL_SAVE_ERROR_TEXT = 'This choice is active now, but could not be saved for restart. FTW is retrying.'

/**
 * The headline: what the charger is doing at this moment.
 *
 * Power leads when there is any, because "Charging at 7.2 kW" is the one
 * fact someone opens this panel for. The idle cases say what is true about
 * the bay, never what might happen later — the schedule line owns later.
 */
export function evStatusSentence(lp: Loadpoint, canControl = true): string {
  if (lp.manualRestoreUnconfirmed) return (canControl ? 'Confirm how to continue after restart.' : 'An owner needs to confirm charging after restart.') + ' FTW could not match the earlier charge request to this connection.'

  if (lp.charger && lp.charger.available !== true) return lp.charger.known ? 'Charger status is out of date. FTW cannot confirm whether the car is charging.' : 'Waiting for the charger’s first status report.'
  if (!lp.pluggedIn) return 'Not plugged in'
  if (lp.manualActive) return manualStatusSentence(lp)
  if (lp.powerW >= 100) {
    const p = formatPower(lp.powerW)
    return `Charging at ${p.text} ${p.unit}`
  }
  if (lp.chargingDeclined) return 'The car stopped asking for charge. Check its charge limit or schedule. This does not confirm the battery is full.'
  if (lp.commandedKnown && lp.commandedReason === 'site_meter_stale') return 'Paused for safety: house power readings are out of date. Charging resumes when readings return.'
  if (lp.commandedKnown && lp.commandedW === 0 && ['fuse_cooldown', 'fuse_limit'].includes(lp.commandedReason ?? '')) return 'Paused: main-fuse protection. Charging resumes on its own.'
  if (lp.commandedKnown && (lp.commandedW ?? 0) > 0) return `FTW requests ${formatPower(lp.commandedW!).text} ${formatPower(lp.commandedW!).unit}. Waiting for the car to draw power.` + (lp.charger?.reason ? ` Charger reports: ${String(lp.charger.reason)}.` : '')
  return 'Plugged in — not charging right now'
}

/** A zero hold is a pause; older boxes omit their zero setpoint. */
export function isPaused(lp: Loadpoint): boolean {
  return !lp.manualRestoreUnconfirmed && lp.manualActive && (lp.manualChargeW === 0 || lp.manual?.state === 'paused' || lp.manual?.state === 'pausing' || (lp.manualChargeW === null && (lp.manual?.requested_w === 0 || lp.manual?.requested_a === 0)))
}

/** The hold is intent; only a fresh charger reading proves charging. */
export function manualStatusSentence(lp: Loadpoint): string {
  const m = lp.manual
  const reqA = num(m?.requested_a)
  const cmdA = num(m?.commanded_a)
  const request = reqA !== null ? `${Math.round(reqA)} A` : 'your charge request'
  const limit = cmdA !== null ? `${Math.round(cmdA)} A` : 'the requested current'
  const reason = typeof m?.charger_reason === 'string' && m.charger_reason
    ? ` Charger reports: ${m.charger_reason}.` : ''
  if (m?.state === 'unavailable') return 'Charger status is out of date. FTW cannot confirm whether the car is charging.'
  switch (m?.state) {
    case 'pausing': return 'Pause requested. ' + (lp.powerW >= 100 ? `${formatPower(lp.powerW).text} ${formatPower(lp.powerW).unit} is still flowing. ` : '') + 'Waiting for the charger to stop.'
    case 'paused': return 'Paused by you. Charging stays off until you resume the plan, choose Charge now, or unplug.'
    case 'charging': {
      const p = formatPower(lp.powerW)
      return lp.powerW > 0 ? `Charging at ${p.text} ${p.unit}. ${request} requested.` : 'The charger reports charging. Waiting for a power reading.'
    }
    case 'sent': return `FTW received ${request}. Waiting for the charger to confirm the new limit.` + (lp.powerW >= 100 ? ` Still charging at ${formatPower(lp.powerW).text} ${formatPower(lp.powerW).unit}.` : '')
    case 'accepted': return `Charger reports a ${limit} limit. Waiting for the car to start drawing…${reason}`
    case 'not_drawing': return `Charger offers ${limit} but the car is not drawing.${reason || ' Check the car’s charge limit or schedule.'}`
    case 'stalled': return isPaused(lp) ? 'The charger has not stopped after your pause request. Check the charger’s app.' : `The charger has not acted on ${request}.` + (lp.powerW >= 100 ? ` Still charging at ${formatPower(lp.powerW).text} ${formatPower(lp.powerW).unit}.` : '') + (reason || ' Check the charger and the car’s charge limit or schedule.')
    case 'limited':
      if (m.limit_reason === 'charger_limit') return `The charger limits this request to ${limit} (${request} requested).`
      if (m.limit_reason === 'site_meter_stale') return 'Paused for safety: house power readings are out of date. Charging resumes when readings return.'
      if (m.limit_reason === 'fuse_cooldown') return 'Paused: main-fuse protection. Charging resumes on its own.'
      return `Main fuse limits this charge to ${limit} right now (${request} requested).`
    default:
      if (lp.powerW >= 100) {
        const p = formatPower(lp.powerW)
        return `Charging at ${p.text} ${p.unit}`
      }
      return 'Manual charge requested. Waiting for charger status.'
  }
}

export function evPlanSentence(lp: Loadpoint, now = Date.now(), canControl = true): string | null {
  if (!lp.pluggedIn || lp.manualActive || lp.manualRestoreUnconfirmed || lp.chargingDeclined || (lp.charger && lp.charger.available !== true)) return null
  if (lp.gridDeferred && lp.schedule) return 'Waiting for tomorrow’s electricity prices. Solar surplus can charge the car meanwhile.'
  if (lp.planStartMs && lp.planEndMs && lp.planEndMs > now) {
    const clock = (t: number) => new Date(t).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })
    return `Charging planned ${clock(lp.planStartMs)}–${clock(lp.planEndMs)}.`
  }
  if (lp.surplusOnly) return 'Solar only: charging waits for spare solar power.'
  if (!lp.schedule && lp.powerW < 100) return canControl ? 'No charging plan yet. Set a ready time, or choose Charge now.' : 'No charging plan yet. Ask an owner to set a ready time or start charging.'
  if (lp.schedule && lp.powerW < 100) return canControl ? 'No charge window yet for this goal. Choose Charge now if you need to charge immediately.' : 'No charge window yet for this goal. An owner can start charging now.'
  return null
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

// --------------------------------------------------------------------------
// The car's charge level
// --------------------------------------------------------------------------

/**
 * Where the slider rests when the box has no level for the car — the box
 * page's own default, so both surfaces start from the same place.
 */
export const SOC_DEFAULT_PCT = 50

/**
 * Where the level came from, as the box's own page says it.
 *
 * The token is the box's; every word is the app's. A source the app has not
 * heard of reads as the estimate, which is what the box falls back to.
 */
export function socSourceSentence(lp: Loadpoint): string {
  const retention = lp.socRetention === 'session'
    ? ' FTW keeps this level for the same charging session, including after a box restart.'
    : lp.socRetention === 'error'
      ? ' This level could not be saved for a box restart. Enter it again before relying on the plan after restarting.'
      : ' This level must be entered again after a box restart.'
  switch (lp.socSource) {
    case 'assumed':
      return `Battery level needs confirmation. The plan currently assumes ${lp.socPct ?? SOC_DEFAULT_PCT} %. Drag to match the car.` + retention
    case 'vehicle':
      return 'Reported by the car. Drag only to correct drift.'
    case 'completed':
      return 'The car stopped asking for charge. Its actual battery level is not confirmed. Drag to match the car.'
    default:
      return 'Estimated from energy delivered. Drag to the real value and the plan follows.' + retention
  }
}

// --------------------------------------------------------------------------
// Charge now, in amps
// --------------------------------------------------------------------------

/** The current a hold may ask for, and what one amp costs across the phases. */
export interface ChargeCurrent {
  minA: number
  maxA: number
  /** Watts per amp: phases × volts. */
  wattsPerAmp: number
  phases: number
}

/**
 * The slider's range, from what the box served.
 *
 * The box's own page does this sum — amps = W / (phases × volts) — and its
 * fallbacks are copied here so both surfaces offer the same range for the
 * same charger: three phases at 230 V when the box did not say, 6–16 A when
 * it reported no floor or ceiling. The box omits `phases` and `voltage_v`
 * when they are unset; `min_charge_w` and `max_charge_w` always arrive but
 * may be zero.
 */
export function chargeCurrent(lp: Loadpoint): ChargeCurrent {
  const phases = lp.phases !== null && lp.phases > 0 ? lp.phases : 3
  const volts = lp.voltageV !== null && lp.voltageV > 0 ? lp.voltageV : 230
  const wattsPerAmp = phases * volts
  const toA = (w: number | null) => (w !== null && w > 0 ? Math.round(w / wattsPerAmp) : 0)
  const minA = Math.max(1, toA(lp.minChargeW) || 6)
  let maxA = toA(lp.maxChargeW) || 16
  if (maxA <= minA) maxA = minA + 1
  return { minA, maxA, wattsPerAmp, phases }
}

/**
 * Watts for a chosen current, never above the ceiling the box declared.
 *
 * 11 000 W rounds to 16 A, and 16 A back is 11 040 W — more than the charger
 * said it can do. The ceiling wins, so the top of the slider asks for exactly
 * what the box reported, the same figure the plan is allowed to ask for.
 */
export function ampsToWatts(lp: Loadpoint, amps: number): number {
  const w = Math.round(amps * chargeCurrent(lp).wattsPerAmp)
  return lp.maxChargeW !== null && lp.maxChargeW > 0 ? Math.min(w, lp.maxChargeW) : w
}

/** A hold's watts as whole amps, for saying what runs now. */
export function wattsToAmps(lp: Loadpoint, watts: number): number {
  return Math.round(watts / chargeCurrent(lp).wattsPerAmp)
}

/** "16 A · 11.0 kW" — the slider's readout, one decimal like the box's page. */
export function currentReadout(lp: Loadpoint, amps: number): string {
  return `${amps} A · ${(ampsToWatts(lp, amps) / 1000).toFixed(1)} kW`
}

// --------------------------------------------------------------------------
// Battery boost
// --------------------------------------------------------------------------

/**
 * The house-battery floor offered before a person changes it.
 *
 * The protocol carries no default; this is the one the box's own page seeds
 * its field with, so a household sees the same number on both surfaces.
 */
export const BOOST_RESERVE_DEFAULT_PCT = 30

/** The box refuses a lease under this. From its own validator. */
export const BOOST_RESERVE_MIN_PCT = 5

/**
 * How long a boost may run, as the box's page offers it.
 *
 * The box caps a lease at four hours — `MaxBatteryBoostDuration` — and
 * refuses longer, so the list ends there rather than offering a choice the
 * box would turn down.
 */
export const BOOST_DURATIONS = [
  { s: 1800, label: '30 min' },
  { s: 3600, label: '1 h' },
  { s: 7200, label: '2 h' },
  { s: 14400, label: '4 h' },
] as const

export const BOOST_DURATION_DEFAULT_S = 3600

/**
 * The box's stop reasons, in this app's words.
 *
 * Tokens from the box's `BatteryBoostStopReason`. The box sends the token;
 * every word here is the app's.
 */
const BOOST_STOP: Record<string, string> = {
  cancelled: 'it was stopped by hand',
  expired: 'its time ran out',
  vehicle_unplugged: 'the car was unplugged',
  ev_target_reached: 'the car reached its target',
  departure_reached: 'the departure time came',
  operator_hold: 'a manual charge took over',
  surplus_only: 'the charger went back to spare solar only',
  site_safety_block: 'the site meter went quiet',
  loadpoint_driver_unavailable: 'your box lost touch with the charger',
  battery_unavailable: 'your box lost touch with the house battery',
  battery_reserve_reached: 'the house battery reached its reserve',
  battery_hold: 'the house battery was held for something else',
  core_mode: 'the site mode does not allow it',
  fuse_safety_block: 'the fuse limit stepped in',
  restart_lease_invalid: 'your box restarted and would not resume it',
}

/**
 * The running boost, as one sentence.
 *
 * Reserve and end time ride along when the box reported them. A box that
 * says only "active" gets the bare sentence, never an invented figure.
 */
export function boostActiveSentence(lp: Loadpoint): string {
  const reserve = lp.boostReservePct !== null ? ` down to ${lp.boostReservePct} %` : ''
  const until =
    lp.boostExpiresAtMs !== null
      ? ` until ${new Date(lp.boostExpiresAtMs).toLocaleTimeString(undefined, {
          hour: '2-digit',
          minute: '2-digit',
        })}`
      : ''
  return `Battery boost is on — the house battery is helping the car${reserve}${until}.`
}

/**
 * Why the last boost ended, while none runs. Null when the box has not said.
 *
 * A token this app has not heard of is still a stop the box reported, so
 * the sentence says the box stopped it rather than hiding the fact.
 */
export function boostStoppedSentence(lp: Loadpoint): string | null {
  if (lp.boostActive || lp.boostStopReason === null) return null
  const why = BOOST_STOP[lp.boostStopReason] ?? 'your box stopped it'
  return `The last boost ended because ${why}.`
}
