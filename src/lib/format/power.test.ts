import { describe, it, expect } from 'vitest'
import { formatPower, formatScaleWatts, formatSoc, formatAge, directionOf, NOISE_W } from './power'
import { explain, FID } from './explanation'

describe('formatPower', () => {
  it('never returns a negative magnitude', () => {
    for (const w of [-1, -999, -4200, -1_500_000, -0.5]) {
      expect(formatPower(w).value).toBeGreaterThanOrEqual(0)
      expect(formatPower(w).text.startsWith('-')).toBe(false)
    }
  })

  it('carries direction instead of sign', () => {
    expect(formatPower(4200).direction).toBe('in')
    expect(formatPower(-4200).direction).toBe('out')
    expect(formatPower(0).direction).toBe('idle')
  })

  it('treats sensor noise as idle rather than a real flow', () => {
    expect(directionOf(NOISE_W - 1)).toBe('idle')
    expect(directionOf(-(NOISE_W - 1))).toBe('idle')
    expect(directionOf(NOISE_W)).toBe('in')
    expect(directionOf(-NOISE_W)).toBe('out')
  })

  it('scales units at the thousand boundary', () => {
    expect(formatPower(999)).toMatchObject({ unit: 'W', text: '999' })
    expect(formatPower(1000)).toMatchObject({ unit: 'kW', text: '1.0' })
    expect(formatPower(1_000_000)).toMatchObject({ unit: 'MW' })
  })

  it('keeps the digit count stable across a household range', () => {
    // A live stream must not resize its own container as values move.
    const widths = new Set<number>()
    for (let w = 1000; w < 10_000; w += 137) widths.add(formatPower(w).text.length)
    expect(widths.size).toBe(1)
  })

  it('drops the decimal above 10 kW where it is noise', () => {
    expect(formatPower(9900).text).toBe('9.9')
    expect(formatPower(11_400).text).toBe('11')
  })

  it('survives non-finite input rather than rendering NaN', () => {
    for (const bad of [NaN, Infinity, -Infinity]) {
      const p = formatPower(bad)
      expect(p.text).not.toContain('NaN')
      expect(p.direction).toBe('idle')
    }
  })
})

describe('the numbers beside a chart', () => {
  it('drops a decimal that is always a zero', () => {
    // A scale's rungs are round by construction, so formatPower's fixed
    // decimal puts "5.0 kW" under "10 kW" and the pair looks like a mistake.
    expect(formatScaleWatts(5000)).toBe('5 kW')
    expect(formatScaleWatts(10_000)).toBe('10 kW')
    expect(formatScaleWatts(500)).toBe('500 W')
  })

  it('keeps a decimal that carries something', () => {
    expect(formatScaleWatts(1500)).toBe('1.5 kW')
  })

  it('never writes the minus sign the wire uses', () => {
    // The direction is a word on the axis. On a rung it would be a sign the
    // rest of the app has spent every other screen not showing.
    for (const w of [-500, -5000, -1_500_000]) {
      expect(formatScaleWatts(w).startsWith('-')).toBe(false)
    }
    expect(formatScaleWatts(-5000)).toBe(formatScaleWatts(5000))
  })

  it('survives non-finite input rather than rendering NaN', () => {
    for (const bad of [NaN, Infinity, -Infinity]) expect(formatScaleWatts(bad)).toBe('')
  })
})

describe('the headline and the cards agree', () => {
  // Caught in the browser: the headline read "solar is covering everything
  // the house is using" while the grid card underneath read "23 W drawing".
  // Two noise thresholds, two truths, one contradiction on screen.
  it('never calls the grid active while the headline says solar covers it all', () => {
    for (let gridW = 0; gridW < NOISE_W; gridW += 7) {
      const fields = new Map([
        [FID.GRID_W, gridW],
        [FID.PV_W, -4000],
        [FID.BATTERY_W, 0],
        [FID.LOAD_W, 4000 + gridW],
      ])

      const headline = explain({ fields, dispatchBlockedBy: [], ceilingW: 11_000 })
      if (headline.situation === 'solar_covering') {
        expect(directionOf(gridW)).toBe('idle')
      }
    }
  })

  it('shares one threshold between the two layers', () => {
    // If these ever diverge again the test above stops being able to see it.
    expect(directionOf(NOISE_W - 1)).toBe('idle')
    const fields = new Map([
      [FID.GRID_W, NOISE_W - 1],
      [FID.PV_W, -4000],
      [FID.BATTERY_W, 0],
      [FID.LOAD_W, 4000],
    ])
    expect(explain({ fields, dispatchBlockedBy: [], ceilingW: null }).situation).toBe('solar_covering')
  })
})

describe('formatSoc', () => {
  it('converts permille to whole percent', () => {
    expect(formatSoc(875)).toBe('88')
    expect(formatSoc(0)).toBe('0')
    expect(formatSoc(1000)).toBe('100')
  })

  it('shows an em dash rather than NaN when absent', () => {
    expect(formatSoc(NaN)).toBe('—')
  })
})

describe('formatAge', () => {
  it('reads as words at every scale', () => {
    expect(formatAge(0)).toBe('just now')
    expect(formatAge(30_000)).toBe('30s ago')
    expect(formatAge(90_000)).toBe('1 min ago')
    expect(formatAge(3_600_000)).toBe('1 h ago')
    expect(formatAge(86_400_000 * 3)).toBe('3 d ago')
  })

  it('refuses to invent a value it does not have', () => {
    expect(formatAge(NaN)).toBe('unknown')
    expect(formatAge(-1)).toBe('unknown')
  })
})
