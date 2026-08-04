/* The reactive bridge between the session and the views.
 *
 * The session owns protocol state; this exposes it to Svelte, restores the
 * cached snapshot on start, and derives the few things the UI asks for.
 * Nothing above this touches a frame; nothing below it knows a component
 * exists.
 *
 * Field cells are held in one map rather than one signal per reading. At 1 Hz
 * with a handful of fields the difference is not performance — it is that a
 * single map keeps the whole snapshot consistent within a frame, so the UI
 * can never paint grid power from one second beside solar from the next.
 */

import { Session, type SessionState } from '$lib/protocol/session'
import type { HistQuery, HistChunk, HistEnd } from '$lib/protocol/messages'
import type { Carrier } from '$lib/carrier/carrier'
import { explain, FID, type Explanation } from '$lib/format/explanation'
import type { CarrierState, SourceState } from '$lib/protocol/types'
import {
  takeBootSnapshot,
  loadSnapshot,
  sessionPatchFromSnapshot,
  snapshotFromSession,
  SnapshotWriter,
} from '$lib/store/snapshot'
import { requestPersistence } from '$lib/store/db'

/** Sources the Now view depends on. Drives the freshness band. */
const NOW_SOURCES = ['meter.p1', 'inverter.sungrow', 'battery.sungrow'] as const

export interface Reading {
  label: string
  fid: number
  watts: number | undefined
  tone: 'import' | 'generation' | 'storage' | 'load'
  srcId: string | null
}

export class SiteStore {
  #session: Session
  #unsub: (() => void) | null = null
  #writer = new SnapshotWriter()
  #siteId: string | null = null
  #markedLive = false

  session = $state<SessionState>(new Session({ build: 'boot' }).state)

  /** Wall-clock time the cached view was captured. Null when live. */
  cachedAtMs = $state<number | null>(null)

  /** Import ceiling the optimiser defends. Comes from the box once wired. */
  ceilingW = $state<number | null>(null)

  constructor(build: string) {
    this.#session = new Session({ build })
    this.#unsub = this.#session.subscribe((s) => {
      this.session = s

      if (s.phase === 'streaming') {
        if (this.cachedAtMs !== null || !this.#markedLive) {
          this.#markedLive = true
          performance.mark('ftw:live-data')
        }
        this.cachedAtMs = null
        if (this.#siteId) this.#writer.offer(snapshotFromSession(this.#siteId, s))
      }
    })
  }

  /**
   * Paint from cache, then connect.
   *
   * Deliberately not awaited by the caller before mounting: the shell renders
   * immediately either way, and this fills it in a frame or two later. The
   * read itself was already started by the inline script in index.html.
   */
  async start(siteId: string): Promise<void> {
    this.#siteId = siteId

    const cached = (await takeBootSnapshot()) ?? (await loadSnapshot(siteId))
    if (cached) {
      this.#session.restore(sessionPatchFromSnapshot(cached))
      this.cachedAtMs = cached.savedAtMs

      // The number that decides whether this feels like an app. Marked rather
      // than logged so it survives in real sessions and can be read from the
      // Performance timeline on a real phone, not just in development.
      performance.mark('ftw:first-data', { detail: { source: 'cache' } })
    }

    // Asked for after the first paint, never before — the prompt is not on
    // the critical path and some browsers show UI for it.
    void requestPersistence()
  }

  get siteId(): string | null {
    return this.#siteId
  }

  /**
   * Ask the box for a history window.
   *
   * Delegated rather than exposing the session, so the rule above still holds:
   * nothing above this layer touches a frame.
   */
  history(query: HistQuery, onChunk: (chunk: HistChunk) => void): Promise<HistEnd> {
    return this.#session.history(query, onChunk)
  }

  get paired(): boolean {
    return this.session.box !== null || this.session.fields.size > 0
  }

  get carrier(): CarrierState {
    return this.session.carrier
  }

  get srcState(): SourceState {
    return this.#session.worstSourceState(NOW_SOURCES)
  }

  /**
   * Age of the oldest reading on screen, in ms.
   *
   * While live this is measured against the box's uptime. While showing
   * cache there is no live uptime to compare against, so it falls back to
   * how long ago the snapshot was written — which is the honest answer to
   * the question the user is actually asking.
   */
  get ageMs(): number {
    if (this.session.carrier === 'cache' && this.cachedAtMs !== null) {
      return Date.now() - this.cachedAtMs
    }
    const ages = NOW_SOURCES.map((s) => this.#session.ageOf(s)).filter((a) => !Number.isNaN(a))
    return ages.length > 0 ? Math.max(...ages) : NaN
  }

  get explanation(): Explanation {
    return explain({
      fields: this.session.fields,
      dispatchBlockedBy: this.session.dispatchBlockedBy,
      ceilingW: this.ceilingW,
    })
  }

  get readings(): Reading[] {
    const f = this.session.fields
    return [
      { label: 'Grid', fid: FID.GRID_W, watts: f.get(FID.GRID_W), tone: 'import', srcId: 'meter.p1' },
      { label: 'Solar', fid: FID.PV_W, watts: f.get(FID.PV_W), tone: 'generation', srcId: 'inverter.sungrow' },
      { label: 'Battery', fid: FID.BATTERY_W, watts: f.get(FID.BATTERY_W), tone: 'storage', srcId: 'battery.sungrow' },
      { label: 'House', fid: FID.LOAD_W, watts: f.get(FID.LOAD_W), tone: 'load', srcId: 'meter.p1' },
    ]
  }

  get socPercent(): number | null {
    const permille = this.session.fields.get(FID.BATTERY_SOC)
    return permille === undefined ? null : Math.round(permille / 10)
  }

  connect(carrier: Carrier): void {
    this.#session.connect(carrier)
  }

  /** Persist before the page can be discarded. */
  async persistNow(): Promise<void> {
    await this.#writer.flushNow()
  }

  destroy(): void {
    this.#writer.stop()
    this.#unsub?.()
    this.#unsub = null
    this.#session.close()
  }
}
