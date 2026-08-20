/* Types for the vendored component — the surface the app actually uses.
 * The implementation is the box's own file, untouched; see the header there.
 */

export const FLOW_IDLE_W: number
export const FLOW_IDLE_KW: number
export function isIdleKw(kw: number): boolean

export interface FtwFlowDailyPart {
  text: string
  color: string
  bold?: boolean
}

export interface FtwFlowPlanet {
  id: string
  corner: 'top-left' | 'top-right' | 'bottom-left' | 'bottom-right'
  title: string
  role?: string
  name?: string | null
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
  dailyKwhParts?: FtwFlowDailyPart[] | null
  dailyScope?: 'aggregate'
  dailyAggregateMembers?: number
  placeholder?: boolean
}

export interface FtwFlowReadings {
  load?: number
  planets?: FtwFlowPlanet[]
  selfPoweredPctToday?: number | null
}

export interface FtwEnergyFlowElement extends HTMLElement {
  setReadings(readings: FtwFlowReadings): void
}
