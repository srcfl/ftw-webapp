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
import type { Fid } from '$lib/protocol/types'
import type { Plan, PriceQuery, Prices, CmdResult, Guard } from '$lib/protocol/messages'
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

/**
 * Fields the Now view draws. Their sources drive the freshness band.
 *
 * Field ids, not source ids. A source id is the box's name for one of its own
 * drivers — `sungrow`, `easee` — and it comes from the configuration of the
 * house, so nothing here can know it. The box says which source is behind
 * which field in the dictionary it sends with every snapshot, and that is the
 * only place to read it from.
 */
const NOW_FIDS: readonly Fid[] = [
  FID.GRID_W,
  FID.PV_W,
  FID.BATTERY_W,
  FID.BATTERY_SOC,
  FID.LOAD_W,
  FID.EV_W,
]

/**
 * The sources behind the readings on the Now view, named by the box.
 *
 * Two kinds of field contribute nothing. One with no value has nothing on
 * screen to be fresh or stale about. One with no source — the mode is the
 * box's own state, and the charger sum can come from several drivers — has no
 * freshness of its own; the box sends a null srcId to say exactly that.
 *
 * A device the view does not draw is not here either. A heat pump that has
 * gone offline is a real fault and it is not a fault in anything on this
 * screen, so it must not make the band condemn the whole house.
 */
function nowSourceIds(s: SessionState): string[] {
  const ids = new Set<string>()
  for (const fid of NOW_FIDS) {
    if (!s.fields.has(fid)) continue
    const srcId = s.dict[String(fid)]?.srcId
    if (srcId) ids.add(srcId)
  }
  return [...ids]
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
      // What counts as a reading arriving, and what only looks like one.
      //
      // A moved uptime is the sign a frame carries: ticks carry it even when
      // nothing else changed, which is why they exist. But two other things
      // move it and carry no reading at all. Restoring the cache moves it
      // from nothing to whatever was on disk. Answering hello moves it from
      // the box's clock, before a single value has been sent — and a box can
      // answer hello and then go quiet for an hour, boot for ten minutes, or
      // refuse this device outright.
      //
      // Counting either would date the readings on screen from the moment
      // they were displayed rather than from the box that sent them, and
      // would let the band say "live" over a house two hours old with the
      // age suppressed. Only a streaming session is a reading arriving.
      // Entering the stream is itself the first reading: the snapshot that
      // starts it carries the same uptime hello just announced, so waiting for
      // that number to move would miss the moment the readings became the
      // box's own.
      if (
        s.phase === 'streaming' &&
        (this.session.phase !== 'streaming' || s.uptimeMs !== this.session.uptimeMs)
      ) {
        this.#lastFrameAtMs = Date.now()
      }
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

  /** What electricity costs across a window. */
  prices(query: PriceQuery): Promise<Prices> {
    return this.#session.prices(query)
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

  /**
   * How the readings ON SCREEN are reaching us — not which socket is open.
   *
   * The session claims its carrier the moment the socket opens, which is
   * before hello has been answered and long before a reading has arrived. A
   * phone launching from cache would then show a two-hour-old house under
   * "Live via encrypted relay", with the age suppressed because the band
   * hides it while live. That is the one thing this app must never do, and
   * an open socket is not evidence of anything: the box may be booting, wedged
   * or refusing this device.
   *
   * So a carrier is claimed once it has actually delivered a reading. An
   * answered handshake is not one: a box can answer hello and then boot for
   * ten minutes. Until a reading arrives, what is on screen is the cache, and
   * the band says "Reaching your box" over an honest age.
   */
  get carrier(): CarrierState {
    if (this.#lastFrameAtMs === null) {
      return this.cachedAtMs !== null ? 'cache' : 'none'
    }
    return this.session.carrier
  }

  get srcState(): SourceState {
    // Nothing has arrived, from the box or from the cache. That is "no
    // reading yet" literally, and it is the only state that sentence belongs
    // to — a box whose readings are on screen is never it, however its
    // drivers happen to be named.
    if (this.session.fields.size === 0) return 'never'

    // Nothing has arrived on this session, so every source state below was
    // read off the disk: true when it was written, and not a claim about now.
    // The carrier says 'cache' in the same breath and the band puts the age
    // back on screen.
    if (this.#lastFrameAtMs === null) return 'stale'

    const ids = nowSourceIds(this.session)
    // A box that names no source for anything on screen must not be taken
    // for a healthy one: worstSourceState starts at 'live' and an empty list
    // never enters its loop, so silence would read as all clear. Judge by
    // every source the box does report instead, and only when it reports
    // none at all is the stream itself the freshness.
    const worst =
      ids.length > 0
        ? this.#session.worstSourceState(ids)
        : this.session.sources.size > 0
          ? this.#session.worstSourceState([...this.session.sources.keys()])
          : 'live'

    // Every source state above was read off the last frame. If frames have
    // stopped, so has that judgement — a stream that has gone quiet is not
    // live however healthy it looked when it went. Saying 'lagging' is what
    // puts the age back on screen, which is the fact being asked for.
    if (worst === 'live' && this.sinceLastFrameMs > 0) return 'lagging'
    return worst
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
    if (this.carrier === 'cache' && this.cachedAtMs !== null) {
      return Date.now() - this.cachedAtMs
    }
    const ages = nowSourceIds(this.session)
      .map((s) => this.#session.ageOf(s))
      .filter((a) => !Number.isNaN(a))
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
