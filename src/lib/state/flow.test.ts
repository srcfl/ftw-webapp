import { describe, it, expect } from 'vitest'
import { flowReadings, loadpointChargeW, withLoadpointEv } from './flow'
import { FID } from '$lib/format/explanation'

// The mapping between frozen fields and the vendored hero component. The
// component itself is the box's file and is not under test here — what is
// under test is every decision the app makes before speaking to it: signs,
// directions, colours, and above all which nodes exist.

const fields = (entries: [number, number][]) => new Map<number, number>(entries)

const FULL: [number, number][] = [
  [FID.GRID_W, 500],
  [FID.PV_W, -2300],
  [FID.BATTERY_W, 1800],
  [FID.BATTERY_SOC, 687],
  [FID.LOAD_W, 970],
  [FID.EV_W, 7200],
]

describe('flowReadings', () => {
  it('maps every field to the corner the dashboard uses', () => {
    const r = flowReadings(fields(FULL))
    const byId = Object.fromEntries(r.planets.map((p) => [p.id, p]))

    expect(byId['grid']?.corner).toBe('bottom-left')
    expect(byId['pv']?.corner).toBe('top-left')
    expect(byId['battery']?.corner).toBe('top-right')
    expect(byId['ev']?.corner).toBe('bottom-right')
    expect(r.load).toBeCloseTo(0.97)
  })

  it('shows solar as magnitude while keeping the wire negative', () => {
    const pv = flowReadings(fields(FULL)).planets.find((p) => p.id === 'pv')!
    expect(pv.kw).toBeCloseTo(2.3)
    expect(pv.toHub).toBe(true)
  })

  it('sends charge away from the hub and discharge toward it', () => {
    const charging = flowReadings(fields(FULL)).planets.find((p) => p.id === 'battery')!
    expect(charging.toHub).toBe(false)
    expect(charging.soc).toBe(69)

    const discharging = flowReadings(
      fields([[FID.BATTERY_W, -2000], [FID.GRID_W, 0], [FID.LOAD_W, 2000]])
    ).planets.find((p) => p.id === 'battery')!
    expect(discharging.toHub).toBe(true)
  })

  it('flips the grid between importing and exporting', () => {
    const importing = flowReadings(fields([[FID.GRID_W, 800]])).planets[0]!
    expect(importing.toHub).toBe(true)
    expect(importing.sub).toBe('importing')

    const exporting = flowReadings(fields([[FID.GRID_W, -800]])).planets[0]!
    expect(exporting.toHub).toBe(false)
    expect(exporting.sub).toBe('exporting')
  })

  it('draws no EV node when the site never sent field 10', () => {
    // The rule the wire change was built around: absence of hardware is
    // absence of a node, never a dead bubble holding an invented zero.
    const without = FULL.filter(([fid]) => fid !== FID.EV_W)
    const r = flowReadings(fields(without))
    expect(r.planets.some((p) => p.id === 'ev')).toBe(false)
  })

  it('draws an idle EV node when the charger exists and rests', () => {
    const r = flowReadings(fields([...FULL.filter(([f]) => f !== FID.EV_W), [FID.EV_W, 0]]))
    const ev = r.planets.find((p) => p.id === 'ev')!
    expect(ev.sub).toBe('idle')
  })

  it('always draws the grid, even unreported — a meterless site is a fault to see', () => {
    const r = flowReadings(fields([[FID.PV_W, -1000]]))
    const grid = r.planets.find((p) => p.id === 'grid')!
    expect(grid.sub).toBe('no data')
  })

  it('never hands the component a negative number to draw', () => {
    // The wire's sign is direction — positive into the site, negative out —
    // and the hero renders kw as text, so a sign passed through here is a raw
    // minus on screen: "-3.40 kW" over "exporting". Direction travels as
    // toHub and as the sub line's word, never as the number's sign.
    const everythingOutward = flowReadings(
      fields([
        [FID.GRID_W, -3_400],
        [FID.PV_W, -2_300],
        [FID.BATTERY_W, -2_000],
        [FID.EV_W, 0],
        [FID.LOAD_W, 900],
      ])
    )
    for (const p of everythingOutward.planets) {
      expect(p.kw, `${p.id} carried the wire's sign into the hero`).toBeGreaterThanOrEqual(0)
    }
  })

  it('says which way the battery is moving, in the component’s own words', () => {
    // A battery moves power both ways, so unlike solar the magnitude alone
    // cannot say which. Without the word, "2.00 kW" is a battery doing
    // something unstated.
    const discharging = flowReadings(fields([[FID.BATTERY_W, -2_000]])).planets.find(
      (p) => p.id === 'battery'
    )!
    expect(discharging.kw).toBeCloseTo(2)
    expect(discharging.sub).toBe('discharging')

    const charging = flowReadings(fields([[FID.BATTERY_W, 1_800]])).planets.find(
      (p) => p.id === 'battery'
    )!
    expect(charging.sub).toBe('charging')

    const resting = flowReadings(fields([[FID.BATTERY_W, 0]])).planets.find(
      (p) => p.id === 'battery'
    )!
    expect(resting.sub).toBe('idle')
  })
})

describe('withLoadpointEv', () => {
  it('leaves a live field 10 alone', () => {
    const src = fields([...FULL])
    const out = withLoadpointEv(src, 11_400)
    expect(out).toBe(src)
    expect(flowReadings(out).planets.find((p) => p.id === 'ev')!.kw).toBeCloseTo(7.2)
  })

  it('splits a silent stream so the car is not the house', () => {
    // The phone bug: field 10 at 0 W, house holding house+car (~12.7 kW).
    const folded = fields([
      [FID.GRID_W, 0],
      [FID.PV_W, -3300],
      [FID.BATTERY_W, -9900],
      [FID.LOAD_W, 12_700],
      [FID.EV_W, 0],
    ])
    const out = withLoadpointEv(folded, 11_400)
    const r = flowReadings(out)
    expect(r.load).toBeCloseTo(1.3)
    const ev = r.planets.find((p) => p.id === 'ev')!
    expect(ev.kw).toBeCloseTo(11.4)
    expect(ev.sub).toBe('charging')
  })

  it('draws the EV node when the stream never sent field 10', () => {
    const without = fields(FULL.filter(([fid]) => fid !== FID.EV_W))
    const r = flowReadings(withLoadpointEv(without, 7200))
    expect(r.planets.find((p) => p.id === 'ev')?.kw).toBeCloseTo(7.2)
  })
})

describe('loadpointChargeW', () => {
  it('sums only chargers that are actually drawing', () => {
    expect(loadpointChargeW([{ powerW: 11_400 }, { powerW: 20 }, { powerW: 0 }])).toBe(11_400)
  })
})
