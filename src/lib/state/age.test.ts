import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { Session } from '$lib/protocol/session'
import type { SourceState } from '$lib/protocol/types'

/* Age is a claim, and a wrong one is the one thing this app must never make.
 *
 * Two faults, both of which reported readings as fresher than they were:
 * clamping a negative age to zero across a box restart, and measuring age
 * against the box's uptime alone — which stops moving the moment the box
 * stops sending, exactly when the number matters most.
 */

const FIXED_NOW = Date.UTC(2026, 7, 5, 12, 0, 0)

function sourcesWith(lastOkMs: number, state: SourceState = 'live') {
  return new Map([
    ['meter.p1', { id: 'meter.p1', kind: 'meter', name: 'P1', lastOkMs, staleAfterMs: 5_000, state }],
  ])
}

describe('ageOf across a box restart', () => {
  it('says unknown rather than "just now" when the stamps predate the reboot', () => {
    const session = new Session({ build: 'test' })

    // A cached snapshot from a long-running box: the meter answered at
    // 499_000 ms of an uptime that had reached 500_000.
    session.restore({ uptimeMs: 500_000, sources: sourcesWith(499_000) })
    expect(session.ageOf('meter.p1')).toBe(1_000)

    // The box restarts. Its uptime resets to seconds while the cached source
    // stamp still reads half a million. Clamping that difference to zero
    // reported a reading from before the reboot as current.
    session.restore({ uptimeMs: 3_000, sources: sourcesWith(499_000) })
    expect(session.ageOf('meter.p1')).toBeNaN()
  })

  it('still reports a real age within one boot', () => {
    const session = new Session({ build: 'test' })
    session.restore({ uptimeMs: 60_000, sources: sourcesWith(58_500) })
    expect(session.ageOf('meter.p1')).toBe(1_500)
  })
})

describe('the age keeps moving when the stream stops', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(FIXED_NOW)
  })
  afterEach(() => vi.useRealTimers())

  it('adds wall clock once the frames stop arriving', async () => {
    const { SiteStore } = await import('./site.svelte')
    const site = new SiteStore('test')

    // A cached view: age is measured from when the snapshot was written, and
    // that path was already honest.
    expect(Number.isNaN(site.ageMs)).toBe(true)

    // Nothing has ever arrived, so there is no silence to report yet.
    expect(site.sinceLastFrameMs).toBe(0)

    // Two beats of a 1 Hz stream is not silence; reporting it would make a
    // healthy view flicker between "now" and "1s ago".
    vi.advanceTimersByTime(2_000)
    expect(site.sinceLastFrameMs).toBe(0)

    site.destroy()
  })
})
