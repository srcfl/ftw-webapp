/* The charger's words, held to the app's rules: no invented percentages, no
 * raw wire values, the kitchen clock and never UTC. */

import { describe, it, expect } from 'vitest'
import {
  toLoadpoint,
  evStatusSentence,
  evPlanSentence,
  evScheduleSentence,
  evSessionSentence,
  localClock,
  daysWord,
  localInputToUtcMinutes,
  utcMinutesToLocalInput,
  chargeCurrent,
  ampsToWatts,
  wattsToAmps,
  currentReadout,
  boostActiveSentence,
  boostStoppedSentence,
  socSourceSentence,
  type WireLoadpoint,
} from './ev'

const WIRE: WireLoadpoint = {
  id: 'carport',
  driver_name: 'easee',
  plugged_in: true,
  current_power_w: 8591.6,
  delivered_wh_session: 3003.4,
  target_soc_pct: 84,
  soc_source: 'none',
  manual_active: false,
  surplus_only: false,
  battery_boost: { state: 'inactive', active: false },
  schedule: { soc_pct: 84, time_of_day_min_utc: 360, recurring: true },
}

describe('a charger described in words', () => {
  it('leads with the power while charging', () => {
    const s = evStatusSentence(toLoadpoint(WIRE))
    expect(s).toMatch(/^Charging at 8\.6 kW$/)
  })

  it('says what is true about an empty bay', () => {
    expect(evStatusSentence(toLoadpoint({ ...WIRE, plugged_in: false }))).toBe('Not plugged in')
  })

  it('does not call a plugged, resting charger anything but resting', () => {
    const s = evStatusSentence(toLoadpoint({ ...WIRE, current_power_w: 4.39 }))
    expect(s).toMatch(/not charging/i)
    expect(s).not.toMatch(/\d/)
  })

  it('prints the schedule on the kitchen clock, not in UTC', () => {
    // 06:00 UTC. Whatever zone runs the test, the sentence must agree with
    // localClock — one conversion, one place.
    const lp = toLoadpoint(WIRE)
    const s = evScheduleSentence(lp)
    expect(s).toContain(`Ready by ${localClock(360)}`)
    expect(s).toContain('every day')
  })

  it('shows the saved target even when the current battery level is unknown', () => {
    const s = evScheduleSentence(toLoadpoint(WIRE))
    expect(s).toContain('84 %')
  })

  it('keeps the saved goal percentage visible while the car is unplugged', () => {
    const s = evScheduleSentence(toLoadpoint({ ...WIRE, plugged_in: false }))
    expect(s).toContain('84 %')
    expect(s).toContain(`Ready by ${localClock(360)}`)
  })

  it('reports a saved goal while replanning without changing the actual charge status', () => {
    const lp = toLoadpoint({ ...WIRE, plan_pending: true, plan_next_start_ms: Date.now(), plan_next_end_ms: Date.now() + 60_000 })
    expect(evPlanSentence(lp)).toBe('Goal saved. Updating the plan…')
    expect(evStatusSentence(lp)).toBe('Charging at 8.6 kW')
    expect(evPlanSentence({ ...lp, manualActive: true })).toBe('Goal saved. Updating the plan…')
    expect(evPlanSentence({ ...lp, planPending: false, planOutdated: true })).toBe('Charging times are unavailable. Your settings are saved.')
  })

  it('shows the percent when the charge is really known', () => {
    // The box serves a fraction; an older one served a percent. Either is a
    // level the box knows, and the sentence says so for both.
    expect(evScheduleSentence(toLoadpoint({ ...WIRE, current_soc: 0.250057 }))).toContain('84 %')
    expect(evScheduleSentence(toLoadpoint({ ...WIRE, current_soc_pct: 25.0057 }))).toContain('84 %')
  })

  it('says nothing at all about a schedule it has not read', () => {
    expect(evScheduleSentence(toLoadpoint({ ...WIRE, schedule: null }))).toBeNull()
  })

  it('rounds the session the way a person says it', () => {
    expect(evSessionSentence(toLoadpoint(WIRE))).toBe('3.0 kWh this session')
    expect(
      evSessionSentence(toLoadpoint({ ...WIRE, delivered_wh_session: 18_400 }))
    ).toBe('18 kWh this session')
  })

  it('says the week the way a person does', () => {
    expect(daysWord(0)).toBe('every day')
    expect(daysWord(0b1111111)).toBe('every day')
    expect(daysWord(0b0011111)).toBe('weekdays')
    expect(daysWord(0b1100000)).toBe('weekends')
    expect(daysWord(0b0010101)).toBe('Mon, Wed, Fri')
  })

  it('carries the mask into the schedule sentence', () => {
    const lp = toLoadpoint({
      ...WIRE,
      schedule: { soc_pct: 84, time_of_day_min_utc: 360, recurring: true, days: 31 },
    })
    expect(evScheduleSentence(lp)).toContain('weekdays')
  })

  it('round-trips the kitchen clock to the wire and back', () => {
    // Whatever zone runs this test, the pair of conversions must agree
    // with each other — one conversion, one place, both directions.
    for (const hhmm of ['00:00', '06:30', '23:45']) {
      const min = localInputToUtcMinutes(hhmm)
      expect(min).not.toBeNull()
      expect(min).toBeGreaterThanOrEqual(0)
      expect(min).toBeLessThan(1440)
      expect(utcMinutesToLocalInput(min!)).toBe(hhmm)
    }
    expect(localInputToUtcMinutes('25:99')).toBeNull()
  })

  it('holds every sentence to the no-minus rule', () => {
    // A driver mid-fault can report a small negative power; the wire sign
    // convention must not reach the panel.
    const lp = toLoadpoint({ ...WIRE, current_power_w: -12 })
    expect(evStatusSentence(lp)).not.toContain('-')
  })
})

describe("the car's level, in words", () => {
  it('reads the fraction off the wire in whole percent, and where it came from', () => {
    const lp = toLoadpoint({ ...WIRE, current_soc: 0.6049, soc_source: 'inferred' })
    expect(lp.socPct).toBe(60)
    expect(lp.socSource).toBe('inferred')
  })

  it('reads a level an older box wrote as a percent', () => {
    expect(toLoadpoint({ ...WIRE, current_soc_pct: 60 }).socPct).toBe(60)
  })

  it('knows no level for an empty bay', () => {
    // The box's zero values: a zero fraction and no source at all.
    const lp = toLoadpoint({ ...WIRE, plugged_in: false, current_soc: 0, soc_source: undefined })
    expect(lp.socPct).toBeNull()
    expect(lp.socSource).toBe('')
  })

  it("says where the level came from, in the box page's words", () => {
    const from = (soc_source: string) => socSourceSentence(toLoadpoint({ ...WIRE, soc_source }))
    expect(from('vehicle')).toBe('Reported by the car. Drag only to correct drift.')
    expect(from('completed')).toMatch(/actual battery level is not confirmed/)
    expect(from('assumed')).toMatch(/Battery level needs confirmation.*entered again after a box restart/);
    expect(from('inferred')).toMatch(/^Estimated from energy delivered/)
    // A source this app has not heard of reads as the estimate, which is
    // the box's own fallback.
    expect(from('something_new')).toMatch(/^Estimated from energy delivered/)
  })
})

describe('the current a hold may ask for', () => {
  /** What a real box serves beside the fixture: a three-phase 16 A wallbox. */
  const RANGE: WireLoadpoint = {
    ...WIRE,
    min_charge_w: 4140,
    max_charge_w: 11000,
    phases: 3,
    voltage_v: 230,
  }

  it('reads the range off the box in whole amps', () => {
    const lp = toLoadpoint(RANGE)
    expect(chargeCurrent(lp)).toEqual({ minA: 6, maxA: 16, wattsPerAmp: 690, phases: 3 })
    expect(ampsToWatts(lp, 10)).toBe(6900)
    expect(currentReadout(lp, 10)).toBe('10 A · 6.9 kW')
  })

  it('never asks above the ceiling the box declared', () => {
    // 11 000 W rounds to 16 A, and 16 A back is 11 040 W.
    const lp = toLoadpoint(RANGE)
    expect(ampsToWatts(lp, 16)).toBe(11000)
    expect(currentReadout(lp, 16)).toBe('16 A · 11.0 kW')
  })

  it('falls back the way the box page does when the box says nothing', () => {
    // No phases, no voltage, a zero floor and ceiling: three phases at
    // 230 V, 6–16 A, and nothing to cap the top against.
    const lp = toLoadpoint({ ...WIRE, min_charge_w: 0, max_charge_w: 0 })
    expect(chargeCurrent(lp)).toEqual({ minA: 6, maxA: 16, wattsPerAmp: 690, phases: 3 })
    expect(ampsToWatts(lp, 16)).toBe(11040)
  })

  it('follows a single-phase charger', () => {
    const lp = toLoadpoint({
      ...WIRE,
      min_charge_w: 1380,
      max_charge_w: 3680,
      phases: 1,
      voltage_v: 230,
    })
    expect(chargeCurrent(lp)).toEqual({ minA: 6, maxA: 16, wattsPerAmp: 230, phases: 1 })
    expect(ampsToWatts(lp, 16)).toBe(3680)
  })

  it('keeps the floor under the ceiling when the box reports them together', () => {
    const lp = toLoadpoint({ ...RANGE, min_charge_w: 11000 })
    expect(chargeCurrent(lp)).toMatchObject({ minA: 16, maxA: 17 })
  })

  it('reads the running hold back in amps', () => {
    const lp = toLoadpoint({ ...RANGE, manual_active: true, manual_charge_w: 6900 })
    expect(lp.manualChargeW).toBe(6900)
    expect(wattsToAmps(lp, lp.manualChargeW!)).toBe(10)
    // A setpoint beside an inactive hold is not a running hold.
    expect(
      toLoadpoint({ ...RANGE, manual_active: false, manual_charge_w: 6900 }).manualChargeW
    ).toBeNull()
  })
})

describe('the boost, in words', () => {
  const EXPIRES = Date.UTC(2026, 6, 15, 20, 30)

  it('reads the lease off the wire and says it', () => {
    const lp = toLoadpoint({
      ...WIRE,
      battery_boost: {
        state: 'active',
        active: true,
        expires_at_ms: EXPIRES,
        min_battery_soc: 0.3,
      },
    })
    expect(lp.boostActive).toBe(true)
    expect(lp.boostReservePct).toBe(30)
    expect(lp.boostExpiresAtMs).toBe(EXPIRES)
    const s = boostActiveSentence(lp)
    expect(s).toContain('down to 30 %')
    expect(s).toContain(
      `until ${new Date(EXPIRES).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })}`
    )
    expect(boostStoppedSentence(lp)).toBeNull()
  })

  it('claims no figure the box did not send', () => {
    const lp = toLoadpoint({ ...WIRE, battery_boost: { state: 'active', active: true } })
    expect(boostActiveSentence(lp)).toBe(
      'Battery boost is on — the house battery is helping the car.'
    )
  })

  it('reads a reserve the box wrote as a legacy percent', () => {
    const lp = toLoadpoint({
      ...WIRE,
      battery_boost: { state: 'active', active: true, min_battery_soc: 30 },
    })
    expect(lp.boostReservePct).toBe(30)
  })

  it("says why the box stopped the last one, in the app's words", () => {
    const lp = toLoadpoint({
      ...WIRE,
      battery_boost: {
        state: 'stopped',
        active: false,
        stop_reason: 'battery_reserve_reached',
        stopped_at_ms: EXPIRES,
      },
    })
    expect(lp.boostActive).toBe(false)
    expect(boostStoppedSentence(lp)).toBe(
      'The last boost ended because the house battery reached its reserve.'
    )
  })

  it('still reports a stop it has no words for', () => {
    const lp = toLoadpoint({
      ...WIRE,
      battery_boost: { state: 'stopped', active: false, stop_reason: 'new_reason' },
    })
    expect(boostStoppedSentence(lp)).toBe('The last boost ended because your box stopped it.')
  })

  it('says nothing about a boost that never ran', () => {
    expect(boostStoppedSentence(toLoadpoint(WIRE))).toBeNull()
  })
})

describe('current core fields and charger feedback', () => {
  it('reads the fraction schema, including a plugged car at zero percent', () => {
    const lp = toLoadpoint({ ...WIRE, current_soc: 0, target_soc: 0.8, target_soc_pct: undefined, schedule: { soc: 0.8, time_of_day_min_utc: 360 } })
    expect(lp.socPct).toBe(0)
    expect(lp.targetSocPct).toBe(80)
    expect(lp.schedule?.socPct).toBe(80)
    expect(toLoadpoint({ ...WIRE, schedule: { soc: 0, time_of_day_min_utc: 0 } }).schedule).toBeNull()
  })
  it('does not call a core acknowledgement charging at zero power', () => {
    const lp = toLoadpoint({ ...WIRE, current_power_w: 0, manual_active: true, manual: { active: true, state: 'accepted', requested_a: 16, commanded_a: 16 } })
    expect(evStatusSentence(lp)).toMatch(/Charger reports a 16 A limit/)
    expect(evStatusSentence(lp)).not.toMatch(/Charging at/)
  })
  it('marks old positive power as unknown in both manual and planned charging', () => {
    for (const manual_active of [true, false]) {
      const lp = toLoadpoint({ ...WIRE, manual_active, charger: { known: true, available: false } })
      expect(evStatusSentence(lp)).toMatch(/out of date/)
      expect(evStatusSentence(lp)).not.toMatch(/Charging at/)
    }
  })
})


describe('a retained level and a car that declines charge', () => {
  it('does not call a declined charge full or a reached target', () => {
    const lp = toLoadpoint({ id: 'car', plugged_in: true, charging_declined: true, current_soc: 0.37 })
    expect(evStatusSentence(lp)).toContain('does not confirm the battery is full')
    expect(lp.socPct).toBe(37)
  })
  it('uses the reported retention, including a failed disk save', () => {
    const lp = toLoadpoint({ plugged_in: true, current_soc: 0.12, soc_source: 'inferred', soc_retention: 'session' })
    expect(socSourceSentence(lp)).toContain('same charging session')
    expect(socSourceSentence({ ...lp, socRetention: 'error' })).toContain('could not be saved')
    expect(socSourceSentence({ ...lp, socRetention: 'unavailable' })).toContain('entered again after a box restart')
  })
})


it('a charger limit is not described as a main-fuse limit', () => {
  const lp = toLoadpoint({ plugged_in: true, manual_active: true, manual: { state: 'limited', requested_a: 16, commanded_a: 10, limit_reason: 'charger_limit' } })
  expect(evStatusSentence(lp)).toContain('The charger limits this request to 10 A (16 A requested)')
  expect(evStatusSentence(lp)).not.toContain('Main fuse')
})


it('asks for a new choice after an unmatched restart instead of claiming a user pause', () => {
  const lp = toLoadpoint({ plugged_in: true, manual_active: false, manual_restore_unconfirmed: true })
  expect(evStatusSentence(lp)).toContain('Confirm how to continue after restart')
  expect(evStatusSentence(lp)).not.toContain('Paused by you')
  expect(evStatusSentence(lp, false)).toContain('An owner needs to confirm')
})
it('keeps the old power visible until a lower current request is confirmed', () => {
  const lp = toLoadpoint({ plugged_in: true, current_power_w: 11000, manual_active: true, manual: { state: 'sent', requested_a: 6 } })
  expect(evStatusSentence(lp)).toContain('Waiting for the charger to confirm the new limit')
  expect(evStatusSentence(lp)).toContain('Still charging at 11 kW')
  expect(evStatusSentence({ ...lp, manual: { state: 'stalled', requested_a: 6 } })).toContain('Still charging at 11 kW')
})
