/* The fifteen message types.
 *
 * Shapes only. Names shared with the box — capabilities, scopes, error codes,
 * field ids — come from contract/registry.yaml.
 *
 * Every age in this protocol is measured against the box's uptime, never its
 * wall clock. A Pi has no RTC: after a power cut it reads 1970 until NTP
 * answers, which would make every freshness claim wrong by decades. See
 * docs/protocol.md.
 */

import type { Fid, SourceState, BoxClock } from './types'

export const PROTO_MIN = 0
export const PROTO_MAX = 1

/** Degraded mode. The box speaks only the frozen subset; the app still draws. */
export const PROTO_FLOOR = 0

export type BoxMode = 'full' | 'floor' | 'booting' | 'readonly'

// --------------------------------------------------------------------------
// Handshake
// --------------------------------------------------------------------------

export interface Hello {
  /** A range, never an equality demand — that is what avoids a version wall. */
  proto: { min: number; max: number }
  app: { build: string; ua: 'pwa' }
  locales: string[]
}

export interface HelloOk {
  /** Negotiated version. PROTO_FLOOR means the app is too old for full mode. */
  proto: number
  mode: BoxMode
  box: { id: string; build: string; tz: string }
  clock: BoxClock
  /** Presence, not levels. Absent means hide the feature; never crash. */
  caps: string[]
  capsHash: string
  /**
   * Every mode this box will accept, in its own presentation order.
   *
   * Sent once per session rather than named in every delta: field 1 carries
   * an index into this list, which keeps lane 0 numeric and its frames a
   * fixed size. The list is the box's to decide — the app renders what it is
   * given rather than what it was compiled with.
   */
  modes: ModeInfo[]
  /** Present while starting. A VACUUM can take a long time; say so. */
  boot?: { phase: 'vacuum' | 'migrate' | 'drivers'; pct: number; etaMs: number | null }
  hint?: 'app_update'
}

// --------------------------------------------------------------------------
// Telemetry
// --------------------------------------------------------------------------

export interface Sub {
  /** Bucket size for lane 0, fixed for the session. */
  bucket: 256 | 512
  /** Frames per second. Dropped when the document is hidden. */
  hz: 1 | 0.2
}

export interface SourceWire {
  kind: string
  name: string
  lastOkMs: number
  staleAfterMs: number
  state: SourceState
}

export interface Snap {
  uptimeMs: number
  /** Monotonic per site. Bumped by every mutation of controllable state. */
  controlRev: number
  /** fid -> {name, unit, srcId}. Cached by the client across sessions. */
  dict: Record<string, { name: string; unit: string | null; srcId: string | null }>
  fields: Record<string, number>
  sources: Record<string, SourceWire>
  /** Source ids currently stopping dispatch, per the box's safety rules. */
  dispatchBlockedBy: string[]
}

export interface DeltaMsg {
  seq: number
  uptimeMs: number
  fields: Record<string, number>
  /**
   * Usually absent — source state changes rarely. But when a device goes
   * quiet mid-session this is the only way the client hears about it, so
   * "rarely" must never become "only in the snapshot".
   */
  sources?: Record<string, SourceWire>
  /** Sent with `sources`, since the two always move together. */
  dispatchBlockedBy?: string[]
}

/**
 * Nothing changed.
 *
 * Sent anyway, on the same cadence and in the same bucket. Silence would be
 * information: it would tell the relay operator that nothing happened in the
 * house at that second.
 */
export interface Tick {
  seq: number
  uptimeMs: number
}

// --------------------------------------------------------------------------
// History
// --------------------------------------------------------------------------

export type Resolution = '5m' | '1h'

export interface HistQuery {
  series: string[]
  res: Resolution
  fromMs: number
  toMs: number
  /** Tiles already cached, so the box sends only the difference. */
  have?: { tileId: string; etag: string }[]
  maxPoints?: number
}

export interface HistChunk {
  tileId: string
  etag: string
  res: Resolution
  startMs: number
  stepMs: number
  series: string[]
  /** Column-packed int32 LE, one block per series. INT32_MIN means missing. */
  data: Uint8Array
  /** The trailing tile is still filling; never cache it. */
  partial: boolean
}

export interface HistEnd {
  /** What the box actually served, which may be coarser than requested. */
  resActual: Resolution
  /** Ranges with no data, and why — so the UI can say rather than guess. */
  gaps: { fromMs: number; toMs: number; reason: 'no_data' | 'evicted' | 'box_down' }[]
}

/** Distinct from zero, which is a real reading. */
export const MISSING_SAMPLE = -2147483648

// --------------------------------------------------------------------------
// The plan
// --------------------------------------------------------------------------

/**
 * A dispatch mode key.
 *
 * FTW's, from control.AllModes(). A plain string rather than a union: the box
 * decides what modes exist, and an app that only accepts the ten it was built
 * with would hide a strategy a newer box shipped. See contract/registry.yaml.
 */
export type SiteMode = string

/** Where a mode belongs in the UI. Placement, not permission. */
export type ModeTier = 'primary' | 'advanced' | 'hidden'

/**
 * One mode as the box presents it.
 *
 * `label` and `tooltip` are the box's own English. The app translates the
 * keys it knows and falls back to these for the ones it does not, so a new
 * mode is usable immediately and merely untranslated — which is a much better
 * failure than absent.
 */
export interface ModeInfo {
  key: SiteMode
  label: string
  tooltip: string
  tier: ModeTier
}

/**
 * What the box intends to do, slot by slot.
 *
 * Intent, not prophecy. The box revalidates against fresh state every tick,
 * so a plan is what it currently means to do — which is exactly the thing a
 * person opens the app to check, and the thing that makes the app feel like
 * it knows something rather than just drawing lines.
 */
export interface PlanSlot {
  startMs: number
  /** Slot length. Fifteen minutes on the box today, but do not assume it. */
  durationMs: number
  /** Signed watts at the battery, FTW's convention: positive charges. */
  batteryW: number
  /** Expected import at the meter. Negative means expected export. */
  gridW: number
  /** Import price for the slot, in minor units per kWh. Null when unknown. */
  priceMinor: number | null
  /**
   * Why this slot looks like this.
   *
   * A stable code, never prose — the box has no idea what language anyone
   * reads. The app owns every word the user sees.
   */
  reason: PlanReason
}

export type PlanReason =
  | 'cheap_import'
  | 'expensive_import'
  | 'solar_surplus'
  | 'peak_shaving'
  | 'reserve_held'
  | 'export_paid'
  | 'idle'

export interface Plan {
  /** Bumped whenever the box replans. */
  rev: number
  /** Box uptime when this plan was made. */
  uptimeMs: number
  /** Wall clock for the slots, since these are future times a user reads. */
  slots: PlanSlot[]
  /**
   * Set when the planner could not run and the box fell back.
   *
   * Saying so is the difference between "nothing is scheduled" and "we do not
   * know what is scheduled", and only one of those is honest.
   */
  stale: boolean
  /** Import ceiling being defended, in watts. Null when there is none. */
  ceilingW: number | null
}

// --------------------------------------------------------------------------
// Commands
// --------------------------------------------------------------------------

/** Operations the app can ask for. Each maps to a scope in the registry. */
export const OP_SET_MODE = 'site.mode.set'
export const OP_BATTERY_HOLD = 'battery.hold'

export interface Guard {
  fid: Fid
  op: 'lt' | 'lte' | 'gt' | 'gte'
  value: number
}

export interface Cmd {
  /** UUIDv7. The box keeps it 24 h so a retry cannot act twice. */
  cmdId: string
  op: string
  args: Record<string, unknown>
  /**
   * Mandatory. A command queued offline must never execute blindly later —
   * "charge at 10 kW" arriving three hours late is a different instruction
   * than the one the user gave.
   */
  notValidAfterMs: number
  expect: { rev: number; guards: Guard[] }
}

export interface CmdAck {
  cmdId: string
  /** The dispatcher accepted the intent. Not proof the hardware moved. */
  leaseId: string
  expiresAtMs: number
}

export interface CmdResult {
  cmdId: string
  state: 'applied' | 'rejected' | 'expired' | 'superseded' | 'unconfirmed'
  /** Present when the driver read the value back. This is the real proof. */
  observed?: { value: number; src: string; uptimeMs: number }
  error?: { code: string; args?: Record<string, unknown> }
}

/** Milliseconds. Three different events, not three versions of one. */
export const CMD_SENDING_MS = 1_200
export const CMD_ACK_TIMEOUT_MS = 5_000
export const CMD_CONFIRM_TIMEOUT_MS = 15_000

// --------------------------------------------------------------------------
// Events, errors, teardown
// --------------------------------------------------------------------------

export interface EventMsg {
  eventId: string
  kind: string
  severity: 'info' | 'warn' | 'alarm'
  uptimeMs: number
  args?: Record<string, unknown>
}

export interface ErrorMsg {
  code: string
  retryable: boolean
  retryAfterMs?: number
  /** Machine-readable. The box sends codes; this app owns every word of prose. */
  args?: Record<string, unknown>
}

export interface SessionTerminate {
  reason: 'revoked' | 'epoch_changed' | 'box_shutdown' | 'superseded'
}

// --------------------------------------------------------------------------

export type ServerMessage =
  | { t: 'hello_ok'; b: HelloOk }
  | { t: 'snap'; b: Snap }
  | { t: 'plan'; b: Plan }
  | { t: 'delta'; b: DeltaMsg }
  | { t: 'tick'; b: Tick }
  | { t: 'hist.chunk'; id: number; b: HistChunk }
  | { t: 'hist.end'; id: number; b: HistEnd }
  | { t: 'cmd.ack'; b: CmdAck }
  | { t: 'cmd.result'; b: CmdResult }
  | { t: 'event'; b: EventMsg }
  | { t: 'error'; id?: number; b: ErrorMsg }
  | { t: 'session.terminate'; b: SessionTerminate }

export type ClientMessage =
  | { t: 'hello'; b: Hello }
  | { t: 'sub'; b: Sub }
  | { t: 'plan.get'; id: number }
  | { t: 'hist.query'; id: number; b: HistQuery }
  | { t: 'cmd'; b: Cmd }
