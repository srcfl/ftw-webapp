/* From a site snapshot to the energy-flow component's planets.
 *
 * The box's own dashboard builds this list in web/app.js from /api/status.
 * Frozen fields on the 1 Hz stream are the fallback: five aggregates, no
 * names, no kWh today. Same component, same corners and colours — "same
 * views" only holds if the caller speaks to it the same way.
 *
 * The component knows nothing about field ids or HTTP. Everything it is
 * told is decided here, which is what makes this file worth testing.
 */

import { FID } from '$lib/format/explanation'
import { FLOW_IDLE_W } from '$vendor/ftw/ftw-energy-flow.js'

export interface FlowDailyPart {
  text: string
  color: string
  bold?: boolean
}

export interface FlowPlanet {
  id: string
  corner: 'top-left' | 'top-right' | 'bottom-left' | 'bottom-right'
  title: string
  role: 'grid' | 'pv' | 'battery' | 'ev'
  name?: string
  kw: number
  toHub: boolean
  color: string
  sub: string
  soc?: number | null
  chargeLimit?: number | null
  socStale?: boolean
  socSource?: string | null
  clickable?: boolean
  dailyKwh?: string | null
  dailyKwhParts?: FlowDailyPart[] | null
  dailyScope?: 'aggregate'
  dailyAggregateMembers?: number
}

export interface FlowReadings {
  load: number
  planets: FlowPlanet[]
  selfPoweredPctToday?: number | null
}

/** The slice of GET /api/status this mapping reads. Unknown-tolerant. */
export interface StatusDriver {
  status?: unknown
  not_running?: unknown
  observe_only?: unknown
  pv_w?: unknown
  bat_w?: unknown
  bat_soc?: unknown
  ev_w?: unknown
}

export interface StatusEnergyToday {
  import_wh?: unknown
  export_wh?: unknown
  pv_wh?: unknown
  load_wh?: unknown
  bat_charged_wh?: unknown
  bat_discharged_wh?: unknown
}

export interface SiteStatus {
  grid_w?: unknown
  pv_w?: unknown
  bat_w?: unknown
  load_w?: unknown
  energy?: { today?: StatusEnergyToday }
  drivers?: Record<string, StatusDriver>
  fuse?: {
    max_amps?: unknown
    phases?: unknown
    voltage?: unknown
  }
  phase_amps?: unknown
  phase_powers?: unknown
}

const idle = (w: number) => Math.abs(w) <= FLOW_IDLE_W

/**
 * Build the component's readings from the field map.
 *
 * A field that never arrived produces no planet — except the grid, which is
 * always drawn: a site that cannot see its own meter is a telemetry gap the
 * owner should see, and the box's dashboard makes the same call.
 */
export function flowReadings(fields: ReadonlyMap<number, number>): FlowReadings {
  const planets: FlowPlanet[] = []

  const gridW = fields.get(FID.GRID_W)
  if (gridW === undefined) {
    planets.push({
      id: 'grid', corner: 'bottom-left', title: 'GRID', role: 'grid',
      kw: 0, toHub: true, color: 'var(--fg-muted)', sub: 'no data', clickable: false,
    })
  } else {
    // Magnitude only: the sign is wire convention, and the sub line already
    // carries the direction. A minus over "exporting" is the raw sign the UI
    // never shows.
    const g = Math.abs(gridW) / 1000
    planets.push({
      id: 'grid', corner: 'bottom-left', title: 'GRID', role: 'grid',
      kw: g, toHub: gridW >= 0,
      color: idle(gridW) ? 'var(--fg-muted)' : gridW >= 0 ? 'var(--red-e)' : 'var(--green-e)',
      sub: idle(gridW) ? 'balanced' : gridW >= 0 ? 'importing' : 'exporting',
      clickable: true,
    })
  }

  const pvW = fields.get(FID.PV_W)
  if (pvW !== undefined) {
    // Site convention keeps pv_w negative while generating; the bubble
    // shows the magnitude, exactly as the dashboard does.
    const p = -pvW / 1000
    planets.push({
      id: 'pv', corner: 'top-left', title: 'SOLAR', role: 'pv',
      kw: p, toHub: true,
      color: idle(pvW) ? 'var(--fg-muted)' : 'var(--amber)',
      // One-directional: the number already says generating or idle.
      sub: '',
      clickable: true,
    })
  }

  const batteryW = fields.get(FID.BATTERY_W)
  if (batteryW !== undefined) {
    // Magnitude only, and the direction spelled out in the sub. A battery
    // moves power both ways, so unlike solar the number alone cannot say
    // which — and a raw minus is the one thing the UI never shows.
    const b = Math.abs(batteryW) / 1000
    const socPermille = fields.get(FID.BATTERY_SOC)
    planets.push({
      id: 'battery', corner: 'top-right', title: 'BATTERY', role: 'battery',
      kw: b, toHub: batteryW < 0,
      // Direction also in the value's colour: charge green (filling),
      // discharge red (draining), idle the battery's identity cyan.
      color: idle(batteryW) ? 'var(--cyan)' : batteryW >= 0 ? 'var(--green-e)' : 'var(--red-e)',
      sub: idle(batteryW) ? 'idle' : batteryW >= 0 ? 'charging' : 'discharging',
      soc: socPermille === undefined ? null : Math.round(socPermille / 10),
      clickable: true,
    })
  }

  // Present exactly when the site has a charger. No field, no node — an
  // invented idle charger would misrepresent absent hardware as present.
  const evW = fields.get(FID.EV_W)
  if (evW !== undefined) {
    const e = evW / 1000
    const active = !idle(evW)
    planets.push({
      id: 'ev', corner: 'bottom-right', title: 'EV CHARGER', role: 'ev',
      kw: e, toHub: false,
      color: active ? 'var(--green-e)' : 'var(--white-s)',
      sub: active ? 'charging' : 'idle',
      // The one bubble that opens something: the charger's sheet. The hero
      // makes a clickable planet a button with a name, so the tap target
      // and its announcement come from the component, not from here.
      clickable: true,
    })
  }

  return { load: (fields.get(FID.LOAD_W) ?? 0) / 1000, planets }
}

/**
 * Charger watts the box's HTTP API already knows, summed.
 *
 * Loadpoints carry the same SmoothedW the dashboard uses. Field 10 on the
 * 1 Hz stream is supposed to be that sum; until a box counts a charger that
 * cannot take a command, this is the number that stream is missing.
 */
export function loadpointChargeW(points: readonly { powerW: number }[]): number {
  let sum = 0
  for (const p of points) {
    if (p.powerW > FLOW_IDLE_W) sum += p.powerW
  }
  return sum
}

/**
 * Put the car back on its own node when the 1 Hz stream folded it into the
 * house.
 *
 * The overlay fires only when the stream is silent or idle and a loadpoint
 * is not. A box that already sends field 10 is left alone, so the two
 * sources cannot fight.
 */
export function withLoadpointEv(
  fields: ReadonlyMap<number, number>,
  evW: number
): ReadonlyMap<number, number> {
  if (evW <= FLOW_IDLE_W) return fields
  const wire = fields.get(FID.EV_W)
  if (wire !== undefined && Math.abs(wire) > FLOW_IDLE_W) return fields

  const out = new Map(fields)
  const load = out.get(FID.LOAD_W) ?? 0
  out.set(FID.EV_W, Math.round(evW))
  out.set(FID.LOAD_W, Math.max(0, load - evW))
  return out
}

const num = (v: unknown): number | null =>
  typeof v === 'number' && Number.isFinite(v) ? v : null

/** Same rule the dashboard uses: a faulted charger still has a planet. */
function driverOnline(d: StatusDriver): boolean {
  const status = typeof d.status === 'string' ? d.status : ''
  return status !== 'offline' && status !== 'disabled' && d.not_running !== true
}

/**
 * Compact kWh for a bubble line. Copied from the dashboard's fmtKwhShort so
 * a person comparing this screen with the box page sees the same figure.
 */
export interface FusePhase {
  label: string
  amps: number
  watts: number
  pct: number
  exporting: boolean
}

export interface FuseView {
  maxAmps: number
  phases: FusePhase[]
  /** Used when the meter does not report per-phase amps. */
  fallback: { amps: number; pct: number } | null
}

function ampList(v: unknown): number[] {
  return Array.isArray(v) ? v.map((x) => num(x) ?? 0) : []
}

/**
 * The live fuse reading the dashboard draws on Overview.
 *
 * Per-phase when the meter reports amps; otherwise one bar from grid, PV
 * and battery throughput, the same fallback the box page uses.
 */
export function fuseView(status: SiteStatus): FuseView | null {
  const fuse = status.fuse
  if (!fuse) return null
  const maxAmps = num(fuse.max_amps)
  if (maxAmps === null || maxAmps <= 0) return null
  const n = Math.max(1, Math.min(3, Math.round(num(fuse.phases) ?? 3)))
  const voltage = num(fuse.voltage) ?? 230
  const phaseI = ampList(status.phase_amps)
  const phaseW = ampList(status.phase_powers)

  if (phaseI.length > 0) {
    const phases: FusePhase[] = []
    for (let i = 0; i < n; i++) {
      const amps = phaseI[i] ?? 0
      const watts = phaseW[i] ?? 0
      phases.push({
        label: `L${i + 1}`,
        amps,
        watts,
        pct: Math.min(100, (Math.abs(amps) / maxAmps) * 100),
        exporting: amps < -0.1,
      })
    }
    return { maxAmps, phases, fallback: null }
  }

  const gridW = Math.abs(num(status.grid_w) ?? 0)
  const pvW = Math.abs(num(status.pv_w) ?? 0)
  const batW = num(status.bat_w) ?? 0
  const discharge = batW < 0 ? -batW : 0
  const throughput = Math.max(gridW, pvW + discharge)
  const amps = throughput / voltage / n
  return {
    maxAmps,
    phases: [],
    fallback: { amps, pct: Math.min(100, (amps / maxAmps) * 100) },
  }
}

export function fmtKwhShort(kwh: number): string {
  const v = Math.abs(kwh)
  if (v >= 100) return kwh.toFixed(0)
  if (v >= 10) return kwh.toFixed(1)
  return kwh.toFixed(2)
}

/**
 * The dashboard's own planet list, from the same /api/status it polls.
 *
 * Per-driver bubbles, kWh today on each corner, self-powered share. This is
 * why the box page looks finished and the frozen-field mapping does not:
 * the component already knows how to draw all of it.
 */
export function flowReadingsFromStatus(status: SiteStatus): FlowReadings {
  const planets: FlowPlanet[] = []
  const today = status.energy?.today ?? {}
  const importKwh = (num(today.import_wh) ?? 0) / 1000
  const exportKwh = (num(today.export_wh) ?? 0) / 1000
  const pvKwhTotal = (num(today.pv_wh) ?? 0) / 1000
  const loadKwhTotal = (num(today.load_wh) ?? 0) / 1000
  const batChargedKwh = (num(today.bat_charged_wh) ?? 0) / 1000
  const batDischargedKwh = (num(today.bat_discharged_wh) ?? 0) / 1000

  const pvDailyStr = `${fmtKwhShort(pvKwhTotal)} kWh`
  const gridDailyParts: FlowDailyPart[] = [
    { text: `↓ ${fmtKwhShort(importKwh)}`, color: 'var(--red-e)', bold: true },
    { text: `↑ ${fmtKwhShort(exportKwh)}`, color: 'var(--green-e)', bold: true },
  ]
  const batDailyParts: FlowDailyPart[] = [
    { text: `↑ ${fmtKwhShort(batChargedKwh)}`, color: 'var(--green-e)', bold: true },
    { text: `↓ ${fmtKwhShort(batDischargedKwh)}`, color: 'var(--red-e)', bold: true },
  ]

  const gridW = num(status.grid_w)
  if (gridW === null) {
    planets.push({
      id: 'grid', corner: 'bottom-left', title: 'GRID', role: 'grid',
      kw: 0, toHub: true, color: 'var(--fg-muted)', sub: 'no data', clickable: false,
    })
  } else {
    const gIdle = idle(gridW)
    planets.push({
      id: 'grid', corner: 'bottom-left', title: 'GRID', role: 'grid',
      // Magnitude only: the sign is wire convention. Direction travels as
      // toHub and as the sub line, never as a minus on the number.
      kw: Math.abs(gridW) / 1000, toHub: gridW >= 0,
      color: gIdle ? 'var(--fg-muted)' : gridW >= 0 ? 'var(--red-e)' : 'var(--green-e)',
      sub: gIdle ? 'balanced' : gridW >= 0 ? 'importing' : 'exporting',
      dailyKwhParts: gridDailyParts,
      clickable: true,
    })
  }

  const drivers = status.drivers ?? {}
  const names = Object.keys(drivers)
  let pvDailyMembers = 0
  let batDailyMembers = 0
  for (const name of names) {
    const d = drivers[name]
    if (!d) continue
    if (d.pv_w != null) pvDailyMembers++
    if (d.bat_w != null) batDailyMembers++
  }

  for (const name of names) {
    const d = drivers[name]
    if (!d || !driverOnline(d)) continue

    const pvW = num(d.pv_w)
    if (pvW !== null) {
      const pvKw = -pvW / 1000
      const pvGen = !idle(pvW)
      planets.push({
        id: `pv-${name}`, corner: 'top-left', title: 'SOLAR', role: 'pv', name,
        kw: pvKw, toHub: true,
        color: pvGen ? 'var(--amber)' : 'var(--fg-muted)',
        sub: '',
        dailyKwh: pvDailyStr,
        dailyScope: 'aggregate',
        dailyAggregateMembers: pvDailyMembers,
        clickable: true,
      })
    }

    const batW = num(d.bat_w)
    if (batW !== null) {
      const bIdle = idle(batW)
      const soc = num(d.bat_soc)
      planets.push({
        id: `bat-${name}`, corner: 'top-right', title: 'BATTERY', role: 'battery', name,
        // Signed, as the dashboard sends it: the hero folds several packs
        // into one bubble by summing kw, then names the total from the
        // sign. Magnitude here made two discharging packs look like a
        // charge.
        kw: batW / 1000, toHub: batW < 0,
        color: bIdle ? 'var(--cyan)' : batW >= 0 ? 'var(--green-e)' : 'var(--red-e)',
        sub: d.observe_only === true ? 'observe only' : bIdle ? 'idle' : batW >= 0 ? 'charging' : 'discharging',
        soc: soc === null ? null : Math.round(soc * 100),
        dailyKwhParts: batDailyParts,
        dailyScope: 'aggregate',
        dailyAggregateMembers: batDailyMembers,
        clickable: d.observe_only !== true,
      })
    }

    const evW = num(d.ev_w)
    if (evW !== null) {
      const active = !idle(evW)
      planets.push({
        id: `ev-${name}`, corner: 'bottom-right', title: 'EV CHARGER', role: 'ev', name,
        kw: Math.abs(evW) / 1000, toHub: false,
        color: active ? 'var(--green-e)' : 'var(--white-s)',
        sub: active ? 'charging' : 'idle',
        clickable: true,
      })
    }
  }

  let selfPoweredPctToday: number | null = null
  if (loadKwhTotal > 0.001) {
    selfPoweredPctToday = Math.max(0, Math.min(100, (1 - importKwh / loadKwhTotal) * 100))
  }

  return {
    load: (num(status.load_w) ?? 0) / 1000,
    planets,
    selfPoweredPctToday,
  }
}
