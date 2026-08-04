/* Development wiring: a simulated box, ticking in the browser.
 *
 * Lets the whole client be built and demonstrated without hardware, a relay,
 * or a Pi on the desk. Tree-shaken out of production builds because nothing
 * in the shipping path imports it.
 *
 * Fault switches are exposed on `window.ftwSim` so the failure states can be
 * driven by hand while looking at the screen. Most of what this app does is
 * failure semantics, and those need to be seen, not only asserted.
 */

import { SimBox, type SimFaults } from '$lib/sim/box'
import { LoopbackCarrier } from '$lib/carrier/loopback'
import type { SiteStore } from '$lib/state/site.svelte'

export interface SimHandle {
  box: SimBox
  stop: () => void
  /** Force a fault and watch the UI respond. */
  fault: (patch: Partial<SimFaults>) => void
}

declare global {
  // eslint-disable-next-line no-var
  var ftwSim: SimHandle | undefined
}

export function attachSimulatedSite(store: SiteStore): SimHandle {
  const box = new SimBox()

  // Roughly what the relay costs in production. Zero latency would hide every
  // pending state the UI is supposed to handle.
  store.connect(new LoopbackCarrier(box, { latencyMs: 120 }))

  // The box defends an import ceiling; the Now view explains that.
  store.ceilingW = 11_000

  const timer = setInterval(() => box.tick(1000), 1000)

  const handle: SimHandle = {
    box,
    stop: () => clearInterval(timer),
    fault: (patch) => {
      box.faults = { ...box.faults, ...patch }
    },
  }

  globalThis.ftwSim = handle
  return handle
}
