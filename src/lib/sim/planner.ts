/* A planner that makes decisions worth explaining.
 *
 * Not the real optimiser — that lives on the box and solves a proper problem.
 * This produces the same *shape* of answer so the app can be built against
 * it: slots with a battery target, an expected grid flow, and a reason the
 * app can turn into a sentence.
 *
 * The reasons are the point. A plan whose every slot says "optimised" gives
 * the UI nothing to say, and the difference between this app and a graph is
 * whether it can tell you why the battery is doing what it is doing.
 */

import type { Plan, PlanSlot, PlanReason, SiteMode } from '$lib/protocol/messages'
import { sample, type HouseConfig } from './energy'

export const SLOT_MS = 900_000 // 15 minutes, matching the box's settlement slot
const HORIZON_SLOTS = 96 // a day ahead

/**
 * A day-ahead price curve, in minor units per kWh.
 *
 * Two peaks and a night trough, which is what a Nordic day looks like and
 * what makes a plan interesting: there is something to shift.
 */
function priceAt(hourOfDay: number): number {
  const morning = 90 * Math.exp(-((hourOfDay - 7.5) ** 2) / 3)
  const evening = 130 * Math.exp(-((hourOfDay - 18) ** 2) / 4)
  const base = 45 + 12 * Math.sin((hourOfDay / 24) * 2 * Math.PI)
  return Math.round(base + morning + evening)
}

export interface PlanInput {
  house: HouseConfig
  mode: SiteMode
  nowMs: number
  uptimeMs: number
  socPermille: number
  ceilingW: number
  rev: number
  /** The planner could not run; the box is on its fallback. */
  stale?: boolean
}

export function buildPlan(input: PlanInput): Plan {
  const { house, mode, nowMs, ceilingW } = input

  // Slots align to the wall clock, not to now — a plan that starts at 14:03
  // reads as an implementation detail leaking into the product.
  const start = Math.floor(nowMs / SLOT_MS) * SLOT_MS
  const slots: PlanSlot[] = []

  let soc = input.socPermille

  for (let i = 0; i < HORIZON_SLOTS; i++) {
    const at = start + i * SLOT_MS
    const hour = new Date(at).getUTCHours() + new Date(at).getUTCMinutes() / 60
    const price = priceAt(hour)

    const reading = sample(house, at, soc, ceilingW)
    const surplus = reading.pvW - reading.loadW

    // What each mode is allowed to do, straight from FTW's own descriptions
    // in control.ModeCatalog(). Getting these wrong would produce a plan that
    // is plausible and false, which is worse than no plan.
    const plans = mode.startsWith('planner_')
    const mayGridCharge = mode === 'planner_cheap' || mode === 'planner_passive_arbitrage' || mode === 'planner_arbitrage'
    const mayExportFromBattery = mode === 'planner_arbitrage'

    let batteryW = 0
    let reason: PlanReason = 'idle'

    if (mode === 'idle') {
      // No dispatch at all. Saying that plainly beats an empty timeline that
      // looks like a failure.
      reason = 'idle'
    } else if (mode === 'charge') {
      batteryW = soc < 995 ? house.batteryMaxChargeW : 0
      reason = soc < 995 ? 'cheap_import' : 'idle'
    } else if (mode === 'peak_shaving') {
      const over = reading.loadW - reading.pvW - ceilingW
      batteryW = over > 0 && soc > 100 ? -Math.min(over, house.batteryMaxChargeW) : 0
      reason = batteryW < 0 ? 'peak_shaving' : 'idle'
    } else if (mode === 'self_consumption') {
      // Manual: chases a grid target with no plan, so the honest thing to
      // show ahead is spare solar and nothing else.
      batteryW = surplus > 200 && soc < 980 ? Math.min(surplus, house.batteryMaxChargeW) : 0
      reason = batteryW > 0 ? 'solar_surplus' : 'idle'
    } else if (surplus > 200 && soc < 980) {
      batteryW = Math.min(surplus, house.batteryMaxChargeW)
      reason = 'solar_surplus'
    } else if (plans && mayGridCharge && price < 55 && soc < 900) {
      // Cheap enough to be worth buying now for later.
      batteryW = Math.min(house.batteryMaxChargeW, 3000)
      reason = 'cheap_import'
    } else if (reading.loadW - reading.pvW > ceilingW && soc > 100) {
      batteryW = -Math.min(reading.loadW - reading.pvW - ceilingW, house.batteryMaxChargeW)
      reason = 'peak_shaving'
    } else if (plans && price > 120 && soc > 250) {
      // Every planner mode covers the house through an expensive hour. Only
      // full arbitrage may push past the house's own load into the grid.
      const cover = reading.loadW - reading.pvW
      const limit = mayExportFromBattery ? house.batteryMaxChargeW : Math.max(0, cover)
      batteryW = -Math.min(limit, house.batteryMaxChargeW, 3500)
      reason = batteryW < 0 ? 'expensive_import' : 'idle'
    } else if (plans && soc <= 250) {
      // Below the reserve the box holds back rather than emptying the battery
      // before the evening peak.
      reason = 'reserve_held'
    } else if (surplus > 200) {
      reason = 'export_paid'
    }

    const gridW = reading.loadW - reading.pvW + batteryW

    // Carry state of charge forward so the plan is self-consistent — a plan
    // that charges a full battery for six hours is worse than no plan.
    const deltaWh = (batteryW * SLOT_MS) / 3_600_000
    soc = Math.max(0, Math.min(1000, soc + (deltaWh / house.batteryCapacityWh) * 1000))

    slots.push({
      startMs: at,
      durationMs: SLOT_MS,
      batteryW: Math.round(batteryW),
      gridW: Math.round(gridW),
      priceMinor: price,
      reason,
    })
  }

  return {
    rev: input.rev,
    uptimeMs: input.uptimeMs,
    slots,
    stale: input.stale ?? false,
    ceilingW,
  }
}
