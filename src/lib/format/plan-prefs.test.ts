import { describe, expect, it } from 'vitest'
import {
  PLANNER_FALLBACK_MODE,
  PLAN_STYLES,
  SAFETY_K_DEFAULT,
  styleForK,
  exportSentence,
  mappedPlannerMode,
  prefsFromWire,
  type SaleSlot,
} from './plan-prefs'

const slot = (startMs: number, batteryW: number, gridW: number): SaleSlot => ({
  startMs,
  durationMs: 15 * 60_000,
  batteryW,
  gridW,
})

describe('planner prefs from the box', () => {
  it('keeps the slider on safety_k and does not invent a mode from export', () => {
    const prefs = prefsFromWire({
      safety_k: 0.4,
      forecast_trust: 'cautious',
      battery_export: 'allowed',
      mapped_mode: 'planner_arbitrage',
    })
    expect(prefs.safetyK).toBe(0.4)
    expect(prefs.forecastTrust).toBe('balanced')
    expect(prefs.batteryExport).toBe('allowed')
    expect(prefs.mappedMode).toBe('planner_arbitrage')
  })

  it('uses the passive mode when mapped_mode is missing or not a planner key', () => {
    expect(mappedPlannerMode({})).toBe(PLANNER_FALLBACK_MODE)
    expect(mappedPlannerMode({ mapped_mode: 'self_consumption' })).toBe(PLANNER_FALLBACK_MODE)
    expect(mappedPlannerMode({ mapped_mode: 'planner_arbitrage' })).toBe('planner_arbitrage')
    expect(prefsFromWire({ battery_export: 'allowed' }).mappedMode).toBe(PLANNER_FALLBACK_MODE)
  })

  it('names a battery sale, a solar export, an allowed idle, and a block', () => {
    const start = Date.parse('2026-07-15T18:00:00')
    const hh = (ms: number) => {
      const d = new Date(ms)
      return String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0')
    }
    expect(exportSentence([slot(start, -400, -400)], 'allowed', start)).toBe(
      `Battery sale planned ${hh(start)}–${hh(start + 15 * 60_000)}.`
    )
    expect(exportSentence([slot(start, 0, -400)], 'not_allowed', start)).toBe(
      'Solar export only; the battery is not selling.'
    )
    expect(exportSentence([slot(start, 200, 200)], 'allowed', start)).toBe(
      'Battery export is allowed, but FTW found no worthwhile sale.'
    )
    expect(exportSentence([slot(start, 200, 200)], 'unknown', start)).toBe(
      'Battery sale blocked: permission is off or not checked.'
    )
  })
})


describe('planning styles', () => {
  it('matches the box default and preserves a fine-tuned margin', () => {
    expect(SAFETY_K_DEFAULT).toBe(0.3)
    expect(prefsFromWire({ forecast_trust: 'balanced' }).safetyK).toBe(0.3)
    expect(prefsFromWire({ safety_k: 0.85 }).safetyK).toBe(0.85)
    expect(styleForK(0.85)).toEqual({ style: PLAN_STYLES[0], exact: false })
    expect(styleForK(0.3)).toEqual({ style: PLAN_STYLES[2], exact: true })
  })
})
