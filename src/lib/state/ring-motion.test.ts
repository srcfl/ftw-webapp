import { describe, expect, it } from 'vitest'
import { ArcMotion, Follow, WAVELENGTH, ringEase, ringLines, ringStrength, ringSwell, waveSpeed, type ArcTarget } from './ring-motion'

const target = (p: Partial<ArcTarget> = {}): ArcTarget => ({
  kw: 2, live: true, flowing: true, towardHome: true, fill: 0.5, ...p,
})

/** Steps an arc at 60 frames a second from `from` to `to` seconds. */
function run(m: ArcMotion, t: ArcTarget, from: number, to: number, reduce = false) {
  let f = m.step(t, from, reduce)
  for (let s = from; s <= to; s += 1 / 60) f = m.step(t, s, reduce)
  return f
}

describe('the light on an arc', () => {
  it('never glows on an arc that has never been live', () => {
    const t = target({ live: false })
    const f = run(new ArcMotion(t, 0), t, 0, 3)
    expect(f.light).toBe(0)
    expect(f.phase).toBe(0)
  })

  it('opens live data at full light without a flash', () => {
    const f = new ArcMotion(target(), 0).step(target(), 0, false)
    expect(f.light).toBe(1)
  })

  it('cools to ink within a second and a half once the box stops confirming it', () => {
    const m = new ArcMotion(target(), 0)
    run(m, target(), 0, 1)
    const quiet = target({ live: false })
    expect(run(m, quiet, 1, 1.2).light).toBeGreaterThan(0.4)
    expect(run(m, quiet, 1.2, 2.6).light).toBeLessThan(0.05)
  })

  it('does not cool on screen after going quiet while nothing was drawn', () => {
    const m = new ArcMotion(target(), 0)
    m.step(target(), 0, false)
    expect(m.step(target({ live: false }), 5, false).light).toBe(0)
  })

  it('runs the lines only while live, and not at all under reduced motion', () => {
    const live = run(new ArcMotion(target(), 0), target(), 0, 1)
    expect(live.phase).toBeGreaterThan(0.5)
    const still = run(new ArcMotion(target(), 0), target(), 0, 1, true)
    expect(still.phase).toBe(0)
  })

  it('grows the arc to a new reading without overshoot', () => {
    const m = new ArcMotion(target({ fill: 0.2 }), 0)
    let most = 0
    for (let s = 0; s < 3; s += 1 / 60) most = Math.max(most, m.step(target({ fill: 0.8 }), s, false).fill)
    expect(most).toBeLessThanOrEqual(0.8 + 1e-9)
    expect(most).toBeGreaterThan(0.79)
  })

  it('snaps to a new reading under reduced motion', () => {
    const m = new ArcMotion(target({ fill: 0.2 }), 0)
    expect(m.step(target({ fill: 0.8 }), 0.1, true).fill).toBe(0.8)
  })
})

describe('a swell per reading', () => {
  it('starts with a new reading from the box and ends before the next', () => {
    const m = new ArcMotion(target(), 0, 0)
    expect(m.step(target(), 0.5, false, 0).swell).toBeNull()
    expect(m.step(target(), 1, false, 1000).swell).toBe(0)
    expect(m.step(target(), 1.4, false, 1000).swell).toBeGreaterThan(0.3)
    expect(m.step(target(), 2, false, 1000).swell).toBeNull()
  })

  it('never swells on the first reading, a quiet arc, a frame drawn at rest or under reduced motion', () => {
    expect(new ArcMotion(target(), 0).step(target(), 0.1, false, 1000).swell).toBeNull()
    expect(new ArcMotion(target({ live: false }), 0, 0).step(target({ live: false }), 0.1, false, 1000).swell).toBeNull()
    expect(new ArcMotion(target({ flowing: false }), 0, 0).step(target({ flowing: false }), 0.1, false, 1000).swell).toBeNull()
    expect(new ArcMotion(target(), 0, 0).step(target(), 0.1, false, 1000, false).swell).toBeNull()
    expect(new ArcMotion(target(), 0, 0).step(target(), 0.1, true, 1000).swell).toBeNull()
  })

  it('runs from the middle out past both ends and fades', () => {
    const half = 60
    expect(ringSwell(0, 0, half)).toBeCloseTo(1, 12)
    const peak = (k: number) => {
      let best = 0
      for (let s = 0; s <= 140; s += 0.5) if (ringSwell(s, k, half) > ringSwell(best, k, half)) best = s
      return best
    }
    expect(peak(0.2)).toBeLessThan(peak(0.5))
    expect(peak(0.9)).toBeGreaterThan(half)
    expect(ringSwell(peak(0.8), 0.8, half)).toBeLessThan(ringSwell(peak(0.3), 0.3, half))
    expect(ringSwell(10, 0.4, half)).toBe(ringSwell(-10, 0.4, half))
    expect(ringSwell(0, 1.01, half)).toBe(0)
  })
})

describe('the lines and the arc', () => {
  it('sit a wavelength apart and run toward the home for power coming in', () => {
    const length = 36.75
    for (const toward of [true, false]) {
      for (let phase = 0; phase < 3; phase += 0.07) {
        const ps = ringLines(phase, length, toward)
        expect(ps.every((p) => p >= 0 && p <= 1)).toBe(true)
        expect([2, 3]).toContain(ps.length)
      }
      const a = ringLines(0.2, length, toward)[0] ?? 0
      const b = ringLines(0.3, length, toward)[0] ?? 0
      expect((b - a) * length).toBeCloseTo((toward ? 1 : -1) * 0.1 * WAVELENGTH, 9)
    }
    expect(ringLines(0.4, 0, true)).toEqual([])
    expect(ringLines(Number.NaN, length, true)).toEqual([])
  })

  it('is brightest over its middle third, with no hot ends', () => {
    expect(ringEase(0, 0.14)).toBe(1)
    expect(ringEase(0.3, 0.14)).toBe(1)
    expect(ringEase(1, 0.14)).toBeCloseTo(0.14, 12)
    expect(ringEase(-1, 0)).toBeCloseTo(0, 12)
  })

  it('grows in strength with power and stops at full', () => {
    expect(ringStrength(0)).toBe(0.65)
    expect(ringStrength(5)).toBe(1)
    expect(ringStrength(-1)).toBe(ringStrength(1))
  })

  it('runs faster with power, never racing', () => {
    expect(waveSpeed(0.1)).toBeCloseTo(19.2, 0)
    expect(waveSpeed(1)).toBeCloseTo(31.4, 0)
    expect(waveSpeed(10)).toBeCloseTo(51.6, 0)
  })

  it('follows a step as one long frame lands where many short ones do', () => {
    const a = new Follow(0)
    const b = new Follow(0)
    a.step(1, 1, 0.4)
    for (let i = 0; i < 100; i++) b.step(1, 0.01, 0.4)
    expect(a.value).toBeCloseTo(b.value, 6)
  })
})
