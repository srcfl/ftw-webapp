import { describe, it, expect } from 'vitest'
import {
  flowReadings,
  flowReadingsFromStatus,
  fmtKwhShort,
  fuseView,
  loadpointChargeW,
  withLoadpointEv,
  type SiteStatus,
} from './flow'
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

const STATUS: SiteStatus = {
  grid_w: 500,
  load_w: 970,
  energy: {
    today: {
      import_wh: 5200,
      export_wh: 12_400,
      pv_wh: 18_100,
      load_wh: 14_000,
      bat_charged_wh: 4100,
      bat_discharged_wh: 2800,
    },
  },
  drivers: {
    east: { status: 'ok', pv_w: -1800 },
    west: { status: 'ok', pv_w: -500 },
    lynx: { status: 'ok', bat_w: 1800, bat_soc: 0.687 },
    easee: { status: 'ok', ev_w: 7200 },
    dead: { status: 'offline', pv_w: -900 },
  },
}

describe('flowReadingsFromStatus', () => {
  it('draws one planet per live driver, not one aggregate per corner', () => {
    const r = flowReadingsFromStatus(STATUS)
    expect(r.planets.map((p) => p.id).sort()).toEqual([
      'bat-lynx',
      'ev-easee',
      'grid',
      'pv-east',
      'pv-west',
    ])
    expect(r.planets.some((p) => p.id === 'pv-dead'), 'an offline inverter became a planet').toBe(
      false,
    )
    expect(r.load).toBeCloseTo(0.97)
  })

  it('keeps a faulted charger on the diagram, the way the dashboard does', () => {
    const r = flowReadingsFromStatus({
      grid_w: 0,
      load_w: 200,
      drivers: { easee: { status: 'fault', ev_w: 11_400 } },
    })
    expect(r.planets.find((p) => p.id === 'ev-easee')?.kw).toBeCloseTo(11.4)
  })

  it('writes today onto the bubbles and the self-powered share', () => {
    const r = flowReadingsFromStatus(STATUS)
    const grid = r.planets.find((p) => p.id === 'grid')!
    expect(grid.dailyKwhParts?.map((p) => p.text)).toEqual(['↓ 5.20', '↑ 12.4'])
    const solar = r.planets.find((p) => p.id === 'pv-east')!
    expect(solar.dailyKwh).toBe('18.1 kWh')
    expect(solar.dailyScope).toBe('aggregate')
    expect(solar.dailyAggregateMembers).toBe(3)
    expect(r.selfPoweredPctToday).toBeCloseTo((1 - 5.2 / 14) * 100)
  })

  it('keeps battery sign so two discharging packs do not look like charging', () => {
    const r = flowReadingsFromStatus({
      grid_w: 0,
      load_w: 3500,
      drivers: {
        a: { status: 'ok', bat_w: -2000, bat_soc: 0.4 },
        b: { status: 'ok', bat_w: -1500, bat_soc: 0.5 },
      },
    })
    const bats = r.planets.filter((p) => p.role === 'battery')
    expect(bats.reduce((sum, p) => sum + p.kw, 0)).toBeCloseTo(-3.5)
    expect(bats.every((p) => p.sub === 'discharging')).toBe(true)
  })

  it('keeps grid, solar and the charger as magnitudes', () => {
    const r = flowReadingsFromStatus({
      grid_w: -3400,
      load_w: 900,
      drivers: {
        sungrow: { status: 'ok', pv_w: -2300 },
        lynx: { status: 'ok', bat_w: -2000, bat_soc: 0.4 },
        easee: { status: 'ok', ev_w: 0 },
      },
    })
    for (const p of r.planets.filter((x) => x.role !== 'battery')) {
      expect(p.kw, `${p.id} carried the wire's sign into the hero`).toBeGreaterThanOrEqual(0)
    }
    expect(r.planets.find((p) => p.id === 'grid')?.sub).toBe('exporting')
    expect(r.planets.find((p) => p.id === 'bat-lynx')?.sub).toBe('discharging')
    expect(r.planets.find((p) => p.id === 'bat-lynx')?.soc).toBe(40)
  })
})

describe('fmtKwhShort', () => {
  it('matches the dashboard bubble rounding', () => {
    expect(fmtKwhShort(5.2)).toBe('5.20')
    expect(fmtKwhShort(12.4)).toBe('12.4')
    expect(fmtKwhShort(100.6)).toBe('101')
  })
})

describe('fuseView', () => {
  it('draws one bar per live phase', () => {
    const v = fuseView({
      fuse: { max_amps: 20, phases: 3, voltage: 230 },
      phase_amps: [12, -3, 18],
      phase_powers: [2700, -700, 4100],
    })
    expect(v?.phases.map((p) => p.label)).toEqual(['L1', 'L2', 'L3'])
    expect(v?.phases[2]?.pct).toBeCloseTo(90)
    expect(v?.phases[1]?.exporting).toBe(true)
    expect(v?.fallback).toBeNull()
  })

  it('falls back to throughput when the meter has no phases', () => {
    const v = fuseView({
      grid_w: 6900,
      pv_w: 0,
      bat_w: 0,
      fuse: { max_amps: 20, phases: 3, voltage: 230 },
    })
    expect(v?.phases).toEqual([])
    expect(v?.fallback?.amps).toBeCloseTo(10)
    expect(v?.fallback?.pct).toBeCloseTo(50)
  })

  it('stays absent without a fuse rating', () => {
    expect(fuseView({ grid_w: 1000 })).toBeNull()
  })
})
