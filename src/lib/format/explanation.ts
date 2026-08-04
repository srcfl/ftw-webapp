/* Why, not just what.
 *
 * "Battery: -4.2 kW" is a number. "The battery is covering the house, so
 * nothing is coming from the grid" is an answer. The common case for this app
 * is a glance — phone out, one look, phone away — and a glance has room for
 * one sentence, not four gauges.
 *
 * The box owns the decision and, later, will send the reason it acted on. Until
 * that lands this derives the explanation from the readings, which covers the
 * cases a household actually sees. Where it cannot tell, it says less rather
 * than guessing: a confident wrong sentence is worse than a plain one.
 */

import type { Fid } from '$lib/protocol/types'
import { formatPower, NOISE_W } from './power'

export const FID = {
  MODE: 1,
  GRID_W: 2,
  PV_W: 3,
  BATTERY_W: 4,
  BATTERY_SOC: 5,
  LOAD_W: 6,
} as const

export type Situation =
  | 'no_data'
  | 'exporting_surplus'
  | 'charging_from_surplus'
  | 'battery_covering'
  | 'battery_shaving'
  | 'solar_covering'
  | 'solar_partial'
  | 'importing'
  | 'dispatch_blocked'

export interface Explanation {
  situation: Situation
  /** One sentence. Always complete, never a fragment. */
  headline: string
}

export interface ExplainInput {
  fields: ReadonlyMap<Fid, number>
  /** Source ids stopping dispatch, from the box's own safety rules. */
  dispatchBlockedBy: readonly string[]
  /** Import ceiling the optimiser defends, in watts. Null when unknown. */
  ceilingW: number | null
}

function kw(watts: number): string {
  const p = formatPower(Math.abs(watts))
  return `${p.text} ${p.unit}`
}

export function explain(input: ExplainInput): Explanation {
  const { fields, dispatchBlockedBy, ceilingW } = input

  const grid = fields.get(FID.GRID_W)
  const pv = fields.get(FID.PV_W)
  const battery = fields.get(FID.BATTERY_W)
  const load = fields.get(FID.LOAD_W)

  if (grid === undefined || load === undefined) {
    return { situation: 'no_data', headline: 'Waiting for the first reading.' }
  }

  // The box's own safety rule outranks everything else it might be doing.
  // Saying why nothing is happening beats looking broken.
  if (dispatchBlockedBy.length > 0) {
    return {
      situation: 'dispatch_blocked',
      headline:
        'Control is paused because a meter stopped reporting. Your home is running normally on grid power.',
    }
  }

  const solar = pv ?? 0
  const bat = battery ?? 0

  // Exporting: more is being produced than the house and battery can absorb.
  if (grid < -NOISE_W) {
    return {
      situation: 'exporting_surplus',
      headline: `Solar is covering the house and sending ${kw(grid)} back to the grid.`,
    }
  }

  // Battery absorbing surplus. Positive battery watts flow into storage.
  if (bat > NOISE_W && solar > NOISE_W && grid < NOISE_W) {
    return {
      situation: 'charging_from_surplus',
      headline: `Spare solar is charging the battery at ${kw(bat)}.`,
    }
  }

  // Battery discharging. Two different stories depending on whether it is
  // holding a ceiling or simply carrying the house.
  if (bat < -NOISE_W) {
    if (ceilingW !== null && grid > NOISE_W) {
      return {
        situation: 'battery_shaving',
        headline: `The battery is supplying ${kw(bat)} to keep grid import below ${kw(ceilingW)}.`,
      }
    }
    if (grid < NOISE_W) {
      return {
        situation: 'battery_covering',
        headline: `The battery is covering the house, so nothing is coming from the grid.`,
      }
    }
    return {
      situation: 'battery_shaving',
      headline: `The battery is supplying ${kw(bat)}, with ${kw(grid)} from the grid.`,
    }
  }

  if (solar > NOISE_W) {
    if (grid < NOISE_W) {
      return {
        situation: 'solar_covering',
        headline: 'Solar is covering everything the house is using.',
      }
    }
    return {
      situation: 'solar_partial',
      headline: `Solar is covering ${kw(solar)} of the ${kw(load)} the house is using.`,
    }
  }

  if (grid > NOISE_W) {
    return {
      situation: 'importing',
      headline: `The house is drawing ${kw(grid)} from the grid.`,
    }
  }

  return { situation: 'importing', headline: 'The house is drawing almost nothing right now.' }
}
