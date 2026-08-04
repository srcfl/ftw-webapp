import { describe, it, expect } from 'vitest'
import { planHeadline, slotAction, reasonText, formatPrice, MODE_LABEL, MODE_HELP } from './plan'
import type { Plan, PlanSlot, PlanReason, SiteMode } from '$lib/protocol/messages'
import { SITE_MODES } from '$lib/protocol/messages'

const T0 = Date.UTC(2026, 6, 15, 12, 0, 0)
const SLOT = 900_000

function slot(i: number, batteryW: number, reason: PlanReason = 'idle'): PlanSlot {
  return {
    startMs: T0 + i * SLOT,
    durationMs: SLOT,
    batteryW,
    gridW: 1000,
    priceMinor: 80,
    reason,
  }
}

function plan(slots: PlanSlot[], over: Partial<Plan> = {}): Plan {
  return { rev: 1, uptimeMs: 1000, slots, stale: false, ceilingW: 11_000, ...over }
}

describe('slotAction', () => {
  it('treats small values as rest rather than movement', () => {
    expect(slotAction(slot(0, 0))).toBe('idle')
    expect(slotAction(slot(0, 30))).toBe('idle')
    expect(slotAction(slot(0, -30))).toBe('idle')
    expect(slotAction(slot(0, 3000))).toBe('charge')
    expect(slotAction(slot(0, -3000))).toBe('discharge')
  })
})

describe('planHeadline', () => {
  it('says what happens next, not only what is happening', () => {
    // The Now screen already shows the present. The reason to open a plan is
    // to find out what is about to change.
    const p = plan([
      slot(0, 3000, 'cheap_import'),
      slot(1, 3000, 'cheap_import'),
      slot(2, -2000, 'expensive_import'),
    ])

    const h = planHeadline(p, T0 + 60_000)
    expect(h.text).toMatch(/charging at 3.0 kW/)
    expect(h.text).toMatch(/Then it covers the house/)
    expect(h.slotIndex).toBe(0)
  })

  it('never shows a minus sign', () => {
    const p = plan([slot(0, -4200, 'peak_shaving'), slot(1, 0)])
    expect(planHeadline(p, T0).text).not.toContain('-')
  })

  it('rounds the wait to something a person would say', () => {
    const p = plan([slot(0, 3000), slot(1, 3000), slot(2, 3000), slot(3, -1000)])
    // Three quarters of an hour away, give or take.
    expect(planHeadline(p, T0).text).toMatch(/in about an hour|in about half an hour|in \d+ min/)
  })

  it('admits when the planner could not run', () => {
    // "Nothing is scheduled" and "we do not know what is scheduled" are
    // different sentences, and only one of them is true here.
    const h = planHeadline(plan([slot(0, 3000)], { stale: true }), T0)
    expect(h.text).toMatch(/couldn't plan ahead/)
    expect(h.text).toMatch(/safe defaults/)
  })

  it('says so plainly when there is no plan at all', () => {
    expect(planHeadline(null, T0).text).toBe('No plan yet.')
  })

  it('handles a plan that does not cover now', () => {
    const h = planHeadline(plan([slot(0, 3000)]), T0 - 86_400_000)
    expect(h.text).toMatch(/No plan for right now/)
    expect(h.slotIndex).toBeNull()
  })

  it('does not invent a change that never comes', () => {
    const p = plan([slot(0, 0, 'reserve_held'), slot(1, 0, 'reserve_held')])
    const h = planHeadline(p, T0)
    expect(h.text).not.toMatch(/Then/)
    expect(h.text).toMatch(/resting/)
  })

  it('always ends a sentence', () => {
    const cases: Plan[] = [
      plan([slot(0, 3000, 'cheap_import'), slot(1, -1000, 'expensive_import')]),
      plan([slot(0, 0, 'idle')]),
      plan([slot(0, -4200, 'peak_shaving')], { stale: true }),
    ]
    for (const p of cases) {
      const text = planHeadline(p, T0).text
      expect(text.endsWith('.')).toBe(true)
      expect(text[0]).toBe(text[0]!.toUpperCase())
    }
  })
})

describe('the vocabulary is complete', () => {
  it('has a label and a help line for every mode', () => {
    // A mode without copy would render as a blank button.
    for (const mode of SITE_MODES as readonly SiteMode[]) {
      expect(MODE_LABEL[mode]).toBeTruthy()
      expect(MODE_HELP[mode]).toBeTruthy()
      expect(MODE_HELP[mode].endsWith('.')).toBe(true)
    }
  })

  it('has words for every reason the box can send', () => {
    const reasons: PlanReason[] = [
      'cheap_import',
      'expensive_import',
      'solar_surplus',
      'peak_shaving',
      'reserve_held',
      'export_paid',
      'idle',
    ]
    for (const r of reasons) {
      expect(reasonText(r)).toBeTruthy()
      expect(reasonText(r)).not.toContain('_')
    }
  })
})

describe('formatPrice', () => {
  it('renders minor units as currency', () => {
    expect(formatPrice(80)).toBe('0.80')
    expect(formatPrice(145)).toBe('1.45')
  })

  it('returns null rather than a fake price', () => {
    expect(formatPrice(null)).toBeNull()
    expect(formatPrice(NaN)).toBeNull()
  })
})
