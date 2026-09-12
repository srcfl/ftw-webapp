/* Charger watts for the Now diagram, fetched off the first frame.
 *
 * Field 10 on the 1 Hz stream is supposed to be this sum. Until a box
 * counts a charger that cannot take a command, the house node absorbs
 * it. The overlay asks /api/loadpoints — the same SmoothedW the LAN
 * page uses — and Now subtracts it from house.
 *
 * Loaded only after Now has painted. callBox and the loadpoint decoder
 * belong in History and the charger sheet, not the launch chunk, and
 * putting them on Now pushed the entry bundle 33 bytes over the budget.
 */

import { watchCharging } from './charging-watch'
import { loadpointChargeW } from './flow'
import type { SiteStore } from './site.svelte'

export function watchLoadpointCharge(site: SiteStore, onWatts: (w: number) => void): () => void {
  return watchCharging(site, snapshot => onWatts(snapshot.fresh ? loadpointChargeW(snapshot.points) : 0))
}
