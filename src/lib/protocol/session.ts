/* The session — handshake, subscription, and the field register.
 *
 * Owns exactly one carrier at a time and turns frames into state. Everything
 * above this reads state; nothing above it touches a frame.
 *
 * Freshness is deliberately two facts, never one:
 *   carrier  — how frames are reaching us
 *   sources  — whether the box's own devices are answering
 * Collapsing them cannot express "connected, but the inverter went quiet 40
 * seconds ago", which is the case users most need to see.
 */

import {
  encodeFrame,
  decodeFrame,
  isTruncated,
  wireBytes,
  LANE_CONTROL,
  LANE_BULK,
  BULK_BUCKETS,
  FrameError,
} from './frame'
import {
  PROTO_MIN,
  PROTO_MAX,
  PROTO_FLOOR,
  type HelloOk,
  type Snap,
  type DeltaMsg,
  type Tick,
  type ErrorMsg,
  type SessionTerminate,
  type Sub,
  type BoxMode,
  type HistQuery,
  type HistChunk,
  type HistEnd,
  type Plan,
  type PriceQuery,
  type Prices,
  type ModeInfo,
  type Guard,
  type CmdAck,
  type CmdResult,
  type ApiReq,
  type ApiHead,
  type ApiChunk,
  type ApiEnd,
  type Role,
  ROLE_OWNER,
  API_MAX_BYTES,
  CMD_ACK_TIMEOUT_MS,
  CMD_CONFIRM_TIMEOUT_MS,
} from './messages'
import { ROLE_SCOPES } from './contract'
import type { Carrier } from '$lib/carrier/carrier'
import type { CarrierState, Fid, Source, SourceState } from './types'
import { linkCounters, markLinkPhase } from '$lib/perf/link'

export type SessionPhase =
  | 'idle'
  | 'handshaking'
  | 'subscribing'
  | 'streaming'
  | 'booting'
  | 'terminated'
  | 'failed'

export interface SessionState {
  phase: SessionPhase
  carrier: CarrierState
  /** Negotiated protocol. PROTO_FLOOR means this app is too old for full mode. */
  proto: number
  mode: BoxMode
  caps: ReadonlySet<string>
  /**
   * What this enrolment may do, as the box named it at handshake.
   *
   * Read only to decide what to draw. A box from before roles existed sends
   * nothing and treats every paired phone as an owner, so that is what absent
   * means here too — anything else would take a household's own controls away
   * on the morning it updated its box.
   *
   * Absent from the handshake and absent BEFORE the handshake are two
   * different facts. See `heardFromBox`.
   */
  role: Role
  /**
   * That role expanded, as the box expanded it.
   *
   * What a control is checked against, where `role` is what a sentence names.
   * The box sends both and says why: an app that expands the role itself is
   * an app deciding what its own grant contains, and the box decides that.
   * This one did expand it, out of the registry table it ships with, so a box
   * whose table had moved on was overruled by a copy of an older one.
   *
   * A box that sends none is one from before roles existed. Its silence means
   * the same as an absent role — every paired phone may do everything — so
   * the role's own expansion stands in, and `heardFromBox` is what says
   * whether even that has been heard.
   */
  scopes: ReadonlySet<string>
  /**
   * Whether the box has answered a hello since this app was opened.
   *
   * `role`, `caps` and `modes` are only claims about the box once it has.
   * Before that they are this app's opening assumptions — every paired phone
   * is an owner, no capability is known — and a screen that states something
   * about the box from them is inventing it. One screen did: it read the empty
   * capability set as a box too old to share, on every cold start, about a box
   * that had said nothing at all.
   *
   * The phase cannot stand in for this. `failed` before a first hello and
   * `failed` after one are the same phase and opposite facts, which is the
   * same reason freshness needs two fields rather than one.
   */
  heardFromBox: boolean
  box: HelloOk['box'] | null
  /** Box uptime at the last frame. All ages are deltas against this. */
  uptimeMs: number
  controlRev: number
  fields: ReadonlyMap<Fid, number>
  dict: Snap['dict']
  sources: ReadonlyMap<string, Source>
  dispatchBlockedBy: readonly string[]
  boot: HelloOk['boot'] | null
  lastError: ErrorMsg | null
  terminated: SessionTerminate | null
  /** Set when the box says this app is too old. */
  needsUpdate: boolean
  /** What the box intends to do. Null until asked for, or when unsupported. */
  plan: Plan | null
  /**
   * The last delta could not carry every changed field.
   *
   * Not a fault: dropped fields stay dirty and arrive next tick. Surfaced so
   * nothing has to guess whether a reading it is looking at is current.
   */
  truncated: boolean
  /**
   * Every mode this box accepts, in its own order.
   *
   * The box decides what exists; the app renders what it is given. Field 1
   * carries an index into this list.
   */
  modes: ModeInfo[]
}

const EMPTY: SessionState = {
  phase: 'idle',
  carrier: 'none',
  proto: PROTO_MAX,
  mode: 'full',
  caps: new Set(),
  role: ROLE_OWNER,
  scopes: new Set(ROLE_SCOPES[ROLE_OWNER] ?? []),
  heardFromBox: false,
  box: null,
  uptimeMs: 0,
  controlRev: 0,
  fields: new Map(),
  dict: {},
  sources: new Map(),
  dispatchBlockedBy: [],
  boot: null,
  lastError: null,
  terminated: null,
  needsUpdate: false,
  plan: null,
  modes: [],
  truncated: false,
}

export interface SessionOptions {
  build: string
  locales?: string[]
  sub?: Sub
}

/**
 * How long a history request waits before giving up.
 *
 * Generous, because a two-year window is dozens of bulk frames over a relay.
 * The point is not to be quick about failing — it is that the promise always
 * settles, so a view can never be left waiting on a reply that was lost.
 */
export const HIST_TIMEOUT_MS = 20_000

interface PendingHistory {
  onChunk: (chunk: HistChunk) => void
  resolve: (end: HistEnd) => void
  reject: (err: Error) => void
  /** Unset only before the request is on the wire. See #armDeadline. */
  timer?: ReturnType<typeof setTimeout>
}

/**
 * How long a call to the box's own API waits before giving up.
 *
 * History's deadline, for history's reason: a four-megabyte answer is around
 * 340 chunks, which is a real amount of time over a relay. Being quick about
 * failing is not the point — the point is that the promise always settles.
 */
export const API_TIMEOUT_MS = 20_000

interface PendingApi {
  resolve: (res: ApiResponse) => void
  reject: (err: Error) => void
  /** Unset only before the request is on the wire. See #armDeadline. */
  timer?: ReturnType<typeof setTimeout>
  head: ApiHead | null
  chunks: Uint8Array[]
  bytes: number
  /** Next chunk expected. A gap means frames were lost and the body is a lie. */
  nextSeq: number
}

/** A plan is one bulk message, so this can be much tighter than history. */
export const PLAN_TIMEOUT_MS = 8_000

interface PendingPlan {
  resolve: (plan: Plan) => void
  reject: (err: Error) => void
  /** Unset only before the request is on the wire. See #armDeadline. */
  timer?: ReturnType<typeof setTimeout>
}

/** A price window is one bulk message too, so it keeps the plan's deadline. */
export const PRICE_TIMEOUT_MS = 8_000

interface PendingPrices {
  resolve: (prices: Prices) => void
  reject: (err: Error) => void
  /** Unset only before the request is on the wire. See #armDeadline. */
  timer?: ReturnType<typeof setTimeout>
}

/**
 * How long to wait before asking a box that is still starting again.
 *
 * A box coming back from an update answers hello with mode 'booting' and
 * refuses a subscription until it is up. It does not announce being ready, and
 * the carrier stays open throughout, so no reconnect is coming to ask again —
 * without a timer of the session's own the app sits on the starting screen for
 * as long as it is open, and reloading is never the fix here.
 *
 * Five seconds. A VACUUM runs for minutes, so this is nowhere near a poll, and
 * it is close enough that the progress on the starting screen keeps moving.
 */
export const BOOT_RETRY_MS = 5_000

/**
 * How long an intent stays valid, in ms of box uptime.
 *
 * Two minutes. Long enough to survive a slow relay and a reconnection, short
 * enough that a command queued while the phone was in a tunnel is refused
 * rather than acted on as though the user had just pressed the button.
 */
export const CMD_VALID_FOR_MS = 120_000

interface PendingCmd {
  resolve: (result: CmdResult) => void
  reject: (err: Error) => void
  ackTimer: ReturnType<typeof setTimeout>
  confirmTimer: ReturnType<typeof setTimeout>
  acked: boolean
}

export interface CommandHandle {
  cmdId: string
  state: 'sending'
  promise: Promise<CmdResult>
}

/** Carries a sentence the user can act on, not a code they cannot. */
export class CommandError extends Error {
  constructor(
    readonly code: string,
    readonly help: string
  ) {
    super(code)
    this.name = 'CommandError'
  }
}

/**
 * UUIDv7: time-ordered, so the box can expire old idempotency keys by prefix
 * rather than keeping every id it has ever seen.
 */
function uuidv7(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(16))
  const ms = BigInt(Date.now())

  for (let i = 0; i < 6; i++) {
    bytes[i] = Number((ms >> BigInt(8 * (5 - i))) & 0xffn)
  }
  bytes[6] = (bytes[6]! & 0x0f) | 0x70 // version 7
  bytes[8] = (bytes[8]! & 0x3f) | 0x80 // variant

  const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('')
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`
}

/** Thrown when the box answers a plan request with a stable error code. */
export class PlanError extends Error {
  constructor(readonly detail: ErrorMsg) {
    super(detail.code)
    this.name = 'PlanError'
  }
}

/** Thrown when the box answers a history request with a stable error code. */
export class HistoryError extends Error {
  constructor(readonly detail: ErrorMsg) {
    super(detail.code)
    this.name = 'HistoryError'
  }
}

/** Thrown when the box answers a price request with a stable error code. */
export class PriceError extends Error {
  constructor(readonly detail: ErrorMsg) {
    super(detail.code)
    this.name = 'PriceError'
  }
}

/**
 * What the box's HTTP layer answered.
 *
 * A 404 or a 500 arrives here, not as a thrown error, because the handler ran
 * and this is what it said. What a status means is the caller's question —
 * a 404 from the members endpoint means something different than a 404 from
 * an energy window — and this layer has no business guessing.
 */
export interface ApiResponse {
  status: number
  headers: Record<string, string>
  body: Uint8Array
}

/**
 * The box refused, in a way that carries a stable code.
 *
 * Almost always because the passthrough refused before any handler ran — the
 * rule that tells that apart needs no body inspection: `api.head` arrived
 * means the HTTP layer answered and the status is the answer; `error` on the
 * same id means nothing ran. Both are message types, so this branches on type
 * and never on content.
 *
 * The one exception is `E_RESPONSE_TOO_LARGE`, which this layer raises itself
 * when an answer arrives cut off. A handler did run there, and the status was
 * real — but half a document is not an answer, and there is no honest way to
 * hand it up. Callers that need to know the difference have `status` on
 * `BoxApiError`, which is null exactly when no handler ran.
 */
export class ApiError extends Error {
  constructor(readonly detail: ErrorMsg) {
    super(detail.code)
    this.name = 'ApiError'
  }
}

export class Session {
  #state: SessionState = EMPTY
  #carrier: Carrier | null = null
  #unsub: (() => void)[] = []
  #opts: SessionOptions
  #listeners = new Set<(s: SessionState) => void>()
  #lastSeq = 0
  #bucket: 256 | 512 = 512
  /** The newest requested cadence, including changes while hello is in flight. */
  #subscription: Sub
  /** The subscription carried by the last hello, if any. */
  #helloSub: Sub | null = null
  #nextRequestId = 1
  #pendingHistory = new Map<number, PendingHistory>()
  #pendingPlan = new Map<number, PendingPlan>()
  #pendingPrices = new Map<number, PendingPrices>()
  #pendingApi = new Map<number, PendingApi>()
  #pendingCmd = new Map<string, PendingCmd>()
  /** The api queue's tail. Always settled-safe; see api(). */
  #apiTail: Promise<void> = Promise.resolve()
  /** Set only while the box says it is starting. See BOOT_RETRY_MS. */
  #bootRetry: ReturnType<typeof setTimeout> | undefined

  constructor(opts: SessionOptions) {
    this.#opts = opts
    this.#bucket = opts.sub?.bucket ?? 512
    this.#subscription = opts.sub ? { ...opts.sub } : { bucket: this.#bucket, hz: 1 }
  }

  get state(): SessionState {
    return this.#state
  }

  subscribe(listener: (s: SessionState) => void): () => void {
    this.#listeners.add(listener)
    listener(this.#state)
    return () => this.#listeners.delete(listener)
  }

  /**
   * Seed state from the local cache, before any carrier exists.
   *
   * The readings are real — they were true when captured, and the freshness
   * band says how long ago that was. Carrier stays 'cache', which is a
   * carrier and not a failure state: it is how the app has something honest
   * to show in its first frame.
   *
   * The cache read races the connect, and either may win. Landing while a
   * carrier is mid-handshake, the cache still paints — that is the cold-start
   * promise — but only the data: the phase, the carrier and the box's clock
   * belong to the connection already under way. Nothing writes the carrier
   * again on a connection that stays up, so a cache that overwrote it here
   * left "can't reach your box" standing over a live stream for as long as
   * the app was open.
   */
  restore(patch: Partial<SessionState>): void {
    const phase = this.#state.phase
    if (phase === 'streaming') return

    if (phase === 'handshaking' || phase === 'subscribing' || phase === 'booting') {
      // Fields already held mean a reconnect, and live readings are newer
      // than any snapshot on disk.
      if (this.#state.fields.size > 0) return
      const data = { ...patch }
      delete data.phase
      delete data.carrier
      delete data.uptimeMs
      this.#patch(data)
      return
    }

    this.#patch({ ...patch, phase: 'idle', carrier: 'cache' })
  }

  /** Attach a carrier and start the handshake. Replaces any current one. */
  connect(carrier: Carrier): void {
    this.#detach()
    markLinkPhase('connect-start')
    // The replacement starts out unopened. Keep the readings, but drop the
    // old transport claim now rather than leaving the session in `streaming`
    // until the new socket opens. Pull-to-refresh and any other in-place
    // reconnect must never show an old stream as live while the new carrier
    // is still dialling.
    this.#patch({ phase: 'idle', carrier: 'none' })
    this.#carrier = carrier

    this.#unsub.push(
      carrier.onFrame((bytes) => this.#onFrame(bytes)),
      carrier.onStatus((status) => {
        if (status.phase === 'open') {
          this.#patch({ phase: 'handshaking', carrier: carrier.kind })
          this.#sendHello()
        } else if (status.phase === 'closed') {
          // Losing the carrier does not clear the readings. They are still
          // true, just older — and the freshness band says so.
          this.#patch({ phase: 'failed', carrier: 'none' })
          // A box that cannot be reached is not one to ask how far along it
          // is. The reopen above sends a fresh hello anyway.
          clearTimeout(this.#bootRetry)
          // But it does end every request in flight. This is the ordinary way
          // a carrier goes away — the wire drops and the carrier reconnects
          // inside itself, keeping its handlers — so it never reaches
          // #detach. Settling has to happen here or a view waits out the
          // request's own deadline against a reply that cannot arrive.
          // #detach is deliberately not called: it closes the carrier and
          // drops the handlers, and the carrier has to stay attached to come
          // back.
          this.#settlePending()
        }
      })
    )

    if (carrier.status.phase === 'open') {
      this.#patch({ phase: 'handshaking', carrier: carrier.kind })
      this.#sendHello()
    }
  }

  close(): void {
    this.#detach()
    this.#patch({ phase: 'idle', carrier: 'none' })
  }

  /**
   * Match lane 0 to whether anybody can see it.
   *
   * The box keeps the bucket fixed and changes only the documented cadence.
   * Repeating `sub` is additive and safe against old boxes; they may answer
   * with a fresh snapshot, while a current box only updates its timer.
   */
  setTelemetryHz(hz: Sub['hz']): void {
    if (this.#subscription.hz === hz) return
    this.#subscription = { ...this.#subscription, hz }

    if (this.#state.phase === 'subscribing' || this.#state.phase === 'streaming') {
      this.#sendSub()
    }
  }

  /** Ask the carrier stack to replace a path that may have slept stale. */
  wake(): boolean {
    const carrier = this.#carrier
    if (!carrier?.wake) return false
    carrier.wake()
    return true
  }

  /** Age of a source's last successful reading, in ms of box uptime. */
  ageOf(srcId: string): number {
    const src = this.#state.sources.get(srcId)
    if (!src) return NaN
    const age = this.#state.uptimeMs - src.lastOkMs
    // Negative means the two numbers come from different boots: the box
    // restarted, its uptime reset, and a source stamp from before the restart
    // survived in the cache. Clamping that to zero reported "just now" over
    // readings from another lifetime of the box — the one lie this protocol
    // exists to prevent. Unknown is the honest answer, and the band already
    // knows how to say it.
    if (age < 0) return NaN
    return age
  }

  /** Worst state across the given sources. Drives the freshness band. */
  worstSourceState(srcIds: readonly string[]): SourceState {
    const rank: Record<SourceState, number> = { live: 0, lagging: 1, stale: 2, down: 3, never: 4 }
    let worst: SourceState = 'live'
    for (const id of srcIds) {
      const s = this.#state.sources.get(id)?.state ?? 'never'
      if (rank[s] > rank[worst]) worst = s
    }
    return worst
  }

  /**
   * Ask for a history window. Chunks arrive as they land; the promise settles
   * on `hist.end`.
   *
   * Sent on the bulk lane, not lane 0. A query carrying a `have` list varies
   * in length with how much the client already holds, and lane 0's whole
   * purpose is that its frames do not vary in length with anything.
   */
  history(query: HistQuery, onChunk: (chunk: HistChunk) => void): Promise<HistEnd> {
    if (!this.#carrier) {
      return Promise.reject(new Error('no carrier'))
    }

    const id = this.#nextRequestId
    // u32, and wrapping is harmless: a request that old has long since settled.
    this.#nextRequestId = (this.#nextRequestId + 1) % 0xffffffff || 1

    return new Promise<HistEnd>((resolve, reject) => {
      // Sent before anything is registered: a payload the largest bucket
      // cannot carry throws out of the executor, rejecting the promise with
      // no entry and no timer left behind for the deadline to sweep up.
      this.#sendBulk({ t: 'hist.query', id, b: query })

      this.#pendingHistory.set(id, { onChunk, resolve, reject })
      this.#armDeadline(this.#pendingHistory, id, HIST_TIMEOUT_MS, 'history request timed out')
    })
  }

  /**
   * Ask the box what it means to do.
   *
   * Bulk lane: a plan is a day of slots, far past lane 0's fixed bucket, and
   * it is not part of the constant-cadence stream anyway.
   */
  plan(): Promise<Plan> {
    if (!this.#carrier) return Promise.reject(new Error('no carrier'))

    const id = this.#nextRequestId
    this.#nextRequestId = (this.#nextRequestId + 1) % 0xffffffff || 1

    return new Promise<Plan>((resolve, reject) => {
      // Send first: a refused payload rejects through the executor and
      // leaves nothing registered. See history().
      this.#sendBulk({ t: 'plan.get', id })

      this.#pendingPlan.set(id, { resolve, reject })
      this.#armDeadline(this.#pendingPlan, id, PLAN_TIMEOUT_MS, 'plan request timed out')
    })
  }

  /**
   * Ask the box what electricity costs across a window.
   *
   * Bulk lane, for the same reason the plan is: two days of quarter-hour
   * slots is far past lane 0's fixed bucket, and none of it belongs in the
   * constant-cadence stream.
   */
  prices(query: PriceQuery): Promise<Prices> {
    if (!this.#carrier) return Promise.reject(new Error('no carrier'))

    const id = this.#nextRequestId
    this.#nextRequestId = (this.#nextRequestId + 1) % 0xffffffff || 1

    return new Promise<Prices>((resolve, reject) => {
      // Send first: a refused payload rejects through the executor and
      // leaves nothing registered. See history().
      this.#sendBulk({ t: 'price.get', id, b: query })

      this.#pendingPrices.set(id, { resolve, reject })
      this.#armDeadline(this.#pendingPrices, id, PRICE_TIMEOUT_MS, 'price request timed out')
    })
  }

  /**
   * Call the box's own HTTP API over this session.
   *
   * Bulk lane, and never lane 0: the path, the query and the body all vary in
   * length with what was asked, and lane 0's constant size is the privacy
   * control that keeps a household's load pattern out of the relay's view.
   *
   * Resolves with whatever the box's handler said, status included — a 404 is
   * an answer here, not a failure. Rejects with `ApiError` when the box sent a
   * stable code instead, and with a plain Error when the wire went away, the
   * deadline passed, or the answer arrived in pieces that do not fit together.
   *
   * One call is on the wire at a time, because that is how many the box
   * serves: a second in flight is answered "busy", which costs whichever view
   * lost the race a thirty-second backoff over a collision no view can see.
   * The queue is chained on settle, not success, so a call that fails hands
   * the wire to the one behind it — and each call's deadline is armed when it
   * dispatches, because a place in the queue is not time spent waiting on the
   * box.
   */
  api(req: ApiReq): Promise<ApiResponse> {
    const turn = this.#apiTail.then(() => this.#dispatchApi(req))
    this.#apiTail = turn.then(
      () => undefined,
      () => undefined
    )
    return turn
  }

  #dispatchApi(req: ApiReq): Promise<ApiResponse> {
    // Checked at dispatch, not enqueue: what matters is whether the wire is
    // there when this call's turn comes. A queued call whose predecessor was
    // settled by the carrier going away meets the same answer it would have
    // met in the pending map, now instead of at its deadline.
    if (!this.#carrier) return Promise.reject(new Error('no carrier'))
    if (this.#carrier.status.phase === 'closed') {
      return Promise.reject(new Error('carrier closed'))
    }

    const id = this.#nextRequestId
    this.#nextRequestId = (this.#nextRequestId + 1) % 0xffffffff || 1

    return new Promise<ApiResponse>((resolve, reject) => {
      // Sent before anything is registered: a payload the largest bucket
      // cannot carry throws out of the executor, rejecting the promise with
      // no entry and no timer left behind for the deadline to sweep up.
      this.#sendBulk({
        t: 'api.req',
        id,
        b: {
          maxBytes: API_MAX_BYTES,
          ...req,
          // The caller encoded this with a TextEncoder, and a typed array
          // from another realm is written as a list of numbers rather than a
          // byte string. See wireBytes.
          ...(req.body ? { body: wireBytes(req.body) } : {}),
        },
      })

      this.#pendingApi.set(id, {
        resolve,
        reject,
        head: null,
        chunks: [],
        bytes: 0,
        nextSeq: 0,
      })
      this.#armDeadline(this.#pendingApi, id, API_TIMEOUT_MS, 'api request timed out')
    })
  }

  /**
   * Express an intent and follow it to its outcome.
   *
   * Three separate deadlines, because they are three different events and
   * collapsing them would make the UI say the wrong thing:
   *   - no ack in ACK_TIMEOUT  -> it never reached the box
   *   - ack but no result      -> the box took it, the hardware has not confirmed
   *   - result                 -> what actually happened
   *
   * `notValidAfterMs` is mandatory on the wire, so an intent that sits in a
   * queue cannot execute as though it were fresh.
   */
  command(op: string, args: Record<string, unknown>, guards: Guard[] = []): CommandHandle {
    const cmdId = uuidv7()

    const handle: CommandHandle = {
      cmdId,
      state: 'sending',
      promise: new Promise<CmdResult>((resolve, reject) => {
        if (!this.#carrier) {
          reject(new Error('no carrier'))
          return
        }

        const ackTimer = setTimeout(() => {
          const p = this.#pendingCmd.get(cmdId)
          if (p && !p.acked) {
            this.#pendingCmd.delete(cmdId)
            reject(new CommandError('E_NO_ACK', "That didn't reach your box. Try again."))
          }
        }, CMD_ACK_TIMEOUT_MS)

        const confirmTimer = setTimeout(() => {
          const p = this.#pendingCmd.get(cmdId)
          if (p && p.acked) {
            this.#pendingCmd.delete(cmdId)
            // Accepted, but the hardware never reported back. Not a failure
            // and not a success — and the UI has to be able to say so.
            resolve({ cmdId, state: 'unconfirmed' })
          }
        }, CMD_CONFIRM_TIMEOUT_MS)

        this.#pendingCmd.set(cmdId, { resolve, reject, ackTimer, confirmTimer, acked: false })

        this.#send({
          t: 'cmd',
          b: {
            cmdId,
            op,
            args,
            // Relative to box uptime, which is the only clock both ends agree
            // on. A phone's wall clock is not a shared reference.
            notValidAfterMs: this.#state.uptimeMs + CMD_VALID_FOR_MS,
            expect: { rev: this.#state.controlRev, guards },
          },
        })
      }),
    }

    return handle
  }

  #sendHello(): void {
    // Any hello supersedes a retry waiting to send one — a reconnect asks the
    // same question, and two hellos in flight would earn two answers.
    clearTimeout(this.#bootRetry)
    const sub = { ...this.#subscription }
    this.#helloSub = sub
    this.#send({
      t: 'hello',
      b: {
        proto: { min: PROTO_MIN, max: PROTO_MAX },
        app: { build: this.#opts.build, ua: 'pwa' as const },
        locales: this.#opts.locales ?? ['en'],
        sub,
      },
    })
  }

  #sendSub(): void {
    this.#send({ t: 'sub', b: { ...this.#subscription } })
  }

  #onFrame(bytes: Uint8Array): void {
    let frame
    try {
      frame = decodeFrame(bytes)
    } catch (err) {
      // A frame we cannot parse is not a reason to tear down a working
      // session — the next one may be fine.
      if (err instanceof FrameError) return
      throw err
    }

    const envelope = frame.envelope

    switch (envelope.t) {
      case 'hello_ok':
        this.#onHelloOk(envelope.b as HelloOk)
        break
      case 'snap':
        this.#onSnap(envelope.b as Snap)
        break
      case 'delta':
        this.#onDelta(envelope.b as DeltaMsg, isTruncated(frame))
        break
      case 'tick':
        this.#onTick(envelope.b as Tick)
        break
      case 'hist.chunk': {
        const hist = this.#pendingHistory.get(envelope.id ?? -1)
        if (hist) {
          // A window still arriving is not a window that has gone quiet.
          this.#armDeadline(
            this.#pendingHistory,
            envelope.id!,
            HIST_TIMEOUT_MS,
            'history request timed out'
          )
          hist.onChunk(envelope.b as HistChunk)
        }
        break
      }
      case 'hist.end':
        this.#settleHistory(envelope.id, envelope.b as HistEnd)
        break
      case 'plan':
        this.#onPlan(envelope.b as Plan, envelope.id)
        break
      case 'price':
        this.#settlePrices(envelope.id, envelope.b as Prices)
        break
      case 'api.head':
        this.#onApiHead(envelope.id, envelope.b as ApiHead)
        break
      case 'api.chunk':
        this.#onApiChunk(envelope.id, envelope.b as ApiChunk)
        break
      case 'api.end':
        this.#settleApi(envelope.id, envelope.b as ApiEnd)
        break
      case 'cmd.ack':
        this.#onCmdAck(envelope.b as CmdAck)
        break
      case 'cmd.result':
        this.#onCmdResult(envelope.b as CmdResult)
        break
      case 'error':
        this.#onError(envelope.b as ErrorMsg, envelope.id)
        break
      case 'session.terminate':
        this.#onTerminate(envelope.b as SessionTerminate)
        break
      default:
        // Unknown types are ignored, not fatal. This is what lets a service
        // worker pin an old bundle without turning into a white screen.
        break
    }
  }

  #onHelloOk(b: HelloOk): void {
    markLinkPhase('hello-ok', { inlineSubscribed: b.subscribed === true })
    this.#patch({
      proto: b.proto,
      mode: b.mode,
      caps: new Set(b.caps),
      // Absent means a box from before roles existed, and such a box lets
      // every paired phone do everything. Defaulting to viewer would take a
      // household's own controls away the morning it updated its app.
      //
      // That default is only honest once the box has answered, which is what
      // the flag below is for: absent from a hello is a fact about the box,
      // and absent before one is nothing at all.
      role: b.role ?? ROLE_OWNER,
      // The box's own expansion, never this app's. Falling back to the role
      // table only when the box sent no list at all, which is a box from
      // before roles — and that box lets every paired phone do everything.
      scopes: new Set(b.scopes ?? ROLE_SCOPES[b.role ?? ROLE_OWNER] ?? []),
      heardFromBox: true,
      modes: b.modes ?? [],
      box: b.box,
      uptimeMs: b.clock.uptimeMs,
      boot: b.boot ?? null,
      needsUpdate: b.hint === 'app_update' || b.proto === PROTO_FLOOR,
    })

    if (b.mode === 'booting') {
      // Nothing to subscribe to yet — the box refuses one until it is up, and
      // it does not say when that is. So ask again on our own timer: the
      // carrier stays open the whole time the box is starting, so no status
      // change is coming to do it for us, and a phase parked here is the
      // starting screen for as long as the app is open. Each answer also
      // refreshes the boot progress the screen is showing.
      this.#patch({ phase: 'booting' })
      this.#bootRetry = setTimeout(() => this.#sendHello(), BOOT_RETRY_MS)
      return
    }

    this.#patch({ phase: 'subscribing' })
    if (b.subscribed) {
      // Visibility can change while hello crosses the relay. The accepted
      // cadence is the one carried by that hello; send only if the latest ask
      // has moved since then.
      if (
        !this.#helloSub ||
        this.#helloSub.bucket !== this.#subscription.bucket ||
        this.#helloSub.hz !== this.#subscription.hz
      ) {
        this.#sendSub()
      }
      return
    }
    // Old box: it ignored hello.sub and needs the original second exchange.
    this.#sendSub()
  }

  #onSnap(b: Snap): void {
    markLinkPhase('snapshot', linkCounters())
    const fields = new Map<Fid, number>()
    for (const [fid, v] of Object.entries(b.fields)) fields.set(Number(fid), v)

    this.#patch({
      phase: 'streaming',
      // A snapshot only arrives over a carrier, so the stream names the one
      // feeding it — whatever a cache paint that landed mid-handshake may
      // have said in the meantime.
      ...(this.#carrier ? { carrier: this.#carrier.kind } : {}),
      uptimeMs: b.uptimeMs,
      controlRev: b.controlRev,
      dict: b.dict,
      fields,
      sources: toSourceMap(b.sources),
      dispatchBlockedBy: b.dispatchBlockedBy,
    })
    this.#lastSeq = 0
  }

  #onDelta(b: DeltaMsg, truncated = false): void {
    // A gap means frames were lost. The values we hold are still true, so we
    // apply what arrived rather than blanking the screen; a resync is the
    // caller's decision, not something to do silently mid-stream.
    this.#lastSeq = b.seq

    const fields = new Map(this.#state.fields)
    for (const [fid, v] of Object.entries(b.fields)) fields.set(Number(fid), v)

    this.#patch({
      phase: 'streaming',
      uptimeMs: b.uptimeMs,
      fields,
      // Nothing is lost when a delta is truncated — the box could not fit
      // every changed field in the bucket and the rest are still dirty next
      // tick. Recorded so a view can tell a partial update from a complete
      // one rather than the flag being declared and discarded.
      truncated,
      ...(b.sources ? { sources: toSourceMap(b.sources) } : {}),
      ...(b.dispatchBlockedBy ? { dispatchBlockedBy: b.dispatchBlockedBy } : {}),
    })
  }

  #onTick(b: Tick): void {
    this.#lastSeq = b.seq
    this.#patch({ uptimeMs: b.uptimeMs })
  }

  #settleHistory(id: number | undefined, end: HistEnd): void {
    const pending = this.#pendingHistory.get(id ?? -1)
    if (!pending) return
    this.#pendingHistory.delete(id!)
    clearTimeout(pending.timer)
    pending.resolve(end)
  }

  /**
   * An error carrying a request id belongs to that request alone.
   *
   * Without this, a history window the box could not serve would raise the
   * session-wide error banner and make the whole app look broken over one
   * chart the user can simply narrow.
   */
  #onPlan(b: Plan, id?: number): void {
    // Kept on session state as well as resolving the request, so a plan that
    // arrives unasked — the box replans after a mode change — reaches the UI
    // without anyone having to poll for it.
    this.#patch({ plan: b })

    if (typeof id !== 'number') return
    const pending = this.#pendingPlan.get(id)
    if (pending) {
      clearTimeout(pending.timer)
      this.#pendingPlan.delete(id)
      pending.resolve(b)
    }
  }

  /**
   * Prices settle the request and nothing else.
   *
   * Unlike a plan, which the box pushes unasked after a mode change and which
   * therefore lives on session state, a price window only ever arrives as an
   * answer. Keeping a copy on state would be a second place for the view to
   * read the same thing from, and the two would eventually disagree.
   */
  #settlePrices(id: number | undefined, prices: Prices): void {
    const pending = this.#pendingPrices.get(id ?? -1)
    if (!pending) return
    this.#pendingPrices.delete(id!)
    clearTimeout(pending.timer)
    pending.resolve(prices)
  }

  #onApiHead(id: number | undefined, head: ApiHead): void {
    const pending = this.#pendingApi.get(id ?? -1)
    if (!pending) return
    // A second status for one request is a box contradicting itself. The
    // first is the one already committed to, so the later one is dropped
    // rather than allowed to rewrite what the caller will be told.
    if (pending.head !== null) return
    pending.head = head
    this.#armDeadline(this.#pendingApi, id!, API_TIMEOUT_MS, 'api request timed out')
  }

  #onApiChunk(id: number | undefined, chunk: ApiChunk): void {
    const pending = this.#pendingApi.get(id ?? -1)
    if (!pending) return

    // A body assembled out of order, or with a chunk missing, is not a short
    // answer to parse — it is bytes that were never sent presented as the
    // box's. JSON would usually fail to parse and occasionally would not,
    // which is the worse half. Fail the request instead.
    if (chunk.seq !== pending.nextSeq) {
      this.#pendingApi.delete(id!)
      clearTimeout(pending.timer)
      pending.reject(new Error('api response arrived out of order'))
      return
    }
    pending.nextSeq += 1
    pending.chunks.push(chunk.data)
    pending.bytes += chunk.data.length
    this.#armDeadline(this.#pendingApi, id!, API_TIMEOUT_MS, 'api request timed out')
  }

  /**
   * The answer is complete — or it is not, and that is a failure.
   *
   * A truncated answer never resolves. Half a CSV export and half a JSON
   * document are both wrong in a way no caller above this can see, and the
   * one honest thing to do with them is refuse them and say the window was
   * too wide.
   */
  #settleApi(id: number | undefined, end: ApiEnd): void {
    const pending = this.#pendingApi.get(id ?? -1)
    if (!pending) return
    this.#pendingApi.delete(id!)
    clearTimeout(pending.timer)

    if (end.truncated) {
      pending.reject(
        new ApiError({ code: 'E_RESPONSE_TOO_LARGE', retryable: false, args: { bytes: end.bytes } })
      )
      return
    }

    // No status and no error: the box ended a request it never answered. Not
    // a body to hand up with a made-up status on it.
    if (pending.head === null) {
      pending.reject(new Error('api response ended without a status'))
      return
    }

    const body = new Uint8Array(pending.bytes)
    let at = 0
    for (const part of pending.chunks) {
      body.set(part, at)
      at += part.length
    }

    pending.resolve({ status: pending.head.status, headers: pending.head.headers, body })
  }

  #onCmdAck(b: CmdAck): void {
    const pending = this.#pendingCmd.get(b.cmdId)
    if (!pending) return

    // The box has the intent. From here the question is whether the hardware
    // confirms, which is a different deadline.
    clearTimeout(pending.ackTimer)
    pending.acked = true
  }

  #onCmdResult(b: CmdResult): void {
    const pending = this.#pendingCmd.get(b.cmdId)
    if (!pending) return

    clearTimeout(pending.ackTimer)
    clearTimeout(pending.confirmTimer)
    this.#pendingCmd.delete(b.cmdId)
    pending.resolve(b)
  }

  /**
   * An error carrying a request id belongs to that request alone.
   *
   * Raising the session-wide error state instead would make the whole app
   * look broken over one window the box could not serve. Only an error with
   * no request behind it is about the session.
   */
  #onError(b: ErrorMsg, id?: number): void {
    if (typeof id === 'number') {
      const history = this.#pendingHistory.get(id)
      if (history) {
        this.#pendingHistory.delete(id)
        clearTimeout(history.timer)
        history.reject(new HistoryError(b))
        return
      }

      const plan = this.#pendingPlan.get(id)
      if (plan) {
        this.#pendingPlan.delete(id)
        clearTimeout(plan.timer)
        plan.reject(new PlanError(b))
        return
      }

      const prices = this.#pendingPrices.get(id)
      if (prices) {
        this.#pendingPrices.delete(id)
        clearTimeout(prices.timer)
        prices.reject(new PriceError(b))
        return
      }

      const api = this.#pendingApi.get(id)
      if (api) {
        this.#pendingApi.delete(id)
        clearTimeout(api.timer)
        api.reject(new ApiError(b))
        return
      }
    }

    this.#patch({ lastError: b })
  }

  #onTerminate(b: SessionTerminate): void {
    this.#patch({ phase: 'terminated', terminated: b, carrier: 'none' })
    this.#detach()
  }

  #send(envelope: { t: string; id?: number; b?: unknown }): void {
    if (!this.#carrier) return
    this.#carrier.send(encodeFrame({ lane: LANE_CONTROL, flags: 0, envelope }, this.#bucket))
  }

  #sendBulk(envelope: { t: string; id?: number; b?: unknown }): void {
    if (!this.#carrier) return
    // Sized by trial: the encoder refuses to grow a bucket, so the frame is
    // built once and stepped up rather than guessed at from the object.
    for (const bucket of BULK_BUCKETS) {
      try {
        this.#carrier.send(encodeFrame({ lane: LANE_BULK, flags: 0, envelope }, bucket))
        return
      } catch (err) {
        if (!(err instanceof FrameError)) throw err
      }
    }
    throw new FrameError('bulk payload exceeds the largest bucket', 'E_FRAME_EXCEEDS_BUCKET')
  }

  /**
   * Arm — or push back — a request's deadline.
   *
   * The deadline measures silence, not total time. A multi-megabyte answer
   * arriving steadily in chunks is a request that is working, and a deadline
   * armed once at dispatch would kill it mid-flow while the box kept
   * streaming into an id nobody held any more. So every head and chunk
   * re-arms it, and what expires is a wire that has gone quiet.
   */
  #armDeadline<P extends { timer?: ReturnType<typeof setTimeout>; reject: (err: Error) => void }>(
    map: Map<number, P>,
    id: number,
    ms: number,
    message: string
  ): void {
    const pending = map.get(id)
    if (!pending) return
    clearTimeout(pending.timer)
    pending.timer = setTimeout(() => {
      map.delete(id)
      pending.reject(new Error(message))
    }, ms)
  }

  #detach(): void {
    clearTimeout(this.#bootRetry)
    for (const u of this.#unsub) u()
    this.#unsub = []
    this.#carrier?.close()
    this.#carrier = null
    this.#settlePending()
  }

  /**
   * End everything waiting on a carrier that will not answer.
   *
   * Separate from #detach because the two ways a carrier goes away need
   * different things done to the carrier and the same thing done to the
   * requests. #detach tears the carrier down; an ordinary drop leaves it
   * attached to reconnect. Either way a view must stop waiting on a reply
   * that cannot arrive — there is no "reload" button to rescue it. Every map,
   * not just the first: one left behind is a promise that settles minutes
   * later, on its own timer, against a view that has long since moved on.
   */
  #settlePending(): void {
    for (const map of [
      this.#pendingHistory,
      this.#pendingPlan,
      this.#pendingPrices,
      this.#pendingApi,
    ]) {
      for (const [id, pending] of map) {
        clearTimeout(pending.timer)
        pending.reject(new Error('carrier closed'))
        map.delete(id)
      }
    }

    // A command is settled the way its own deadlines would settle it, because
    // the two cases are different answers. One the box never acknowledged did
    // not reach it, and is never replayed silently. One it did acknowledge may
    // well have been carried out, so "that didn't reach your box" would be a
    // lie — and "accepted, never confirmed" is exactly what unconfirmed says.
    for (const [cmdId, pending] of this.#pendingCmd) {
      clearTimeout(pending.ackTimer)
      clearTimeout(pending.confirmTimer)
      this.#pendingCmd.delete(cmdId)
      if (pending.acked) pending.resolve({ cmdId, state: 'unconfirmed' })
      else pending.reject(new CommandError('E_NO_ACK', "That didn't reach your box. Try again."))
    }
  }

  #patch(partial: Partial<SessionState>): void {
    this.#state = { ...this.#state, ...partial }
    for (const l of this.#listeners) {
      try {
        l(this.#state)
      } catch (err) {
        console.error('session listener threw', err)
      }
    }
  }
}

function toSourceMap(wire: Record<string, Source>): Map<string, Source> {
  return new Map(Object.entries(wire))
}
