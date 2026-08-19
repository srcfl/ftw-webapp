import { describe, it, expect } from 'vitest'
import { explain, FID, type ExplainInput } from './explanation'

const f = (v: Partial<Record<number, number>>): ReadonlyMap<number, number> =>
  new Map(Object.entries(v).map(([k, val]) => [Number(k), val!]))

/**
 * PV values here are negative, which is FTW's convention and not a typo:
 * docs/site-convention.md states PV is never positive, so pv_w = -4000 means
 * generating 4 kW. The simulator used to emit it positive and these tests
 * agreed with it, which is how a wrong sign survives a green suite.
 */
const input = (fields: ReadonlyMap<number, number>, over: Partial<ExplainInput> = {}): ExplainInput => ({
  fields,
  dispatchBlockedBy: [],
  ceilingW: 11_000,
  ...over,
})

describe('explain', () => {
  it('says why nothing is happening rather than looking broken', () => {
    const r = explain(
      input(f({ [FID.GRID_W]: 3000, [FID.LOAD_W]: 3000 }), { dispatchBlockedBy: ['meter.p1'] })
    )
    expect(r.situation).toBe('dispatch_blocked')
    expect(r.headline).toMatch(/stopped reporting/)
    expect(r.headline).toMatch(/running normally/)
  })

  it('names the ceiling when the battery is defending one', () => {
    const r = explain(
      input(f({ [FID.GRID_W]: 11_000, [FID.PV_W]: 0, [FID.BATTERY_W]: -4200, [FID.LOAD_W]: 15_200 }))
    )

    expect(r.situation).toBe('battery_shaving')
    expect(r.headline).toBe('The battery is supplying 4.2 kW to keep grid import below 11 kW.')
  })

  it('describes the battery covering the house on its own', () => {
    const r = explain(input(f({ [FID.GRID_W]: 0, [FID.PV_W]: 0, [FID.BATTERY_W]: -2100, [FID.LOAD_W]: 2100 })))
    expect(r.situation).toBe('battery_covering')
    expect(r.headline).toBe('The battery is covering the house, so nothing is coming from the grid.')
  })

  it('names the car when the battery is covering a charge', () => {
    const r = explain(
      input(
        f({
          [FID.GRID_W]: 0,
          [FID.PV_W]: -3300,
          [FID.BATTERY_W]: -9900,
          [FID.LOAD_W]: 1800,
          [FID.EV_W]: 11_400,
        })
      )
    )
    expect(r.situation).toBe('battery_covering')
    expect(r.headline).toMatch(/house and the car/)
    expect(r.headline).not.toContain('-')
  })

  it('describes export as sending back, not as a negative number', () => {
    const r = explain(input(f({ [FID.GRID_W]: -3400, [FID.PV_W]: -7000, [FID.BATTERY_W]: 0, [FID.LOAD_W]: 3600 })))
    expect(r.situation).toBe('exporting_surplus')
    expect(r.headline).toMatch(/back to the grid/)
    expect(r.headline).not.toContain('-')
  })

  it('describes surplus solar charging the battery', () => {
    const r = explain(input(f({ [FID.GRID_W]: 0, [FID.PV_W]: -6000, [FID.BATTERY_W]: 3000, [FID.LOAD_W]: 3000 })))
    expect(r.situation).toBe('charging_from_surplus')
    expect(r.headline).toMatch(/charging the battery at 3.0 kW/)
  })

  it('distinguishes solar covering everything from covering part', () => {
    const all = explain(input(f({ [FID.GRID_W]: 0, [FID.PV_W]: -4000, [FID.BATTERY_W]: 0, [FID.LOAD_W]: 4000 })))
    expect(all.situation).toBe('solar_covering')

    const part = explain(
      input(f({ [FID.GRID_W]: 2000, [FID.PV_W]: -2000, [FID.BATTERY_W]: 0, [FID.LOAD_W]: 4000 }))
    )
    expect(part.situation).toBe('solar_partial')
  })

  it('falls back to plain import at night', () => {
    const r = explain(input(f({ [FID.GRID_W]: 2400, [FID.PV_W]: 0, [FID.BATTERY_W]: 0, [FID.LOAD_W]: 2400 })))
    expect(r.situation).toBe('importing')
    expect(r.headline).toBe('The house is drawing 2.4 kW from the grid.')
  })

  it('admits it has nothing rather than inventing a story', () => {
    const r = explain(input(f({})))
    expect(r.situation).toBe('no_data')
    expect(r.headline).toMatch(/Waiting/)
  })

  it('never shows a minus sign in any situation', () => {
    const cases: ReadonlyMap<number, number>[] = [
      f({ [FID.GRID_W]: -3400, [FID.PV_W]: -7000, [FID.BATTERY_W]: 0, [FID.LOAD_W]: 3600 }),
      f({ [FID.GRID_W]: 0, [FID.PV_W]: 0, [FID.BATTERY_W]: -2100, [FID.LOAD_W]: 2100 }),
      f({ [FID.GRID_W]: 11_000, [FID.PV_W]: 0, [FID.BATTERY_W]: -4200, [FID.LOAD_W]: 15_200 }),
      f({ [FID.GRID_W]: 900, [FID.PV_W]: 0, [FID.BATTERY_W]: -1500, [FID.LOAD_W]: 2400 }),
    ]

    for (const c of cases) {
      expect(explain(input(c)).headline).not.toContain('-')
    }
  })

  it('always returns a complete sentence', () => {
    const cases: ReadonlyMap<number, number>[] = [
      f({}),
      f({ [FID.GRID_W]: 0, [FID.LOAD_W]: 0 }),
      f({ [FID.GRID_W]: 2400, [FID.LOAD_W]: 2400 }),
      f({ [FID.GRID_W]: -100, [FID.PV_W]: -500, [FID.LOAD_W]: 400 }),
    ]

    for (const c of cases) {
      const h = explain(input(c)).headline
      expect(h.length).toBeGreaterThan(10)
      expect(h.endsWith('.')).toBe(true)
      expect(h[0]).toBe(h[0]!.toUpperCase())
    }
  })

  it('drops the ceiling clause when the ceiling is unknown', () => {
    const r = explain(
      input(f({ [FID.GRID_W]: 900, [FID.PV_W]: 0, [FID.BATTERY_W]: -1500, [FID.LOAD_W]: 2400 }), {
        ceilingW: null,
      })
    )
    expect(r.headline).not.toMatch(/below/)
    expect(r.headline).toMatch(/from the grid/)
  })
})
