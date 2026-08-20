import { describe, it, expect } from 'vitest'
import { buildSavingsPeriods, formatCompactMinor, toSavingsDay } from './savings'

describe('buildSavingsPeriods', () => {
  it('splits today, seven days and the box month the way the dashboard does', () => {
    const days = [
      { day: '2026-07-01', savedOre: 100, resolution: 'slot' },
      { day: '2026-07-10', savedOre: 200, resolution: 'slot' },
      { day: '2026-07-14', savedOre: 50, resolution: 'no_prices' },
      { day: '2026-07-15', savedOre: 300, resolution: 'slot' },
    ]
    const p = buildSavingsPeriods(days)
    expect(p.today.savedMinor).toBe(300)
    expect(p.today.available).toBe(true)
    expect(p.week.savedMinor).toBe(600)
    expect(p.week.complete).toBe(false)
    expect(p.month.savedMinor).toBe(600)
  })

  it('ignores a row the box did not date', () => {
    expect(toSavingsDay({ saved_ore: 10 })).toBeNull()
    expect(toSavingsDay({ day: '2026-07-15', saved_ore: 12.4 })?.savedOre).toBe(12.4)
  })
})

describe('formatCompactMinor', () => {
  it('matches the dashboard compact rounding', () => {
    expect(formatCompactMinor(24700)).toBe('+247')
    expect(formatCompactMinor(1234)).toBe('+12.3')
    expect(formatCompactMinor(-80)).toBe('−0.80')
  })
})
