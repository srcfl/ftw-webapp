/* Box simulator.
 *
 * Speaks the wire protocol and can be forced into every failure state the
 * client has to handle. Roughly two thirds of the client's behaviour is
 * failure semantics — booting, a driver going quiet, access revoked
 * mid-session, a precondition failing, a command the hardware never confirms,
 * an app too old for the box. None of that can be reproduced on demand
 * against real hardware, so none of it would get tested without this.
 *
 * It is deliberately a peer, not a mock: it holds its own state, enforces
 * its own rules and answers frames. Tests drive it through the same wire the
 * app uses, so a test passing here means the protocol works, not that a stub
 * agreed with itself.
 */

import { encodeFrame, decodeFrame, LANE_CONTROL, LANE_BULK, bulkBucketFor, type Frame } from '$lib/protocol/frame'
import {
  PROTO_MAX,
  PROTO_FLOOR,
  MISSING_SAMPLE,
  type Hello,
  type HelloOk,
  type Sub,
  type Snap,
  type Cmd,
  type SourceWire,
  type HistQuery,
  type HistChunk,
  type HistEnd,
  type SiteMode,
  SITE_MODES,
  OP_SET_MODE,
} from '$lib/protocol/messages'
import { buildPlan } from './planner'
import {
  RESOLUTIONS,
  DEFAULT_MAX_POINTS,
  planQuery,
  packColumns,
  etagOf,
} from '$lib/protocol/history'
import type { SourceState } from '$lib/protocol/types'
import { DEFAULT_HOUSE, sample, stepSoc, type HouseConfig, type Reading } from './energy'

export interface SimFaults {
  /** Still starting. Answers hello with boot progress, refuses subscriptions. */
  booting: boolean
  /** Force a source into a non-live state, by source id. */
  sourceStates: Partial<Record<string, SourceState>>
  /** Reject every command's preconditions. */
  failPreconditions: boolean
  /** Ack commands but never confirm them, so the client hits unconfirmed. */
  neverConfirm: boolean
  /** Highest protocol the box will speak. Set to 0 to force floor mode. */
  maxProto: number
  /** Drop this fraction of outgoing telemetry frames. */
  frameLossRate: number
  /**
   * A window the box recorded nothing for — a driver outage, a power cut.
   *
   * History with holes in it is the normal case, not the exotic one, and a
   * chart that interpolates across one is inventing readings. This switch is
   * how that gets seen rather than only asserted.
   */
  histOutage: { fromMs: number; toMs: number } | null
  /**
   * The planner could not run and the box fell back.
   *
   * Distinct from having no plan: "nothing is scheduled" and "we do not know
   * what is scheduled" are different sentences, and only one of them is true
   * here.
   */
  planStale: boolean
}

export const NO_FAULTS: SimFaults = {
  booting: false,
  sourceStates: {},
  failPreconditions: false,
  neverConfirm: false,
  maxProto: PROTO_MAX,
  frameLossRate: 0,
  histOutage: null,
  planStale: false,
}

/** Field ids 1–9, frozen permanently. See contract/registry.yaml. */
const FID = {
  MODE: 1,
  GRID_W: 2,
  PV_W: 3,
  BATTERY_W: 4,
  BATTERY_SOC: 5,
  LOAD_W: 6,
} as const

const SRC = {
  METER: 'meter.p1',
  PV: 'inverter.sungrow',
  BATTERY: 'battery.sungrow',
} as const

const DICT: Snap['dict'] = {
  [FID.MODE]: { name: 'mode', unit: null, srcId: null },
  [FID.GRID_W]: { name: 'grid_w', unit: 'W', srcId: SRC.METER },
  [FID.PV_W]: { name: 'pv_w', unit: 'W', srcId: SRC.PV },
  [FID.BATTERY_W]: { name: 'battery_w', unit: 'W', srcId: SRC.BATTERY },
  [FID.BATTERY_SOC]: { name: 'battery_soc', unit: 'permille', srcId: SRC.BATTERY },
  [FID.LOAD_W]: { name: 'load_w', unit: 'W', srcId: SRC.METER },
}

/** Series the box can serve, named as in contract/registry.yaml. */
const HIST_SERIES: Record<string, (r: Reading) => number> = {
  grid_w: (r) => r.gridW,
  pv_w: (r) => r.pvW,
  battery_w: (r) => r.batteryW,
  load_w: (r) => r.loadW,
  battery_soc: (r) => Math.round(r.batterySocPermille),
}

const DAY_MS = 86_400_000

/**
 * State of charge history is re-anchored at each UTC midnight.
 *
 * Everything else in a reading is a function of the moment alone, but state
 * of charge is an integral, and replaying two years of it to answer one query
 * is absurd. Midnight is the honest place to re-anchor: there is no sun and
 * the load sits far below the ceiling, so the battery is idle either side of
 * the seam and the re-anchor never appears in a plotted series.
 */
const HIST_DAY_ANCHOR_PERMILLE = 620

const CAPS = [
  'status.core',
  'status.phases',
  'status.drivers',
  'history.5m',
  'history.1h',
  'cmd.lease',
  'cmd.precondition',
  'cmd.readback',
  'der.battery',
  'plan.dispatch',
]

export interface SimBoxOptions {
  house?: Partial<HouseConfig>
  faults?: Partial<SimFaults>
  /** Wall clock for generating the energy shape. Injected so tests can pin it. */
  now?: () => number
  /** Ceiling the optimiser defends, in watts. */
  ceilingW?: number
}

export class SimBox {
  readonly house: HouseConfig
  faults: SimFaults

  #now: () => number
  #startedAtMs: number
  #ceilingW: number

  #socPermille = 620
  #seq = 0
  #controlRev = 1
  #subscribed = false
  #negotiatedProto = PROTO_MAX
  #bucket: 256 | 512 = 512
  #lastReading: Reading | null = null
  #lastSent = new Map<number, number>()
  #lastSourcesJson = ''
  #mode: SiteMode = 'automatic'
  #planRev = 1

  /** cmdId -> result, kept so a retry cannot act twice. */
  #idempotency = new Map<string, { leaseId: string; expiresAtMs: number }>()

  #out = new Set<(frame: Uint8Array) => void>()

  constructor(opts: SimBoxOptions = {}) {
    this.house = { ...DEFAULT_HOUSE, ...opts.house }
    this.faults = { ...NO_FAULTS, ...opts.faults }
    this.#now = opts.now ?? (() => Date.now())
    this.#startedAtMs = this.#now()
    this.#ceilingW = opts.ceilingW ?? this.house.fuseA * 230 * this.house.phases * 0.9
  }

  /** Box uptime. Every age in the protocol is measured against this, never
   *  wall clock — a Pi reads 1970 until NTP answers. */
  get uptimeMs(): number {
    return this.#now() - this.#startedAtMs
  }

  get subscribed(): boolean {
    return this.#subscribed
  }

  onFrame(handler: (frame: Uint8Array) => void): () => void {
    this.#out.add(handler)
    return () => this.#out.delete(handler)
  }

  /** Deliver a frame from the client. */
  receive(bytes: Uint8Array): void {
    let frame: Frame
    try {
      frame = decodeFrame(bytes)
    } catch (err) {
      this.#error('E_UNKNOWN_OP', false, { detail: String(err) })
      return
    }

    const { t, b, id } = frame.envelope

    switch (t) {
      case 'hello':
        this.#onHello(b as Hello)
        break
      case 'sub':
        this.#onSub(b as Sub)
        break
      case 'cmd':
        this.#onCmd(b as Cmd)
        break
      case 'plan.get':
        this.#onPlanGet(typeof id === 'number' ? id : 0)
        break
      case 'hist.query':
        this.#onHistQuery(id, b as HistQuery)
        break
      default:
        // Unknown types are answered, never fatal — that is what lets a newer
        // app talk to an older box.
        if (typeof id === 'number') this.#error('E_UNKNOWN_OP', false, { t }, id)
    }
  }

  /** Advance one telemetry step. The driver of the simulation. */
  tick(stepMs = 1000): void {
    if (!this.#subscribed || this.faults.booting) return

    const reading = sample(this.house, this.#now(), this.#socPermille, this.#ceilingW)
    this.#socPermille = stepSoc(this.house, this.#socPermille, reading.batteryW, stepMs)
    this.#lastReading = reading

    const fields: Record<string, number> = {}
    const candidate: Record<number, number> = {
      [FID.MODE]: SITE_MODES.indexOf(this.#mode),
      [FID.GRID_W]: reading.gridW,
      [FID.PV_W]: reading.pvW,
      [FID.BATTERY_W]: reading.batteryW,
      [FID.BATTERY_SOC]: Math.round(reading.batterySocPermille),
      [FID.LOAD_W]: reading.loadW,
    }

    for (const [fid, value] of Object.entries(candidate)) {
      if (this.#lastSent.get(Number(fid)) !== value) {
        fields[fid] = value
        this.#lastSent.set(Number(fid), value)
      }
    }

    // Source states change rarely, so they ride along only when they move —
    // but they MUST ride along. A device going quiet mid-session is exactly
    // what the freshness model exists to show, and sending sources only in
    // the snapshot means the client never hears about it.
    const sources = this.#sources()
    const sourcesChanged = JSON.stringify(sources) !== this.#lastSourcesJson
    if (sourcesChanged) this.#lastSourcesJson = JSON.stringify(sources)

    this.#seq += 1

    // A tick is sent when nothing changed. Silence would itself be a signal:
    // it would tell the relay operator that nothing happened in the house.
    const envelope =
      Object.keys(fields).length > 0 || sourcesChanged
        ? {
            t: 'delta',
            b: {
              seq: this.#seq,
              uptimeMs: this.uptimeMs,
              fields,
              ...(sourcesChanged ? { sources, dispatchBlockedBy: this.#blockedSources() } : {}),
            },
          }
        : { t: 'tick', b: { seq: this.#seq, uptimeMs: this.uptimeMs } }

    this.#send({ lane: LANE_CONTROL, flags: 0, envelope }, this.#bucket)
  }

  /** Revoke access mid-session, fail-closed. */
  revoke(): void {
    this.#subscribed = false
    this.#send(
      { lane: LANE_CONTROL, flags: 0, envelope: { t: 'session.terminate', b: { reason: 'revoked' } } },
      this.#bucket
    )
  }

  #onHello(hello: Hello): void {
    const boxMax = Math.min(this.faults.maxProto, PROTO_MAX)

    // Too old for full mode? Degrade, never error. A hard wall here is a
    // white screen for anyone whose service worker pinned an old bundle.
    const proto = hello.proto.max < boxMax ? Math.max(PROTO_FLOOR, hello.proto.max) : boxMax

    const b: HelloOk = {
      proto,
      mode: this.faults.booting ? 'booting' : proto === PROTO_FLOOR ? 'floor' : 'full',
      box: { id: 'sim-0001', build: 'sim', tz: 'Europe/Stockholm' },
      clock: { source: 'ntp', syncedAtMs: this.#startedAtMs, uptimeMs: this.uptimeMs },
      caps: proto === PROTO_FLOOR ? ['status.core'] : CAPS,
      capsHash: 'sim',
      ...(this.faults.booting
        ? { boot: { phase: 'vacuum' as const, pct: 40, etaMs: 90_000 } }
        : {}),
      ...(proto === PROTO_FLOOR ? { hint: 'app_update' as const } : {}),
    }

    this.#send({ lane: LANE_CONTROL, flags: 0, envelope: { t: 'hello_ok', b } }, this.#bucket)
  }

  #onSub(sub: Sub): void {
    if (this.faults.booting) {
      this.#error('E_BOOTING', true, { etaMs: 90_000 })
      return
    }

    this.#bucket = sub.bucket
    this.#subscribed = true
    this.#lastSent.clear()
    this.#lastSourcesJson = JSON.stringify(this.#sources())

    const reading = sample(this.house, this.#now(), this.#socPermille, this.#ceilingW)
    this.#lastReading = reading

    const fields: Record<string, number> = {
      [FID.MODE]: SITE_MODES.indexOf(this.#mode),
      [FID.GRID_W]: reading.gridW,
      [FID.PV_W]: reading.pvW,
      [FID.BATTERY_W]: reading.batteryW,
      [FID.BATTERY_SOC]: Math.round(reading.batterySocPermille),
      [FID.LOAD_W]: reading.loadW,
    }
    for (const [fid, v] of Object.entries(fields)) this.#lastSent.set(Number(fid), v)

    const snap: Snap = {
      uptimeMs: this.uptimeMs,
      controlRev: this.#controlRev,
      dict: DICT,
      fields,
      sources: this.#sources(),
      dispatchBlockedBy: this.#blockedSources(),
    }

    const payloadGuess = 2048
    this.#send(
      { lane: LANE_BULK, flags: 0, envelope: { t: 'snap', b: snap } },
      bulkBucketFor(payloadGuess) ?? 4096
    )
  }

  #onCmd(cmd: Cmd): void {
    // Idempotency first: a retry must return the original outcome, not act again.
    const prior = this.#idempotency.get(cmd.cmdId)
    if (prior) {
      this.#send(
        { lane: LANE_CONTROL, flags: 0, envelope: { t: 'cmd.ack', b: { cmdId: cmd.cmdId, ...prior } } },
        this.#bucket
      )
      return
    }

    if (cmd.notValidAfterMs <= this.uptimeMs) {
      this.#cmdResult(cmd.cmdId, 'expired', { code: 'E_CMD_EXPIRED' })
      return
    }

    if (cmd.expect.rev !== this.#controlRev) {
      this.#cmdResult(cmd.cmdId, 'rejected', {
        code: 'E_CONFLICT',
        args: { expected: cmd.expect.rev, actual: this.#controlRev },
      })
      return
    }

    // Guards are re-evaluated here, against state as it is now — not as it
    // was when the user pressed the button.
    if (this.faults.failPreconditions || !this.#guardsHold(cmd)) {
      this.#cmdResult(cmd.cmdId, 'rejected', { code: 'E_PRECONDITION' })
      return
    }

    const lease = { leaseId: `lease-${cmd.cmdId.slice(0, 8)}`, expiresAtMs: this.uptimeMs + 900_000 }
    this.#idempotency.set(cmd.cmdId, lease)
    this.#controlRev += 1

    this.#send(
      { lane: LANE_CONTROL, flags: 0, envelope: { t: 'cmd.ack', b: { cmdId: cmd.cmdId, ...lease } } },
      this.#bucket
    )

    // The intent is accepted; now it has to actually take effect. A mode
    // change alters what the planner does, so the plan is remade and pushed
    // unasked — otherwise the app would show yesterday's intent beside
    // today's mode and neither would look wrong.
    if (cmd.op === OP_SET_MODE) {
      const wanted = cmd.args['mode']
      if (typeof wanted === 'string' && (SITE_MODES as readonly string[]).includes(wanted)) {
        this.#mode = wanted as SiteMode
        this.#planRev += 1
      }
    }

    // The echo of a requested value is never confirmation. Real confirmation
    // is the driver reading the value back, which may simply not happen.
    if (this.faults.neverConfirm) return

    if (cmd.op === OP_SET_MODE) {
      this.#cmdResult(cmd.cmdId, 'applied', undefined, {
        value: SITE_MODES.indexOf(this.#mode),
        src: 'core',
        uptimeMs: this.uptimeMs,
      })
      this.#sendPlan()
      return
    }

    const value = typeof cmd.args['watts'] === 'number' ? cmd.args['watts'] : 0
    this.#cmdResult(cmd.cmdId, 'applied', undefined, {
      value,
      src: SRC.BATTERY,
      uptimeMs: this.uptimeMs,
    })
  }

  #onPlanGet(id: number): void {
    if (this.faults.booting) {
      this.#error('E_BOOTING', true, {}, id)
      return
    }
    this.#sendPlan(id)
  }

  #sendPlan(id?: number): void {
    const plan = buildPlan({
      house: this.house,
      mode: this.#mode,
      nowMs: this.#now(),
      uptimeMs: this.uptimeMs,
      socPermille: this.#socPermille,
      ceilingW: this.#ceilingW,
      rev: this.#planRev,
      stale: this.faults.planStale,
    })

    this.#send(
      {
        lane: LANE_BULK,
        flags: 0,
        envelope: { t: 'plan', ...(typeof id === 'number' ? { id } : {}), b: plan },
      },
      bulkBucketFor(16000) ?? 16384
    )
  }

  /** The mode the site is running in. Read by the planner. */
  get mode(): SiteMode {
    return this.#mode
  }

  /**
   * Answer a history window with tiles.
   *
   * Downsampling happens here and only here — the client never receives more
   * points than it asked room for. A window too wide for the requested
   * resolution is served coarser and says so in `resActual`; it is never
   * refused, because "too much data" is the box's problem to solve, not a
   * sentence a person can act on.
   */
  #onHistQuery(id: number | undefined, q: HistQuery): void {
    // Without a request id there is nothing to answer to. Replying on a bare
    // channel would look like an unsolicited chunk to every other listener.
    if (typeof id !== 'number') return

    if (this.faults.booting) {
      this.#error('E_BOOTING', true, { etaMs: 90_000 }, id)
      return
    }

    const names = (q.series ?? []).filter((n) => n in HIST_SERIES)
    if (names.length === 0) {
      this.#error('E_UNAVAILABLE', false, { detail: 'no series this box records' }, id)
      return
    }

    const res = q.res === '1h' ? '1h' : '5m'
    const plan = planQuery(res, q.fromMs, q.toMs, q.maxPoints ?? DEFAULT_MAX_POINTS)
    const have = new Map((q.have ?? []).map((h) => [h.tileId, h.etag]))
    const nowMs = this.#now()
    const tileSpanMs = RESOLUTIONS[plan.res].tileSpanMs

    for (const tile of plan.tiles) {
      const partial = tile.startMs + tileSpanMs > nowMs
      const data = packColumns(
        this.#histColumns(plan.res, tile.startMs, tile.points, plan.stride, names)
      )
      const etag = etagOf(data)

      // The etag earns its keep here: a closed tile the client already holds
      // never crosses the wire a second time. The trailing tile is still
      // filling, so it is always sent and never cached.
      if (!partial && have.get(tile.tileId) === etag) continue

      const chunk: HistChunk = {
        tileId: tile.tileId,
        etag,
        res: plan.res,
        startMs: tile.startMs,
        stepMs: plan.stepMs,
        series: names,
        data,
        partial,
      }

      this.#send(
        { lane: LANE_BULK, flags: 0, envelope: { t: 'hist.chunk', id, b: chunk } },
        bulkBucketFor(data.length + 256) ?? 16384
      )
    }

    const end: HistEnd = {
      resActual: plan.res,
      gaps: this.#histGaps(plan.res, q.fromMs, q.toMs),
    }
    this.#send(
      { lane: LANE_BULK, flags: 0, envelope: { t: 'hist.end', id, b: end } },
      bulkBucketFor(512) ?? 1024
    )
  }

  /**
   * Generate one tile's columns from the same sample() the live view uses.
   *
   * Same generator, same seed, same minute — so a value the Now screen showed
   * an hour ago is the value the chart draws for that hour. A separate
   * history generator would drift, and the first person to notice would be a
   * user comparing two screens of the same house.
   */
  #histColumns(
    res: '5m' | '1h',
    startMs: number,
    points: number,
    stride: number,
    names: string[]
  ): Int32Array[] {
    const baseStepMs = RESOLUTIONS[res].stepMs
    const endMs = startMs + points * stride * baseStepMs
    const nowMs = this.#now()
    const oldestMs = nowMs - RESOLUTIONS[res].retentionMs
    const outage = this.faults.histOutage

    // INT32_MIN, not zero. Zero is a real reading — a house that drew nothing
    // — and a chart cannot tell the two apart after the fact.
    const columns = names.map(() => new Int32Array(points).fill(MISSING_SAMPLE))
    const sums = new Float64Array(names.length)
    const readers = names.map((n) => HIST_SERIES[n]!)

    let socPermille = HIST_DAY_ANCHOR_PERMILLE
    let day = Math.floor(startMs / DAY_MS)
    let inBucket = 0
    let present = 0
    let bucketIndex = 0

    // Starts at midnight so state of charge arrives at the tile boundary the
    // same way whichever tile of the day is asked for.
    for (let t = day * DAY_MS; t < endMs; t += baseStepMs) {
      const d = Math.floor(t / DAY_MS)
      if (d !== day) {
        day = d
        socPermille = HIST_DAY_ANCHOR_PERMILLE
      }

      const reading = sample(this.house, t, socPermille, this.#ceilingW)
      socPermille = stepSoc(this.house, socPermille, reading.batteryW, baseStepMs)

      if (t < startMs) continue

      const missing =
        t >= nowMs ||
        t < oldestMs ||
        (outage !== null && t >= outage.fromMs && t < outage.toMs)

      if (!missing) {
        for (let s = 0; s < readers.length; s++) sums[s]! += readers[s]!(reading)
        present += 1
      }

      if (++inBucket === stride) {
        // A bucket with nothing in it stays missing. Averaging over the
        // samples that did arrive would quietly paper over an outage.
        if (present > 0) {
          for (let s = 0; s < readers.length; s++) {
            columns[s]![bucketIndex] = Math.round(sums[s]! / present)
          }
        }
        sums.fill(0)
        present = 0
        inBucket = 0
        bucketIndex += 1
      }
    }

    return columns
  }

  /** Ranges the box has nothing for, and why — so the UI can say rather than guess. */
  #histGaps(res: '5m' | '1h', fromMs: number, toMs: number): HistEnd['gaps'] {
    const nowMs = this.#now()
    const oldestMs = nowMs - RESOLUTIONS[res].retentionMs
    const outage = this.faults.histOutage

    const gaps: HistEnd['gaps'] = []
    const add = (a: number, b: number, reason: HistEnd['gaps'][number]['reason']) => {
      const start = Math.max(a, fromMs)
      const end = Math.min(b, toMs)
      if (end > start) gaps.push({ fromMs: start, toMs: end, reason })
    }

    add(fromMs, oldestMs, 'evicted')
    if (outage) add(outage.fromMs, outage.toMs, 'box_down')
    add(nowMs, toMs, 'no_data')

    return gaps
  }

  #guardsHold(cmd: Cmd): boolean {
    if (!this.#lastReading) return true

    const current: Record<number, number> = {
      [FID.GRID_W]: this.#lastReading.gridW,
      [FID.PV_W]: this.#lastReading.pvW,
      [FID.BATTERY_W]: this.#lastReading.batteryW,
      [FID.BATTERY_SOC]: Math.round(this.#socPermille),
      [FID.LOAD_W]: this.#lastReading.loadW,
    }

    return cmd.expect.guards.every((g) => {
      const v = current[g.fid]
      if (v === undefined) return false
      switch (g.op) {
        case 'lt':
          return v < g.value
        case 'lte':
          return v <= g.value
        case 'gt':
          return v > g.value
        case 'gte':
          return v >= g.value
      }
    })
  }

  #sources(): Record<string, SourceWire> {
    const mk = (id: string, kind: string, name: string, staleAfterMs: number): SourceWire => {
      const forced = this.faults.sourceStates[id]
      const state: SourceState = forced ?? 'live'
      // A source forced stale has not answered recently — say so honestly
      // rather than reporting a fresh timestamp with a stale label.
      const lastOkMs =
        state === 'live' ? this.uptimeMs : Math.max(0, this.uptimeMs - staleAfterMs * 3)
      return { kind, name, lastOkMs, staleAfterMs, state }
    }

    return {
      [SRC.METER]: mk(SRC.METER, 'meter', 'P1 meter', 5_000),
      [SRC.PV]: mk(SRC.PV, 'inverter', 'Sungrow inverter', 15_000),
      [SRC.BATTERY]: mk(SRC.BATTERY, 'battery', 'Sungrow battery', 15_000),
    }
  }

  /** The box's own safety rule: stale meter data stops dispatch. */
  #blockedSources(): string[] {
    const meter = this.faults.sourceStates[SRC.METER]
    return meter && meter !== 'live' ? [SRC.METER] : []
  }

  #cmdResult(
    cmdId: string,
    state: 'applied' | 'rejected' | 'expired' | 'superseded' | 'unconfirmed',
    error?: { code: string; args?: Record<string, unknown> },
    observed?: { value: number; src: string; uptimeMs: number }
  ): void {
    this.#send(
      {
        lane: LANE_CONTROL,
        flags: 0,
        envelope: {
          t: 'cmd.result',
          b: { cmdId, state, ...(error ? { error } : {}), ...(observed ? { observed } : {}) },
        },
      },
      this.#bucket
    )
  }

  #error(code: string, retryable: boolean, args?: Record<string, unknown>, id?: number): void {
    this.#send(
      {
        lane: LANE_CONTROL,
        flags: 0,
        envelope: {
          t: 'error',
          ...(typeof id === 'number' ? { id } : {}),
          b: { code, retryable, ...(args ? { args } : {}) },
        },
      },
      this.#bucket
    )
  }

  #send(frame: Frame, bucket: number): void {
    if (this.faults.frameLossRate > 0 && Math.random() < this.faults.frameLossRate) return

    const bytes = encodeFrame(frame, bucket)
    for (const h of this.#out) h(bytes)
  }
}
