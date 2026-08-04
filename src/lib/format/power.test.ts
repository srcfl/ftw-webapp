import { describe, it, expect } from 'vitest'
import { formatPower, formatSoc, formatAge, directionOf } from './power'

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
    expect(directionOf(3)).toBe('idle')
    expect(directionOf(-3)).toBe('idle')
    expect(directionOf(6)).toBe('in')
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
