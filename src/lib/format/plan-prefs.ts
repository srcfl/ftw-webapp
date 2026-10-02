/* Household planner prefs, in the box's own words.
 *
 * safety_k is the slider. forecast_trust is the enum an older box still
 * answers with. mapped_mode is the box's mapping of battery_export onto a
 * planner mode — this file never derives one from the other.
 */

export const SAFETY_K_MIN = 0
export const SAFETY_K_MAX = 2
export const SAFETY_K_STEP = 0.05

/** What "Use the plan" sends when the prefs read fails or names nothing usable. */
export const PLANNER_FALLBACK_MODE = 'planner_passive_arbitrage'

export type BatteryExport = 'unknown' | 'not_allowed' | 'allowed'
export type ForecastTrust = 'cautious' | 'balanced' | 'bold'

export interface PlannerPrefsWire {
  forecast_trust?: unknown
  battery_export?: unknown
  safety_k?: unknown
  mapped_k?: unknown
  mapped_mode?: unknown
}

export interface PlannerPrefs {
  forecastTrust: ForecastTrust
  batteryExport: BatteryExport
  safetyK: number
  /** The box's mapped_mode, or the passive fallback when the field is unusable. */
  mappedMode: string
}

const SALE_W = 100

export function clampSafetyK(v: number): number {
  if (!Number.isFinite(v)) return 1
  if (v < SAFETY_K_MIN) return SAFETY_K_MIN
  if (v > SAFETY_K_MAX) return SAFETY_K_MAX
  return v
}

/** The slider's own resolution, without trailing zeros. */
export function formatSafetyK(k: number): string {
  return String(Math.round(clampSafetyK(k) * 100) / 100)
}

export function trustFromSafetyK(k: number): ForecastTrust {
  const n = clampSafetyK(k)
  if (n <= 0.25) return 'bold'
  if (n < 1.5) return 'balanced'
  return 'cautious'
}

function safetyKFromTrust(trust: ForecastTrust): number {
  if (trust === 'cautious') return 2
  if (trust === 'bold') return 0
  return 1
}

function asTrust(v: unknown): ForecastTrust {
  return v === 'cautious' || v === 'balanced' || v === 'bold' ? v : 'balanced'
}

function asExport(v: unknown): BatteryExport {
  return v === 'allowed' || v === 'not_allowed' || v === 'unknown' ? v : 'unknown'
}

/**
 * The planner mode "Use the plan" will ask for.
 *
 * A string that starts with `planner_` is the box's answer. Anything else —
 * a failed read, a missing field — is the mode that never sells from the battery.
 */
export function mappedPlannerMode(wire: { mapped_mode?: unknown } | null | undefined): string {
  const mapped = wire?.mapped_mode
  return typeof mapped === 'string' && mapped.startsWith('planner_') ? mapped : PLANNER_FALLBACK_MODE
}

function finiteK(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? v : null
}

export function prefsFromWire(wire: PlannerPrefsWire | null | undefined): PlannerPrefs {
  const trust = asTrust(wire?.forecast_trust)
  const safetyK = clampSafetyK(
    finiteK(wire?.safety_k) ?? finiteK(wire?.mapped_k) ?? safetyKFromTrust(trust)
  )
  return {
    forecastTrust: trustFromSafetyK(safetyK),
    batteryExport: asExport(wire?.battery_export),
    safetyK,
    mappedMode: mappedPlannerMode(wire),
  }
}

/** What the dashboard shows under the manual drawer for a mode the plan is not running. */
const MANUAL_HINT: Record<string, string> = {
  self_consumption:
    'Self (manual). Simple grid-zero controller with no planner; charges surplus and discharges to cover local import.',
  peak_shaving: 'Manual peak shaving. Limits grid import to the peak-limit setting.',
  charge: 'Manual full charge — forces the battery to charge regardless of price.',
  idle:
    "Stop batteries. Every battery is held at 0 W while this mode is on, so none drifts back to the inverter's own behaviour. Fuse protection still applies. EV charging and PV curtailment carry on.",
}

/** Empty while a planner mode is driving. The slider is the explanation then. */
export function strategyHint(mode: string | null | undefined): string {
  if (!mode || mode.startsWith('planner_')) return ''
  return MANUAL_HINT[mode] ?? ''
}

export function hedgeLine(k: number): string {
  return clampSafetyK(k) === 0
    ? 'No forecast margin requested.'
    : 'The forecast margin varies by interval. This box has not supplied separate forecast and planning values.'
}

export interface SaleSlot {
  startMs: number
  durationMs: number
  batteryW: number
  gridW: number
}

function isBatterySale(slot: SaleSlot): boolean {
  return slot.batteryW < -SALE_W && slot.gridW < -SALE_W
}

function isGridExport(slot: SaleSlot): boolean {
  return slot.gridW < -SALE_W
}

function clock(ms: number): string {
  const d = new Date(ms)
  return String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0')
}

export function exportSentence(
  slots: readonly SaleSlot[],
  exportPermission: BatteryExport,
  nowMs: number
): string {
  const sale = slots.filter(isBatterySale)
  if (sale.length > 0) {
    const upcoming = sale.filter((s) => s.startMs + s.durationMs > nowMs)
    const block = upcoming.length > 0 ? upcoming : sale
    let last = block[0]!
    for (let i = 1; i < block.length; i++) {
      const expected = last.startMs + last.durationMs
      const next = block[i]!
      if (Math.abs(next.startMs - expected) > 1000) break
      last = next
    }
    const end = last.startMs + last.durationMs
    return 'Battery sale planned ' + clock(block[0]!.startMs) + '–' + clock(end) + '.'
  }
  if (slots.some(isGridExport)) return 'Solar export only; the battery is not selling.'
  if (exportPermission === 'allowed') {
    return 'Battery export is allowed, but FTW found no worthwhile sale.'
  }
  return 'Battery sale blocked: permission is off or not checked.'
}
