/* Public demo wiring.
 *
 * This runs the same protocol peer as tests and local development. It has no
 * site id, no vault and no debug global. The caller owns a fresh SiteStore,
 * so simulated frames cannot be written under a real home's snapshot key.
 */

import { LoopbackCarrier } from '$lib/carrier/loopback'
import { SimBox } from '$lib/sim/box'
import type { SiteStore } from '$lib/state/site.svelte'

export interface DemoHandle {
  /** Move the simulated home forward once after a pull-to-refresh. */
  tick: () => void
  /** Stop both the clock and the protocol connection. Safe to call twice. */
  stop: () => void
}

export function attachDemoSite(store: SiteStore): DemoHandle {
  // Demo changes only touch this in-memory peer, so asking for a real passkey
  // would grant nothing and would make the sample flow look like setup.
  const box = new SimBox({ requireApiStepUp: false })
  const carrier = new LoopbackCarrier(box, { latencyMs: 120 })
  store.connect(carrier)
  store.ceilingW = 11_000

  const timer = setInterval(() => box.tick(1_000), 1_000)
  let stopped = false

  return {
    tick: () => box.tick(1_000),
    stop: () => {
      if (stopped) return
      stopped = true
      clearInterval(timer)
      carrier.close('demo closed')
    },
  }
}
