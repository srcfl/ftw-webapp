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
import type { Plan, CmdResult, Guard } from '$lib/protocol/messages'
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
  /** Wall clock when the last frame arrived. Null until one does. */
  #lastFrameAtMs = $state<number | null>(null)

  session = $state<SessionState>(new Session({ build: 'boot' }).state)

  /** Wall-clock time the cached view was captured. Null when live. */
  cachedAtMs = $state<number | null>(null)

  /** Import ceiling the optimiser defends. Comes from the box once wired. */
  ceilingW = $state<number | null>(null)

  constructor(build: string) {
    this.#session = new Session({ build })
    this.#unsub = this.#session.subscribe((s) => {
      // A moved uptime is the one reliable sign that a frame arrived: ticks
      // carry it even when nothing else changed, which is why they exist.
      if (s.uptimeMs !== this.session.uptimeMs) this.#lastFrameAtMs = Date.now()
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

    this.#ticker ??= setInterval(() => (this.#now = Date.now()), 1_000)
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

  /** What the box intends to do. */
  plan(): Promise<Plan> {
    return this.#session.plan()
  }

  /**
   * Express an intent and wait for what actually happened.
   *
   * Resolves with the outcome including 'unconfirmed' — the box accepted it
   * but the hardware never reported back — because that is an answer the UI
   * has to be able to give, not an error to swallow.
   */
  command(op: string, args: Record<string, unknown>, guards: Guard[] = []): Promise<CmdResult> {
    return this.#session.command(op, args, guards).promise
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
    if (ages.length === 0) return NaN

    // The box's own uptime says how old a reading was when it was sent. It
    // says nothing about how long ago that was — so while frames are arriving
    // the two agree, and the moment they stop the number freezes exactly when
    // it most needs to move. A phone in a tunnel would show "readings 4s ago"
    // an hour later. Wall clock since the last frame is added for that, and it
    // is zero while the stream is live.
    return Math.max(...ages) + this.sinceLastFrameMs
  }

  /**
   * Wall-clock milliseconds since a frame last arrived, or 0 while streaming.
   *
   * Wall clock is the wrong instrument for a reading's age and the right one
   * for "how long since we last heard anything" — which is a question about
   * this phone, not about the box.
   */
  get sinceLastFrameMs(): number {
    const at = this.#lastFrameAtMs
    if (at === null) return 0
    const since = this.#now - at
    // A 1 Hz stream is always a fraction of a second behind its last frame.
    // Reporting that would make a healthy view flicker between "now" and "1s
    // ago" forever, which reads as a fault where there is none. Past a couple
    // of beats the silence is real and every millisecond of it counts.
    if (since < 3_000) return 0
    return since
  }

  /**
   * A clock the views can depend on.
   *
   * Ages are derived, so without something that changes they would sit still
   * on screen while the world moved — the freezing this fix is about. One
   * timer for the whole app, at the coarsest rate the display can show.
   */
  #now = $state(Date.now())
  #ticker: ReturnType<typeof setInterval> | null = null

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
    if (this.#ticker !== null) {
      clearInterval(this.#ticker)
      this.#ticker = null
    }
    this.#writer.stop()
    this.#unsub?.()
    this.#unsub = null
    this.#session.close()
  }
}
