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
  type Hello,
  type HelloOk,
  type Sub,
  type Snap,
  type Cmd,
  type SourceWire,
} from '$lib/protocol/messages'
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
}

export const NO_FAULTS: SimFaults = {
  booting: false,
  sourceStates: {},
  failPreconditions: false,
  neverConfirm: false,
  maxProto: PROTO_MAX,
  frameLossRate: 0,
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
      case 'hist.query':
        this.#error('E_UNAVAILABLE', true, { detail: 'history not implemented in sim' }, id)
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
      [FID.MODE]: 1,
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
      [FID.MODE]: 1,
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

    // The echo of a requested value is never confirmation. Real confirmation
    // is the driver reading the value back, which may simply not happen.
    if (this.faults.neverConfirm) return

    const value = typeof cmd.args['watts'] === 'number' ? cmd.args['watts'] : 0
    this.#cmdResult(cmd.cmdId, 'applied', undefined, {
      value,
      src: SRC.BATTERY,
      uptimeMs: this.uptimeMs,
    })
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
