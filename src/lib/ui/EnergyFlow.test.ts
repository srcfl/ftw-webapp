import { describe, it, expect } from 'vitest'
import { render } from '@testing-library/svelte'
import EnergyFlow from './EnergyFlow.svelte'

// The flow view draws claims about a real house, so what it asserts is the
// arithmetic and the honesty: the self-powered share, the verbs, and that a
// missing reading is a dash rather than an invented zero.

const base = {
  gridW: 500,
  pvW: -2300,
  batteryW: 1800,
  loadW: 2000,
  socPercent: 62,
  live: true,
}

describe('EnergyFlow', () => {
  it('shows every reading with its verb', () => {
    const { container } = render(EnergyFlow, { props: base })
    const text = container.textContent!
    expect(text).toContain('SOLAR')
    expect(text).toContain('generating')
    expect(text).toContain('62% · charging')
    expect(text).toContain('drawing')
  })

  it('computes the self-powered share from grid import over load', () => {
    // 500 W of a 2000 W load comes through the meter: 75 % self-powered.
    const { container } = render(EnergyFlow, { props: base })
    expect(container.textContent).toContain('75% SELF-POWERED')
  })

  it('clamps the share at 100 when exporting', () => {
    const { container } = render(EnergyFlow, {
      props: { ...base, gridW: -800 },
    })
    expect(container.textContent).toContain('100% SELF-POWERED')
    expect(container.textContent).toContain('exporting')
  })

  it('shows a dash for a reading that never arrived, never a zero', () => {
    const { container } = render(EnergyFlow, {
      props: { ...base, pvW: undefined },
    })
    expect(container.textContent).toContain('—')
    expect(container.textContent).toContain('no reading')
  })

  it('holds still when the view is cache, not now', () => {
    const liveDots = render(EnergyFlow, { props: base }).container.querySelectorAll('.dot')
    expect(liveDots.length).toBeGreaterThan(0)

    const cachedDots = render(EnergyFlow, {
      props: { ...base, live: false },
    }).container.querySelectorAll('.dot')
    expect(cachedDots.length).toBe(0)
  })

  it('treats a trickle as idle instead of animating noise', () => {
    const { container } = render(EnergyFlow, {
      props: { ...base, gridW: 20, batteryW: 10, pvW: -30 },
    })
    const text = container.textContent!
    expect(container.querySelectorAll('.dot').length).toBe(0)
    expect(text).toContain('idle')
  })
})
