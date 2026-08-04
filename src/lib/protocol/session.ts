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

import { encodeFrame, decodeFrame, LANE_CONTROL, FrameError } from './frame'
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
} from './messages'
import type { Carrier } from '$lib/carrier/carrier'
import type { CarrierState, Fid, Source, SourceState } from './types'

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
}

const EMPTY: SessionState = {
  phase: 'idle',
  carrier: 'none',
  proto: PROTO_MAX,
  mode: 'full',
  caps: new Set(),
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
}

export interface SessionOptions {
  build: string
  locales?: string[]
  sub?: Sub
}

export class Session {
  #state: SessionState = EMPTY
  #carrier: Carrier | null = null
  #unsub: (() => void)[] = []
  #opts: SessionOptions
  #listeners = new Set<(s: SessionState) => void>()
  #lastSeq = 0
  #bucket: 256 | 512 = 512

  constructor(opts: SessionOptions) {
    this.#opts = opts
    this.#bucket = opts.sub?.bucket ?? 512
  }

  get state(): SessionState {
    return this.#state
  }

  subscribe(listener: (s: SessionState) => void): () => void {
    this.#listeners.add(listener)
    listener(this.#state)
    return () => this.#listeners.delete(listener)
  }

  /** Attach a carrier and start the handshake. Replaces any current one. */
  connect(carrier: Carrier): void {
    this.#detach()
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

  /** Age of a source's last successful reading, in ms of box uptime. */
  ageOf(srcId: string): number {
    const src = this.#state.sources.get(srcId)
    if (!src) return NaN
    return Math.max(0, this.#state.uptimeMs - src.lastOkMs)
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

  #sendHello(): void {
    this.#send({
      t: 'hello',
      b: {
        proto: { min: PROTO_MIN, max: PROTO_MAX },
        app: { build: this.#opts.build, ua: 'pwa' as const },
        locales: this.#opts.locales ?? ['en'],
      },
    })
  }

  #onFrame(bytes: Uint8Array): void {
    let envelope
    try {
      envelope = decodeFrame(bytes).envelope
    } catch (err) {
      // A frame we cannot parse is not a reason to tear down a working
      // session — the next one may be fine.
      if (err instanceof FrameError) return
      throw err
    }

    switch (envelope.t) {
      case 'hello_ok':
        this.#onHelloOk(envelope.b as HelloOk)
        break
      case 'snap':
        this.#onSnap(envelope.b as Snap)
        break
      case 'delta':
        this.#onDelta(envelope.b as DeltaMsg)
        break
      case 'tick':
        this.#onTick(envelope.b as Tick)
        break
      case 'error':
        this.#onError(envelope.b as ErrorMsg)
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
    this.#patch({
      proto: b.proto,
      mode: b.mode,
      caps: new Set(b.caps),
      box: b.box,
      uptimeMs: b.clock.uptimeMs,
      boot: b.boot ?? null,
      needsUpdate: b.hint === 'app_update' || b.proto === PROTO_FLOOR,
    })

    if (b.mode === 'booting') {
      // Nothing to subscribe to yet. The box will accept one once it is up;
      // the caller retries rather than the session spinning silently.
      this.#patch({ phase: 'booting' })
      return
    }

    this.#patch({ phase: 'subscribing' })
    this.#send({ t: 'sub', b: this.#opts.sub ?? { bucket: this.#bucket, hz: 1 } })
  }

  #onSnap(b: Snap): void {
    const fields = new Map<Fid, number>()
    for (const [fid, v] of Object.entries(b.fields)) fields.set(Number(fid), v)

    this.#patch({
      phase: 'streaming',
      uptimeMs: b.uptimeMs,
      controlRev: b.controlRev,
      dict: b.dict,
      fields,
      sources: toSourceMap(b.sources),
      dispatchBlockedBy: b.dispatchBlockedBy,
    })
    this.#lastSeq = 0
  }

  #onDelta(b: DeltaMsg): void {
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
      ...(b.sources ? { sources: toSourceMap(b.sources) } : {}),
      ...(b.dispatchBlockedBy ? { dispatchBlockedBy: b.dispatchBlockedBy } : {}),
    })
  }

  #onTick(b: Tick): void {
    this.#lastSeq = b.seq
    this.#patch({ uptimeMs: b.uptimeMs })
  }

  #onError(b: ErrorMsg): void {
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

  #detach(): void {
    for (const u of this.#unsub) u()
    this.#unsub = []
    this.#carrier?.close()
    this.#carrier = null
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
