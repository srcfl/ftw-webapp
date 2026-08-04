/* The reactive bridge between the session and the views.
 *
 * The session owns protocol state; this exposes it to Svelte and derives the
 * few things the UI actually asks for. Nothing above this touches a frame,
 * and nothing below it knows a component exists.
 *
 * Field cells are held in one map rather than one signal per reading. At 1 Hz
 * with a handful of fields the difference is not performance — it is that a
 * single map keeps the whole snapshot consistent within a frame, so the UI
 * can never paint grid power from one second beside solar from the next.
 */

import { Session, type SessionState } from '$lib/protocol/session'
import type { Carrier } from '$lib/carrier/carrier'
import { explain, FID, type Explanation } from '$lib/format/explanation'
import type { CarrierState, SourceState } from '$lib/protocol/types'

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

  /** Raw session state. Replaced wholesale, so views re-read consistently. */
  session = $state<SessionState>(new Session({ build: 'boot' }).state)

  /** Import ceiling the optimiser defends. Comes from the box once wired. */
  ceilingW = $state<number | null>(null)

  constructor(build: string) {
    this.#session = new Session({ build })
    this.#unsub = this.#session.subscribe((s) => {
      this.session = s
    })
  }

  get paired(): boolean {
    return this.session.box !== null
  }

  get carrier(): CarrierState {
    return this.session.carrier
  }

  /** Worst state across the sources this screen depends on. */
  get srcState(): SourceState {
    return this.#session.worstSourceState(NOW_SOURCES)
  }

  /** Age of the oldest reading on screen, in ms. NaN when there is none. */
  get ageMs(): number {
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

  /** Battery charge as whole percent, or null when there is no battery. */
  get socPercent(): number | null {
    const permille = this.session.fields.get(FID.BATTERY_SOC)
    return permille === undefined ? null : Math.round(permille / 10)
  }

  connect(carrier: Carrier): void {
    this.#session.connect(carrier)
  }

  destroy(): void {
    this.#unsub?.()
    this.#unsub = null
    this.#session.close()
  }
}
