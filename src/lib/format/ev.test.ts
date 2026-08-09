/* The charger's words, held to the app's rules: no invented percentages, no
 * raw wire values, the kitchen clock and never UTC. */

import { describe, it, expect } from 'vitest'
import {
  toLoadpoint,
  evStatusSentence,
  evScheduleSentence,
  evSessionSentence,
  localClock,
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
    const s = evStatusSentence(toLoadpoint({ ...WIRE, current_power_w: 0 }))
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

  it('claims no target percentage when the charger cannot measure charge', () => {
    // soc_source none: the box knows the goal but not the distance to it.
    // "84 % ready by 07:00" reads as a measurement, so the percent stays off.
    const s = evScheduleSentence(toLoadpoint(WIRE))
    expect(s).not.toContain('%')
  })

  it('shows the percent when the charge is really known', () => {
    const s = evScheduleSentence(toLoadpoint({ ...WIRE, current_soc_pct: 25.0057 }))
    expect(s).toContain('84 %')
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

  it('holds every sentence to the no-minus rule', () => {
    // A driver mid-fault can report a small negative power; the wire sign
    // convention must not reach the panel.
    const lp = toLoadpoint({ ...WIRE, current_power_w: -12 })
    expect(evStatusSentence(lp)).not.toContain('-')
  })
})
