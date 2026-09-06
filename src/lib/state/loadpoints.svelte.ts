/* The charger, as the panel sees it.
 *
 * Current boxes report status and charge windows together on `/api/loadpoints`.
 * Older boxes need a separate plan read. The current path avoids that extra
 * request so a slow full plan cannot hold up the five-second charger poll.
 */

import { callBox, BoxApiError } from './box-api'
import { refreshCharging } from './charging-watch'
import { commandHelp, boostHelp, socHelp } from '$lib/format/command'
import {
  toLoadpoint,
  chargeCurrent,
  ampsToWatts,
  type Loadpoint,
  type WireLoadpoint,
} from '$lib/format/ev'
import {
  OP_LOADPOINT_HOLD,
  OP_LOADPOINT_BOOST,
  OP_LOADPOINT_SOC_SET,
  OP_LOADPOINT_SURPLUS_ONLY_SET,
  type CmdResult,
} from '$lib/protocol/messages'
import { CommandError } from '$lib/protocol/session'
import type { SiteStore } from './site.svelte'

/** One stretch the optimiser intends to charge in. */
export interface ChargeWindow {
  fromMs: number
  toMs: number
  /** The plan's peak for the window, in watts. */
  peakW: number | null
  /** Current boxes report window energy, not peak power. Never infer a peak. */
  energyWh?: number
  /** The box's own reason token for the window's first slot. */
  reason: string
}

interface WireAction {
  slot_start_ms?: unknown
  slot_len_min?: unknown
  reason?: unknown
  loadpoint_power_w?: Record<string, unknown>
}

/**
 * Contiguous plan slots where a charger draws, folded into windows.
 *
 * Adjacent charging slots merge regardless of reason — a person asks "when
 * will it charge", not "when does the reason change" — and the first slot's
 * reason names the window. Slots the plan does not price or does not know
 * the charger in contribute nothing, which quietly carries the box that is
 * mid-replan.
 */
export function chargeWindows(actions: WireAction[], loadpointId: string): ChargeWindow[] {
  const out: ChargeWindow[] = []
  for (const a of actions) {
    const start = typeof a.slot_start_ms === 'number' ? a.slot_start_ms : null
    const len = typeof a.slot_len_min === 'number' ? a.slot_len_min : null
    const w = a.loadpoint_power_w?.[loadpointId]
    if (start === null || len === null || typeof w !== 'number' || w <= 0) continue

    const endMs = start + len * 60_000
    const last = out[out.length - 1]
    if (last && start <= last.toMs) {
      last.toMs = endMs
      last.peakW = Math.max(last.peakW ?? 0, w)
    } else {
      out.push({
        fromMs: start,
        toMs: endMs,
        peakW: w,
        reason: typeof a.reason === 'string' ? a.reason : '',
      })
    }
  }
  return out
}

/** Windows from the same snapshot as the charger's status. */
function inlineWindows(lp: WireLoadpoint): ChargeWindow[] {
  if (lp.plan_pending === true || lp.plan_outdated === true || !Array.isArray(lp.plan_windows)) return []
  return lp.plan_windows.flatMap(w => {
    if (!w || typeof w !== 'object' ||
      typeof w.start_ms !== 'number' || !Number.isFinite(w.start_ms) ||
      typeof w.end_ms !== 'number' || !Number.isFinite(w.end_ms) || w.end_ms <= w.start_ms ||
      typeof w.wh !== 'number' || !Number.isFinite(w.wh) || w.wh < 0) return []
    return [{ fromMs: w.start_ms, toMs: w.end_ms, peakW: null, energyWh: w.wh, reason: '' }]
  })
}

/** Which control on the panel a command belongs to, so its outcome lands under it. */
export type Control = 'hold' | 'boost' | 'soc' | 'surplus'

/** What an applied command did, for the one sentence that says so. */
export type Outcome =
  | 'hold'
  | 'release'
  | 'pause'
  | 'boost'
  | 'unboost'
  | 'soc'
  | 'surplus_on'
  | 'surplus_off'

export class LoadpointsStore {
  /** Every charger the box reported. Empty until an answer lands. */
  points = $state.raw<Loadpoint[]>([])

  /** The optimiser's coming charge windows, per charger id. */
  windows = $state.raw<Record<string, ChargeWindow[]>>({})

  /**
   * True when the plan read failed while the charger read succeeded. The
   * panel says the windows are missing rather than pretending an empty plan
   * means an idle week.
   */
  planMissing = $state(false)
  /** The box is calculating a new plan; previous windows cannot confirm it. */
  planPending = $state(false)
  planOutdated = $state(false)

  /** True only while waiting on the box. Whatever is drawn stays drawn. */
  loading = $state(false)

  /** Whether the box has ever answered. Absence of an answer is not an empty bay. */
  loaded = $state(false)

  /** Age of the charger read, independent of the house power stream. */
  readAt = $state<number | null>(null)

  /** A sentence, never a code. Null when there is nothing to say. */
  error = $state<string | null>(null)

  /**
   * The fate of the last charge command, for the panel to say honestly.
   *
   * The setMode lifecycle, borrowed whole: `sending` while the door is
   * asked, `applied` when the charger read back, `unconfirmed` when the box
   * took it and the hardware has not said so, `failed` with a sentence.
   * It settles back to idle on its own so a stale outcome does not sit on
   * screen for the life of the panel.
   */
  command = $state<
    | { kind: 'idle' }
    | { kind: 'sending'; of: Control }
    | { kind: 'applied'; of: Control; did: Outcome }
    | { kind: 'unconfirmed'; of: Control }
    | { kind: 'failed'; of: Control; help: string }
  >({ kind: 'idle' })

  commandLpId = $state<string | null>(null)
  /** Applied choices remain visible until a later charger read confirms state. */
  acceptedSoc = $state.raw<Record<string, { value: number }>>({})
  acceptedSurplus = $state.raw<Record<string, { value: boolean }>>({})

  #site: SiteStore
  /** Guards a slow answer against a panel that already asked again. */
  #token = 0
  #chargerRead: Promise<void> | null = null
  #fullRead: Promise<void> | null = null
  #inlinePlan = false
  #settle: ReturnType<typeof setTimeout> | null = null

  constructor(site: SiteStore) {
    this.#site = site
  }

  destroy(): void {
    if (this.#settle) clearTimeout(this.#settle)
    this.#settle = null
  }

  /**
   * Charge now: a persistent manual hold at a chosen current.
   *
   * The same body the box's own page posts to `manual_hold`: the watts for
   * the amps, `hold_s: 0` for a hold that only Stop or an unplug releases,
   * and the phase mode the charger is wired for. The box revalidates against
   * fresh state and answers; nothing here pretends. On any settled outcome
   * the charger is reread, because a hold changes what `/api/loadpoints`
   * says and the panel must say the same.
   */
  async chargeNow(lp: Loadpoint, amps: number): Promise<void> {
    await this.#send(
      OP_LOADPOINT_HOLD,
      {
        id: lp.id,
        power_w: ampsToWatts(lp, amps),
        hold_s: 0,
        phase_mode: chargeCurrent(lp).phases === 1 ? '1p' : '3p',
      },
      'hold',
      'hold',
      commandHelp
    )
  }

  async pauseCharging(lp: Loadpoint): Promise<void> {
    await this.#send(OP_LOADPOINT_HOLD, { id: lp.id, power_w: 0, hold_s: 0 }, 'hold', 'pause', commandHelp)
  }

  /** Release the hold. The plan takes back over. */
  async stopCharging(lp: Loadpoint): Promise<void> {
    await this.#send(OP_LOADPOINT_HOLD, { id: lp.id, clear: true }, 'hold', 'release', commandHelp)
  }

  /**
   * Boost: let the house battery push the car for a bounded while.
   *
   * The lease by the box's own names — a floor for the house battery in
   * whole percent and a duration in seconds. The box caps a lease at four
   * hours, and refuses one the live site cannot carry: a manual hold
   * running, the charger on spare solar only, the battery out of reach.
   */
  async boost(lp: Loadpoint, reservePct: number, durationS: number): Promise<void> {
    await this.#send(
      OP_LOADPOINT_BOOST,
      { id: lp.id, min_battery_soc_pct: reservePct, duration_s: durationS },
      'boost',
      'boost',
      boostHelp
    )
  }

  /** Withdraw the boost. The house battery is the plan's again. */
  async stopBoost(lp: Loadpoint): Promise<void> {
    await this.#send(OP_LOADPOINT_BOOST, { id: lp.id, cancel: true }, 'boost', 'unboost', boostHelp)
  }

  /**
   * Correct the car's charge level.
   *
   * Whole percent from the slider, the wire's 0–1 fraction to the box — the
   * same re-anchor its own page posts to `soc`. The box applies the level,
   * starts a replan and answers. A car that is not on the cable is
   * refused by name, and `socHelp` says so.
   */
  async setSoc(lp: Loadpoint, pct: number): Promise<void> {
    await this.#send(OP_LOADPOINT_SOC_SET, { id: lp.id, soc: pct / 100 }, 'soc', 'soc', socHelp)
  }

  /** Charge from spare solar only, or let the grid and the house battery back in. */
  async setSurplusOnly(lp: Loadpoint, on: boolean): Promise<void> {
    await this.#send(
      OP_LOADPOINT_SURPLUS_ONLY_SET,
      { id: lp.id, surplus_only: on },
      'surplus',
      on ? 'surplus_on' : 'surplus_off',
      commandHelp
    )
  }

  async #send(
    op: string,
    args: Record<string, unknown>,
    of: Control,
    did: Outcome,
    help: (result: CmdResult) => string
  ): Promise<void> {
    if (this.command.kind === 'sending') return
    if (this.#settle) clearTimeout(this.#settle)
    this.commandLpId = typeof args.id === 'string' ? args.id : null
    this.command = { kind: 'sending', of }

    try {
      const result: CmdResult = await this.#site.command(op, args)
      switch (result.state) {
        case 'applied':
          this.command = { kind: 'applied', of, did }
          if (typeof args.id === 'string') {
            if (of === 'soc' && typeof args.soc === 'number') {
              this.acceptedSoc = { ...this.acceptedSoc, [args.id]: { value: Math.round(args.soc * 100) } }
            }
            if (of === 'surplus' && typeof args.surplus_only === 'boolean') {
              this.acceptedSurplus = { ...this.acceptedSurplus, [args.id]: { value: args.surplus_only } }
            }
          }
          break
        case 'unconfirmed':
          this.command = { kind: 'unconfirmed', of }
          break
        default:
          this.command = { kind: 'failed', of, help: help(result) }
      }
    } catch (err) {
      this.command = {
        kind: 'failed',
        of,
        help: err instanceof CommandError ? err.help : "FTW did not confirm the request. Reading its current state…",
      }
    }

    // Keep a refusal or an uncertain result visible until the next action.
    if (this.command.kind === 'applied') {
      this.#settle = setTimeout(() => {
        this.command = { kind: 'idle' }
        this.#settle = null
      }, 6_000)
    }

    // Whatever the outcome, the box's account of the charger is the truth
    // to repaint from — even a refusal can follow a change someone else
    // made. A failed reread keeps the sentence already on screen. Awaited,
    // so a caller holding a draft against the box's value knows when the
    // box's own value is the one on screen and can let go of the draft.
    if (this.#chargerRead) await this.#chargerRead.catch(() => {})
    await this.loadChargers().catch(() => {})
    refreshCharging(this.#site)
  }

  /**
   * Ask the box, and keep whatever is on screen until a better answer comes.
   *
   * Rejects when the charger read failed, because the caller that heals this
   * has no other way to tell an answer from a swallowed failure. A failed
   * plan read alone does not reject — it is noted and the ask succeeded.
   */
  /**
   * The chargers, without the plan decoration.
   *
   * Now uses this so the live diagram can split the car from the house even
   * when field 10 on the stream is still idle. The panel's load() asks for
   * the plan too; that is decoration, and a live overlay must not wait on it.
   */
  async loadChargers(): Promise<void> {
    if (this.#chargerRead) return this.#chargerRead
    this.#chargerRead = this.#readChargers()
    try { await this.#chargerRead } finally { this.#chargerRead = null }
  }

  async #readChargers(): Promise<void> {
    const token = ++this.#token
    // A read started before a command cannot confirm that command's choice.
    const socChoices = this.acceptedSoc
    const surplusChoices = this.acceptedSurplus
    this.loading = true

    try {
      const wire = await callBox<{ enabled?: boolean; loadpoints?: WireLoadpoint[] }>(this.#site, {
        method: 'GET',
        path: '/api/loadpoints',
      })
      if (token !== this.#token) return

      const points = wire.loadpoints ?? []
      this.points = points.map(toLoadpoint)
      this.#inlinePlan = points.every(lp =>
        (typeof lp.plan_pending === 'boolean' && typeof lp.plan_outdated === 'boolean') || Array.isArray(lp.plan_windows))
      if (this.#inlinePlan) {
        this.planPending = this.points.some(lp => lp.planPending)
        this.planOutdated = this.points.some(lp => lp.planOutdated)
        this.windows = Object.fromEntries(points.map(lp => [typeof lp.id === 'string' ? lp.id : '', inlineWindows(lp)]))
        this.planMissing = false
      } else {
        this.windows = Object.fromEntries(Object.entries(this.windows).filter(([id]) => {
          const lp = this.points.find(point => point.id === id)
          return !lp?.planPending && !lp?.planOutdated
        }))
      }
      this.acceptedSoc = Object.fromEntries(Object.entries(this.acceptedSoc).filter(([id, choice]) => choice !== socChoices[id]))
      this.acceptedSurplus = Object.fromEntries(Object.entries(this.acceptedSurplus).filter(([id, choice]) => choice !== surplusChoices[id]))
      this.loaded = true
      this.readAt = Date.now()
      this.error = null
    } catch (err) {
      if (token !== this.#token) return
      this.error =
        err instanceof BoxApiError
          ? this.points.length > 0
            ? 'Not up to date — your box is out of reach'
            : err.help
          : 'Not up to date — your box is out of reach'
      throw err
    } finally {
      if (token === this.#token) this.loading = false
    }
  }

  async load(force = false): Promise<void> {
    if (this.#fullRead) {
      await this.#fullRead.catch(() => {})
      if (!force) return
    }
    if (force && this.#chargerRead) await this.#chargerRead.catch(() => {})
    this.#fullRead = this.#readAll()
    try { await this.#fullRead } finally { this.#fullRead = null }
  }

  async #readAll(): Promise<void> {
    await this.loadChargers()
    if (this.#inlinePlan) return

    // The decoration, after the panel is safe. Its failure is a note.
    const token = this.#token
    try {
      const wire = await callBox<{
        plan?: { actions?: WireAction[] }
        meta?: { replanning?: boolean; outdated?: boolean }
      }>(this.#site, { method: 'GET', path: '/api/mpc/plan' })
      if (token !== this.#token) return

      const actions = wire.plan?.actions ?? []
      this.planPending = wire.meta?.replanning === true
      this.planOutdated = wire.meta?.outdated === true
      const windows: Record<string, ChargeWindow[]> = {}
      for (const lp of this.points) windows[lp.id] = this.planPending || this.planOutdated || lp.planPending || lp.planOutdated ? [] : chargeWindows(actions, lp.id)
      this.windows = windows
      this.planMissing = false
    } catch {
      if (token !== this.#token) return
      this.planMissing = true
    }
  }
}
