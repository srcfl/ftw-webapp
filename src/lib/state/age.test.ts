import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import 'fake-indexeddb/auto'
import { Session } from '$lib/protocol/session'
import { LoopbackCarrier } from '$lib/carrier/loopback'
import { SimBox } from '$lib/sim/box'
import { saveSnapshot } from '$lib/store/snapshot'
import { FID } from '$lib/format/explanation'
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

/* The phone in the tunnel.
 *
 * The wall-clock term only exists for a stream that has stopped, so the whole
 * clause is dead unless a frame has arrived and then stopped arriving — and
 * unless the app's own second-hand is running, which it only is after
 * `start()`. An earlier version of this test built a store and never started
 * one, so both assertions were the "nothing has ever arrived" zero and cutting
 * the wall-clock term out of `sinceLastFrameMs` left it green.
 *
 * So the whole path is real here: the store starts the way it starts on a cold
 * open, connects over the loopback to a simulator, streams, and then the wire
 * goes.
 */
describe('the age keeps moving when the stream stops', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(FIXED_NOW)
  })
  afterEach(() => vi.useRealTimers())

  /** fake-indexeddb runs its transactions on timers. Keep the clock moving. */
  async function pump(ms = 5, times = 40) {
    for (let i = 0; i < times; i++) await vi.advanceTimersByTimeAsync(ms)
  }

  /**
   * Let the zero-latency loopback deliver, barely moving the clock.
   *
   * A millisecond a step rather than the pump's five, because everything below
   * is measured from the last frame: the less time passes between it arriving
   * and the wire being cut, the closer the silence is to the round number.
   */
  async function flush(times = 20) {
    for (let i = 0; i < times; i++) await vi.advanceTimersByTimeAsync(1)
  }

  it('adds wall clock once the frames stop arriving', async () => {
    const { SiteStore } = await import('./site.svelte')
    const site = new SiteStore('test')

    // A cached view: age is measured from when the snapshot was written, and
    // that path was already honest.
    expect(Number.isNaN(site.ageMs)).toBe(true)

    // Nothing has ever arrived, so there is no silence to report yet.
    expect(site.sinceLastFrameMs).toBe(0)

    // A cold open. This is also where the app's one-second clock is started,
    // and nothing below moves without it.
    const started = site.start('test')
    await pump()
    await started

    const box = new SimBox({ now: () => Date.now() })
    const carrier = new LoopbackCarrier(box, { latencyMs: 0 })
    site.connect(carrier)
    await flush()
    box.tick()
    await flush()

    expect(site.session.phase).toBe('streaming')
    // Live, and a reading whose age the box itself vouches for.
    expect(site.sinceLastFrameMs).toBe(0)
    expect(Number.isNaN(site.ageMs)).toBe(false)
    const liveAgeMs = site.ageMs

    carrier.drop('into a tunnel')

    // Two beats of a 1 Hz stream is not silence; reporting it would make a
    // healthy view flicker between "now" and "1s ago".
    await vi.advanceTimersByTimeAsync(2_000)
    expect(site.sinceLastFrameMs).toBe(0)

    // Past that it is silence. The box's uptime stopped with the last frame,
    // so this term is the only thing left that can move — without it the band
    // would still read "readings 0s ago" an hour into the tunnel, which is the
    // one lie this app must never tell.
    //
    // Within a tick of a minute rather than exactly it: the app reads the
    // clock on its own second-hand rather than on every access, so the answer
    // is as coarse as the display it feeds and no coarser.
    await vi.advanceTimersByTimeAsync(58_000)
    expect(site.sinceLastFrameMs).toBeGreaterThan(59_000)
    expect(site.sinceLastFrameMs).toBeLessThanOrEqual(60_000)

    // And it is added to the reading's own age, not swapped for it.
    expect(site.ageMs).toBe(liveAgeMs + site.sinceLastFrameMs)

    site.destroy()
  })
})

/* The cached view's age, when the snapshot was already behind at capture.
 *
 * Time on the shelf is only half the answer. A snapshot written while the
 * inverter had been quiet for a minute holds readings a minute older than the
 * write stamp says, and the source rows in the snapshot carry exactly that —
 * lastOk against the box's clock at capture. Counting the shelf alone
 * reported those readings younger than they ever were.
 */
describe('the age of a cached view', () => {
  it('carries the staleness the readings already had at capture', async () => {
    // The meter's last answer was 40 s behind the box's clock when the
    // snapshot was written, and the snapshot has sat two minutes since.
    await saveSnapshot({
      siteId: 'box-stale-capture',
      savedAtMs: Date.now() - 120_000,
      uptimeMs: 500_000,
      fields: { [FID.GRID_W]: 1_200 },
      sources: {
        meter: {
          kind: 'driver',
          name: 'meter',
          lastOkMs: 460_000,
          staleAfterMs: 5_000,
          state: 'stale',
        },
      },
      dispatchBlockedBy: [],
      dict: { [String(FID.GRID_W)]: { name: 'grid_w', unit: 'W', srcId: 'meter' } },
      controlRev: 1,
    })

    const { SiteStore } = await import('./site.svelte')
    const site = new SiteStore('test')
    await site.start('box-stale-capture')

    expect(site.carrier, 'nothing restored, so the rest proves nothing').toBe('cache')
    // Two minutes on the shelf plus the 40 s the meter already lagged.
    expect(site.ageMs).toBeGreaterThanOrEqual(160_000)

    site.destroy()
  })
})
