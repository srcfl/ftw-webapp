import { describe, expect, it } from 'vitest'
import { ArcMotion, Follow, wave, waveSpeed, type ArcTarget } from './ring-motion'

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

  it('runs the wave only while live, and not at all under reduced motion', () => {
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

describe('the wave', () => {
  it('crests at 1 and dips to 0.45', () => {
    expect(wave(0, 0)).toBeCloseTo(1)
    expect(wave(15, 0)).toBeCloseTo(0.45)
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
