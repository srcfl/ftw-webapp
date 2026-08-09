import { describe, it, expect } from 'vitest'
import { planHeadline, slotAction, reasonText, formatPrice, modeLabel, modeHelp } from './plan'
import { formatPrice as boxPrice, unitLabel } from '$vendor/ftw/price-units.js'
import type { Plan, PlanSlot, PlanReason, ModeInfo } from '$lib/protocol/messages'

/**
 * FTW's modes, from control.AllModes() in go/internal/control/dispatch.go.
 *
 * Listed here so a divergence fails a test rather than shipping an app that
 * offers strategies the box has never heard of. See contract/registry.yaml.
 */
const FTW_MODES = [
  'planner_passive_arbitrage',
  'planner_arbitrage',
  'idle',
  'self_consumption',
  'peak_shaving',
  'charge',
  'planner_self',
  'planner_cheap',
  'priority',
  'weighted',
] as const

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
    // The unit must survive the sentence around it: "2.0 kW", never "2.0 kw"
    // — a lowercased clause once dragged the unit down with it.
    expect(h.text).not.toMatch(/\d\s*k?w\b/)
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

describe('mode wording comes from the box', () => {
  // The failure this replaces: the app renamed FTW's modes — "Passive
  // arbitrage" became "Cheapest power" — so the same setting had two names,
  // one in FTW's own web UI and one here, and support would need both.
  it('shows exactly what the box sent', () => {
    const info: ModeInfo = {
      key: 'planner_passive_arbitrage',
      label: 'Passive arbitrage',
      tooltip:
        'Charge from the cheapest available source (PV when sunny, grid during cheap hours). Never exports from battery.',
      tier: 'primary',
    }
    expect(modeLabel(info)).toBe('Passive arbitrage')
    expect(modeHelp(info)).toBe(info.tooltip)
  })

  it('renders a mode this build has never heard of', () => {
    // A newer box shipping a new strategy is usable immediately, because the
    // app was never the one deciding what exists.
    const unknown: ModeInfo = {
      key: 'some_future_strategy',
      label: 'Future strategy',
      tooltip: 'Something this build predates.',
      tier: 'primary',
    }
    expect(modeLabel(unknown)).toBe('Future strategy')
    expect(modeHelp(unknown)).toBe('Something this build predates.')
  })

  it('knows the keys FTW actually has', () => {
    // Not a list the app renders from — the box sends that. This exists so a
    // divergence in the contract file fails a test.
    expect(FTW_MODES).toContain('planner_passive_arbitrage')
    expect(FTW_MODES).toContain('planner_arbitrage')
    expect(FTW_MODES).toHaveLength(10)
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
  it('is the number the chart puts on the same hour', () => {
    // The chart directly above the timeline renders every price through the
    // box's table, so that table is the reference here rather than a number
    // written out by hand: this column and that chart have to be the same
    // money in the same unit, or the screen asks its reader to divide by a
    // hundred to compare two lines of it.
    //
    // Both scales, because they are the interesting difference between
    // currencies: öre and cent are quoted in the minor unit, koruna in the
    // major one, and only the table knows which is which.
    const cases = [
      [144, 'SEK'],
      [80, 'SEK'],
      [17, 'EUR'],
      [400, 'CZK'],
    ] as const

    for (const [minor, currency] of cases) {
      expect(`${formatPrice(minor, currency)} ${unitLabel(currency)}`).toBe(
        boxPrice(minor, currency)
      )
    }
  })

  it('returns null rather than a fake price', () => {
    expect(formatPrice(null, 'SEK')).toBeNull()
    expect(formatPrice(NaN, 'SEK')).toBeNull()
  })
})
