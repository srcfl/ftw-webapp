import { describe, it, expect } from 'vitest'
import { flowReadings } from './flow'
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
})
