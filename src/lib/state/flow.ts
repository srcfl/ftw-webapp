/* From frozen fields to the energy-flow component's planets.
 *
 * The box's own dashboard builds this list in web/app.js from /api/status;
 * this is the same mapping fed from the wire's frozen fields instead. Roles,
 * corners, colours and directions match the dashboard's choices exactly —
 * "same components, same views" only holds if the caller speaks to the
 * component the same way.
 *
 * The component knows nothing about field ids or freshness. Everything it is
 * told is decided here, which is what makes this file worth testing.
 */

import { FID } from '$lib/format/explanation'
import { FLOW_IDLE_W } from '$vendor/ftw/ftw-energy-flow.js'

export interface FlowPlanet {
  id: string
  corner: 'top-left' | 'top-right' | 'bottom-left' | 'bottom-right'
  title: string
  role: 'grid' | 'pv' | 'battery' | 'ev'
  kw: number
  toHub: boolean
  color: string
  sub: string
  soc?: number | null
  clickable?: boolean
}

export interface FlowReadings {
  load: number
  planets: FlowPlanet[]
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
      clickable: false,
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
      clickable: false,
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
      clickable: false,
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
