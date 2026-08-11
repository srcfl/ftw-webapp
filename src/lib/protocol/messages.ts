/* The message types.
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
  /**
   * Start telemetry with the handshake when the box supports it.
   *
   * Optional in both directions: an older box ignores this and the app sends
   * the ordinary `sub` after `hello_ok`.
   */
  sub?: Sub
}

/**
 * What an enrolment is allowed to do, from `roles` in contract/registry.yaml.
 *
 * A plain string rather than a union, for the reason SiteMode is: the box
 * decides what roles exist, and an app that accepted only the two it was built
 * with would refuse to draw for a role a newer box shipped. Anything this app
 * does not recognise is treated as the narrower of the two it does.
 */
export type Role = string

export const ROLE_OWNER: Role = 'owner'
export const ROLE_VIEWER: Role = 'viewer'

export interface HelloOk {
  /** Negotiated version. PROTO_FLOOR means the app is too old for full mode. */
  proto: number
  mode: BoxMode
  box: { id: string; build: string; tz: string }
  clock: BoxClock
  /**
   * What this enrolment is allowed to do.
   *
   * Used to decide what to DRAW and for nothing else. Hiding a button is
   * presentation; if the app is wrong and shows one, the box refuses the
   * request behind it. Absent means a box from before roles existed, and that
   * box treats every enrolled phone as an owner — so the app does too, or a
   * household would watch its own controls disappear after a box update.
   */
  role?: Role
  /**
   * That role expanded, as the box expanded it.
   *
   * Sent beside the role, and the redundancy is the box's own point: the role
   * is what a sentence can name — "you have view-only access" — and this is
   * what a control is checked against, so the app never has to expand a role
   * through a table of its own. It held one and used it anyway for a release,
   * which meant the app decided what a grant contained and the box decided
   * something else.
   *
   * Absent from a box that predates roles, and the honest reading of that is
   * the same as an absent role: it lets every paired phone do everything.
   */
  scopes?: string[]
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
  /** The box accepted `hello.sub`; a snapshot follows without another ask. */
  subscribed?: true
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
// Prices
// --------------------------------------------------------------------------

/**
 * The window of prices to ask for.
 *
 * Wall clock, not box uptime. Prices are about hours a person plans around,
 * and every other age in this protocol is measured against uptime precisely
 * because it is about the box rather than about the day.
 */
export interface PriceQuery {
  fromMs: number
  toMs: number
}

/**
 * One settlement slot's price, in minor units per kWh.
 *
 * Integers — öre, cents — because a price is money, and money in a float is a
 * rounding argument waiting to happen. `spotMinor` is the raw market price;
 * `totalMinor` is what the household actually pays, tariff and tax included.
 * The box computes the total because the box holds the configuration.
 */
export interface PriceSlot {
  startMs: number
  /** Slot length. An hour or a quarter of one, depending on the market.  */
  durationMs: number
  spotMinor: number
  totalMinor: number
}

export interface Prices {
  /** Bidding zone, and what the minor units are. Without them 45 is a guess. */
  zone: string
  currency: string
  slots: PriceSlot[]
  /**
   * The answer does not cover the window asked for.
   *
   * Three shapes, not one: it begins after the start, it has a hole in the
   * middle, or it stops short of the end. Tomorrow's rates publish in the
   * afternoon, so a window asked for at breakfast genuinely ends early; one
   * failed midday fetch on the box leaves a day holding 00:00-06:00 and
   * 12:00-24:00; a box that first heard from the market at breakfast holds
   * 06:00-24:00 of a day the app asked for from midnight. Saying so beats
   * drawing a cliff the market did not have.
   *
   * Which shape it is has to be read off `slots` — see `hasHole` in
   * `$lib/state/price`, which covers the first two. A day missing its own
   * morning is not a day waiting for tomorrow, and the flag cannot tell them
   * apart.
   */
  stale: boolean
}

// --------------------------------------------------------------------------
// The box's own HTTP API, carried inside this session
// --------------------------------------------------------------------------

/**
 * A request against the box's own API.
 *
 * The box serves 132 routes on the home LAN today with no authentication
 * at all. Reaching the same handlers through a Noise session pinned to an
 * enrolled device is strictly stronger than that, which is why this exists:
 * a view over a route the box already serves stops needing a new message type
 * and a box release. A route the box has never priced still needs both — it
 * defaults closed, which is the wrong-safe direction and still a cost.
 *
 * Bulk lane, never lane 0. Every field here varies in length with what was
 * asked, and lane 0's fixed size is a privacy control rather than a budget.
 *
 * THERE IS NO HEADERS FIELD, and adding one would be a mistake rather than a
 * feature. The caller's identity rides on the request context inside the box
 * process, put there by the session that already authenticated it. With no
 * headers there is no path at all by which a byte this app sends becomes a
 * claim about who is asking; a headers field opens exactly that hole.
 */
export interface ApiReq {
  method: ApiMethod
  /**
   * Must start `/api/`, with no `..`, no `//`, no `?` and no `#`.
   *
   * Only `/api/`: the box's static handler stays unreachable, because serving
   * HTML through this session would make the box a second origin under
   * another name — which docs/architecture.md rejects outright.
   */
  path: string
  /**
   * Parsed, never a raw string.
   *
   * Two reasons, and the first is the serious one: the box decides what a
   * request is allowed to do from its path, and a path decided over a string
   * that can still carry a `?` is a parser bug that becomes a privilege bug.
   * The second is that the app then never has to think about encoding — the
   * box rebuilds the URL itself.
   */
  query?: Record<string, string>
  /** Opaque. The box sets `Content-Type: application/json` when present. */
  body?: Uint8Array | null
  /** The app's ceiling. The box clamps it to its own; see `ApiEnd.bytes`. */
  maxBytes?: number
  /**
   * This request carried a fresh passkey ceremony.
   *
   * Honest about what it buys. The box cannot verify that a ceremony
   * happened — it has no relationship with the authenticator and is
   * deliberately never a WebAuthn relying party, because that would need an
   * origin and the box is never an origin. What this stops is a phone left
   * unlocked on a table being picked up and used to reconfigure the site,
   * because this app will not send `true` without prompting. It stops nothing
   * at all against a modified client, which could already send a command
   * today. The box's own contribution is the part only the box can do: count
   * these, rate-limit them, and write each one to the household's event log.
   */
  stepUp?: boolean
}

export type ApiMethod = 'GET' | 'HEAD' | 'POST' | 'PUT' | 'PATCH' | 'DELETE'

/**
 * The box's HTTP layer answered, and `status` is that answer.
 *
 * This is the whole rule for telling the two kinds of failure apart, and it
 * needs no inspection of any body: if `api.head` arrived, a handler ran and a
 * 403 or a 500 is the handler's, not the passthrough's. If `error` arrived on
 * the same request id, the passthrough refused and no handler ran. They are
 * different message types, so the app branches on type and never on content.
 */
export interface ApiHead {
  status: number
  headers: Record<string, string>
  /** Content-Length when the box knows it, null when the answer streams. */
  len: number | null
}

export interface ApiChunk {
  seq: number
  data: Uint8Array
}

export interface ApiEnd {
  bytes: number
  /**
   * The answer was cut off, either by the ceiling or by the box's own
   * deadline after the status had already gone out.
   *
   * A truncated answer is a failure to this app, never a short one to parse.
   */
  truncated: boolean
}

/**
 * Bytes per `api.chunk`.
 *
 * A fixed number rather than one found by trial. The largest bulk bucket is
 * 16384 with six bytes of frame header plus the CBOR envelope, so 12 KiB
 * always lands in that bucket and the box never discovers an overrun
 * mid-stream.
 */
export const API_CHUNK_BYTES = 12288

/**
 * The most one answer may carry, matching the box's own APIMaxBytes.
 *
 * The app sends its own ceiling and learns the real figure from `api.end`,
 * because the box's is the one that counts.
 */
export const API_MAX_BYTES = 8 * 1024 * 1024

/**
 * What the passthrough will carry: JSON and text, and nothing else.
 *
 * Refused by class rather than by a list of paths, so a route added next year
 * that streams a ZIP meets this without anyone remembering to add it. A PWA
 * inside a Noise session has nothing useful to do with an archive, and
 * carrying one would be promising more than the code delivers.
 *
 * It is the box's last word on an answer, not its first: a route the box
 * prices `local` — `/api/support/dump` is one — is refused before its handler
 * runs and never reaches this at all.
 */
export function carriesOverSession(contentType: string | undefined): boolean {
  if (!contentType) return false
  const media = contentType.split(';')[0]!.trim().toLowerCase()
  return (
    media === 'application/json' ||
    media.startsWith('text/') ||
    (media.startsWith('application/') && media.endsWith('+json'))
  )
}

// --------------------------------------------------------------------------
// Commands
// --------------------------------------------------------------------------

/**
 * Operations the app can ask for, from contract/registry.yaml `ops` — the
 * scope each demands lives there too, and tests/registry-contract.test.ts
 * reads both back.
 */
export const OP_SET_MODE = 'site.mode.set'
export const OP_BATTERY_HOLD = 'battery.hold'
export const OP_LOADPOINT_HOLD = 'loadpoint.hold'
export const OP_LOADPOINT_BOOST = 'loadpoint.boost'

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

/**
 * Whether a code is worth retrying, from contract/registry.yaml.
 *
 * Here rather than at each throw site: the app reads this flag to decide
 * whether to offer a retry at all, and a hand-written value drifts from the
 * registry without anything noticing. The cross-check against the Go box
 * caught exactly that — the simulator was sending false for E_UNAVAILABLE
 * while the registry and the box both said true.
 */
const RETRYABLE: Record<string, boolean> = {
  E_BOOTING: true,
  E_UNKNOWN_OP: false,
  E_CMD_EXPIRED: false,
  E_PRECONDITION: false,
  E_CONFLICT: true,
  E_SCOPE_DENIED: false,
  E_GRANT_REVOKED: false,
  E_LAST_OWNER_PROTECTED: false,
  E_RANGE_TOO_LARGE: false,
  E_UNAVAILABLE: true,
  // Retryable, because the identical request goes through the second time.
  // The box refuses on the absence of the stepUp flag alone and nothing else
  // about the request changes, which is why box-api.ts can run the ceremony
  // and send the same call again by itself.
  E_NEEDS_STEP_UP: true,
  E_USE_CMD: false,
  E_UNSUPPORTED_MEDIA: false,
  // Both are the box's answer about the route, and asking again gets the same
  // answer. E_LOCAL_ONLY is not a permission the owner is missing either, so
  // no role and no ceremony changes it.
  E_WHOLE_DOCUMENT: false,
  E_LOCAL_ONLY: false,
  // Not from the box. The session layer raises this one itself out of
  // api.end{truncated: true} — see contract/registry.yaml, client_errors.
  E_RESPONSE_TOO_LARGE: false,
  // Also the app's own, from the same block. No ack means the box never took
  // the intent, so trying again cannot act twice. No answer means the wire
  // went away — the session reconnects on its own and the same ask can go
  // again. A bad body is the box and the app disagreeing about a route, and
  // asking again gets the same answer.
  E_NO_ACK: true,
  E_NO_ANSWER: true,
  E_BAD_BODY: false,
}

/** Unknown codes are not retryable: guessing yes offers a button that cannot help. */
export function isRetryable(code: string): boolean {
  return RETRYABLE[code] ?? false
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
  | { t: 'price'; id: number; b: Prices }
  | { t: 'api.head'; id: number; b: ApiHead }
  | { t: 'api.chunk'; id: number; b: ApiChunk }
  | { t: 'api.end'; id: number; b: ApiEnd }
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
  | { t: 'price.get'; id: number; b: PriceQuery }
  | { t: 'api.req'; id: number; b: ApiReq }
  | { t: 'cmd'; b: Cmd }
