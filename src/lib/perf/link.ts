/* Small, local measurements for the path between this app and its box.
 *
 * Nothing leaves the device. Marks are visible in the browser Performance
 * timeline, and the counters give tests and local diagnostics exact traffic
 * totals without marking every 1 Hz frame and growing the timeline forever.
 */

export interface LinkCounters {
  relayTxFrames: number
  relayTxBytes: number
  relayRxFrames: number
  relayRxBytes: number
  noiseAcceptedFrames: number
  noiseForeignFrames: number
  noiseForeignBytes: number
}

const counters: LinkCounters = {
  relayTxFrames: 0,
  relayTxBytes: 0,
  relayRxFrames: 0,
  relayRxBytes: 0,
  noiseAcceptedFrames: 0,
  noiseForeignFrames: 0,
  noiseForeignBytes: 0,
}

export type LinkCounter = keyof LinkCounters

export function addLinkCount(counter: LinkCounter, amount = 1): void {
  counters[counter] += amount
}

export function linkCounters(): LinkCounters {
  return { ...counters }
}

/** Tests start each run from a known total; the app itself never resets it. */
export function resetLinkCounters(): void {
  for (const key of Object.keys(counters) as LinkCounter[]) counters[key] = 0
}

export function markLinkPhase(
  phase:
    | 'app-open'
    | 'keys-ready'
    | 'connect-start'
    | 'relay-ready'
    | 'noise-open'
    | 'hello-ok'
    | 'snapshot'
    | 'resume-start'
    | 'resume-redial'
    | 'resume-live',
  detail?: object
): void {
  globalThis.performance?.mark?.(`ftw:${phase}`, detail ? { detail } : undefined)
}
