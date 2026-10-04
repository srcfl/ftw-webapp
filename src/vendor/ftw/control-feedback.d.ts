/* Types for the vendored control-status words — the surface the app uses.
 * The implementation is the box's own file, untouched; see the header there.
 */

export type ControlStatusName = 'following' | 'waiting' | 'limited' | 'not_following' | 'no_contact' | 'not_controlled'
export type ControlSeverity = 'info' | 'warning' | 'alarm'
export type ControlEvidence = 'none' | 'accepted' | 'measured' | 'confirmed'

export interface ControlSiteEvidence {
  grid_before_w?: number
  grid_after_w?: number
  device_change_w?: number | null
  grid_change_w?: number | null
  other_change_w?: number | null
  adjusted_site_change_w?: number | null
  unexplained_change_w?: number | null
  tolerance_w?: number
  samples?: number
  window_s?: number
  max_skew_ms?: number | null
  unmeasured_flows?: string[]
  trace?: { at_ms: number; device_change_w: number; adjusted_site_change_w: number }[]
}

/** One device function's answer, as Core sends it. */
export interface ControlFeedback {
  driver: string
  kind: string
  mode?: string
  status: ControlStatusName
  reason: string
  severity: ControlSeverity
  evidence: ControlEvidence
  readings_fresh?: boolean
  confirmed_at_ms?: number
  site_confirmation?: string
  site_meter?: string
  site_evidence?: ControlSiteEvidence | null
  tolerance_w?: number | null
  requested_w?: number | null
  sent_w?: number | null
  readback_w?: number | null
  actual_w?: number | null
  battery_soc?: number | null
  charge_resume_soc?: number | null
  requested_a?: number | null
  offered_a?: number | null
  device_limit_a?: number | null
  device_reason?: string
  since_ms?: number
  command_at_ms?: number
  observed_at_ms?: number
}

export type ControlTone = 'ok' | 'neutral' | 'warning' | 'alarm' | 'stale'
export interface ControlMark { tone: 'warning' | 'alarm'; label: string }
export interface ControlScope { role?: string; name?: string | null; id?: string }

export function controlRows(value: unknown): ControlFeedback[]
export function controlPower(watts: unknown): string
export function controlFlow(row: ControlFeedback, watts: unknown): string
export function controlStatus(row: ControlFeedback, live?: boolean): { title: string; text: string; proof: string; next: string; tone: ControlTone }
export function controlReceipt(row: ControlFeedback, live?: boolean): { step: string; value: string; state: 'done' | 'wait' | 'fail' | 'none' }[]
export function controlNumbers(row: ControlFeedback, live?: boolean): [string, string][]
export function controlCurve(row: ControlFeedback, live?: boolean): { device: string; site: string; label: string; scale: string; duration: string } | null
export function controlForPlanet(value: unknown, planet?: ControlScope): ControlFeedback[]
export function controlSummary(value: unknown, live?: boolean): { title: string; tone: ControlTone }
export function withControlMarks<T>(planets: T[], value: unknown, live?: boolean): (T & { controlMark?: ControlMark; placeholder?: boolean; clickable?: boolean })[]
