/* History, over a wire that goes away and comes back.
 *
 * The same fault the Plan view had, in the same shape: load() on mount, a
 * catch that leaves a sentence on screen, and nothing that ever asks again.
 * A drop settles the history request as a failure at once, the carrier
 * returns, the box answers everything else, and the chart stays empty under
 * "No history yet" for as long as the screen is open.
 *
 * Everything here is real — a Session, a SimBox, the loopback carrier
 * dropping the way a socket drops in the field. Only the count of asks is a
 * spy. No site id is set, so nothing touches the tile cache: what is under
 * test is the ask, not what is on disk.
 */

import { describe, it, expect, vi, afterEach } from 'vitest'
import { render } from '@testing-library/svelte'
import History from './History.svelte'
import { SiteStore } from '$lib/state/site.svelte'
import { LoopbackCarrier } from '$lib/carrier/loopback'
import { SimBox } from '$lib/sim/box'

/** Fixed so the simulated house has the same day behind it every run. */
const NOON = new Date(2026, 6, 15, 12, 0, 0).getTime()

// jsdom has no ResizeObserver, and the chart measures its own box with one.
// Nothing here depends on the width it would report — the question is whether
// a series arrives at all — so one that never fires is enough, and without it
// the chart's effect throws where no assertion would see it.
class QuietResizeObserver {
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
}
globalThis.ResizeObserver ??= QuietResizeObserver as unknown as typeof ResizeObserver

describe('a history window the wire cut short', () => {
  afterEach(() => {
    document.body.replaceChildren()
    vi.useRealTimers()
    vi.restoreAllMocks()
  })

  it('fills in on its own once the carrier is back', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(NOON)

    const box = new SimBox({ now: () => Date.now() })
    // Enough latency that the wire can be cut while the ask is still on it.
    const carrier = new LoopbackCarrier(box, { latencyMs: 20 })
    const site = new SiteStore('test')
    const asked = vi.spyOn(site, 'history')
    site.connect(carrier)

    render(History, { props: { site } })

    for (let i = 0; i < 50 && asked.mock.calls.length === 0; i++) {
      await vi.advanceTimersByTimeAsync(5)
    }
    expect(asked).toHaveBeenCalledTimes(1)

    carrier.drop('wire died')
    await vi.advanceTimersByTimeAsync(50)

    // Nothing cached and nothing served: the chart has nothing to draw and
    // the note says so.
    expect(document.querySelector('canvas')).toBeNull()
    expect(document.body.textContent).toMatch(/no history yet/i)

    carrier.restore()
    await vi.advanceTimersByTimeAsync(1_000)

    expect(site.session.phase).toBe('streaming')
    expect(asked.mock.calls.length, 'nothing asked again once the box was back').toBeGreaterThan(1)
    expect(
      document.querySelector('canvas'),
      'the chart stayed empty against a box that was answering'
    ).not.toBeNull()
    expect(document.body.textContent).not.toMatch(/no history yet/i)
  })

  it('goes back for a window the box never answered, with the wire still up', async () => {
    // The quiet half of the same failure. A drop moves the session phase and
    // everything is asked for again on the way back; a bulk answer lost on
    // the relay moves nothing at all, so nothing was ever coming to ask
    // again. Same empty chart, same sentence, and no reconnect to end it.
    vi.useFakeTimers()
    vi.setSystemTime(NOON)

    const box = new SimBox({ now: () => Date.now() })
    const carrier = new LoopbackCarrier(box, { latencyMs: 20 })
    const site = new SiteStore('test')
    const asked = vi.spyOn(site, 'history')
    site.connect(carrier)

    render(History, { props: { site } })

    for (let i = 0; i < 50 && asked.mock.calls.length === 0; i++) {
      await vi.advanceTimersByTimeAsync(5)
    }
    expect(asked).toHaveBeenCalledTimes(1)

    // The query is already on the wire; what goes missing is the answer.
    box.faults = { ...box.faults, frameLossRate: 1 }
    await vi.advanceTimersByTimeAsync(21_000)

    expect(site.session.phase).toBe('streaming')
    expect(document.querySelector('canvas')).toBeNull()
    expect(document.body.textContent).toMatch(/no history yet/i)

    box.faults = { ...box.faults, frameLossRate: 0 }
    await vi.advanceTimersByTimeAsync(31_000)

    expect(asked.mock.calls.length, 'nothing ever asked again').toBeGreaterThan(1)
    expect(
      document.querySelector('canvas'),
      'the chart stayed empty against a box that was answering'
    ).not.toBeNull()
    expect(document.body.textContent).not.toMatch(/no history yet/i)
  })

  it('does not repaint the chart for a live stream it is not drawing', async () => {
    // The series is a canvas, and a canvas has one way to change: repaint all
    // of it. History draws a window that ended before the screen opened, so a
    // second of live power is not news to it — and a chart that redrew at
    // 1 Hz would reduce two thousand readings again every time, for a picture
    // identical to the one already on screen. What the stream is allowed to
    // move is the freshness band above, and nothing else here.
    vi.useFakeTimers()
    vi.setSystemTime(NOON)

    let paints = 0
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue({
      setTransform() {},
      clearRect() {
        paints++
      },
      fillRect() {},
      beginPath() {},
      closePath() {},
      moveTo() {},
      lineTo() {},
      arc() {},
      stroke() {},
      fill() {},
    } as never)

    const box = new SimBox({ now: () => Date.now() })
    const site = new SiteStore('test')
    site.connect(new LoopbackCarrier(box, { latencyMs: 20 }))

    render(History, { props: { site } })
    for (let i = 0; i < 100 && paints === 0; i++) await vi.advanceTimersByTimeAsync(20)
    expect(paints, 'nothing was ever drawn, so this proves nothing').toBeGreaterThan(0)

    await vi.advanceTimersByTimeAsync(500)
    const drawn = paints
    const before = site.session.uptimeMs

    // Ten seconds of live power, one frame a second, the way the box sends it.
    for (let i = 0; i < 10; i++) {
      box.tick()
      await vi.advanceTimersByTimeAsync(1_000)
    }

    // The stream really did land, or the count below is free.
    expect(site.session.uptimeMs, 'no live frames arrived at all').toBeGreaterThan(before)
    expect(site.session.phase).toBe('streaming')
    expect(paints - drawn, 'the chart repainted for readings it does not draw').toBe(0)
  })

  it('prints the scale in round numbers, and says which way is which', async () => {
    // The scale is what turns a height on the canvas into a quantity, so it
    // has to survive being read at arm's length. Two faults it had: every
    // rung under 10 kW carried a forced decimal, so "5.0 kW" sat under
    // "10 kW" and the pair read as a mistake; and the axis was ruled on
    // whichever round step first exceeded the average gap, which for a house
    // that both draws and exports left the whole export half unlabelled —
    // and with it the only word on the chart saying which way is which.
    vi.useFakeTimers()
    vi.setSystemTime(NOON)

    const site = new SiteStore('test')
    site.connect(new LoopbackCarrier(new SimBox({ now: () => Date.now() }), { latencyMs: 20 }))

    render(History, { props: { site } })
    for (let i = 0; i < 100 && !document.querySelector('.ytick'); i++) {
      await vi.advanceTimersByTimeAsync(20)
    }

    const rungs = [...document.querySelectorAll('.ytick')].map((e) =>
      e.textContent!.replace(/\s+/g, ' ').trim()
    )
    expect(rungs.length, 'the chart drew no scale at all').toBeGreaterThanOrEqual(3)

    for (const rung of rungs) {
      expect(rung, 'a trailing zero the rung never needed').not.toMatch(/\.0(\D|$)/)
      expect(rung, 'the wire sign convention leaked onto the axis').not.toMatch(/-/)
    }

    // The simulated house both draws and sends back, so both words belong.
    expect(rungs.some((r) => r.endsWith('in')), 'nothing says which way is in').toBe(true)
    expect(rungs.some((r) => r.endsWith('out')), 'nothing says which way is out').toBe(true)
  })

  it('sends one window for one tap, not two', async () => {
    // The range is the question askWhenLive asks under, so setting it already
    // fetches. Fetching in select() as well put the same window on the wire
    // twice for every tap, and #token quietly threw the loser away — invisible
    // on screen, and paid for on the slowest screen there is.
    vi.useFakeTimers()
    vi.setSystemTime(NOON)

    const site = new SiteStore('test')
    const asked = vi.spyOn(site, 'history')
    site.connect(new LoopbackCarrier(new SimBox({ now: () => Date.now() }), { latencyMs: 20 }))

    render(History, { props: { site } })
    for (let i = 0; i < 50 && asked.mock.calls.length === 0; i++) {
      await vi.advanceTimersByTimeAsync(5)
    }
    await vi.advanceTimersByTimeAsync(200)
    const afterMount = asked.mock.calls.length

    const sevenDay = [...document.querySelectorAll('button.range')].find(
      (b) => b.textContent?.trim() === '7 d'
    ) as HTMLButtonElement
    sevenDay.click()
    await vi.advanceTimersByTimeAsync(500)

    expect(asked.mock.calls.length - afterMount, 'one tap put two windows on the wire').toBe(1)
  })

  it('goes back for a range the user tapped, when that answer is the one lost', async () => {
    // The path a person actually reaches: not a drop, not the mount ask, but
    // a tap on "7 d" whose answer never arrives. It used to fetch outside the
    // healing rule, so nothing retried — and because the chart keeps what it
    // had, the screen showed 24 h of data under a pressed "7 d" button, which
    // is worse than an empty chart: it is a wrong label on real readings.
    vi.useFakeTimers()
    vi.setSystemTime(NOON)

    const box = new SimBox({ now: () => Date.now() })
    const carrier = new LoopbackCarrier(box, { latencyMs: 20 })
    const site = new SiteStore('test')
    const asked = vi.spyOn(site, 'history')
    site.connect(carrier)

    render(History, { props: { site } })

    for (let i = 0; i < 50 && asked.mock.calls.length === 0; i++) {
      await vi.advanceTimersByTimeAsync(5)
    }
    await vi.advanceTimersByTimeAsync(100)
    expect(asked).toHaveBeenCalledTimes(1)
    const afterMount = asked.mock.calls.length

    // The tap goes out and the answer is dropped on the way back.
    box.faults = { ...box.faults, frameLossRate: 1 }
    const sevenDay = [...document.querySelectorAll('button.range')].find(
      (b) => b.textContent?.trim() === '7 d'
    ) as HTMLButtonElement
    sevenDay.click()
    await vi.advanceTimersByTimeAsync(21_000)

    expect(site.session.phase, 'the session moved, so this is not the case under test').toBe(
      'streaming'
    )
    expect(asked.mock.calls.length, 'the tap never reached the box at all').toBeGreaterThan(
      afterMount
    )
    const afterTap = asked.mock.calls.length

    box.faults = { ...box.faults, frameLossRate: 0 }
    await vi.advanceTimersByTimeAsync(31_000)

    expect(
      asked.mock.calls.length,
      'a tapped range was never asked for again against a box that was answering'
    ).toBeGreaterThan(afterTap)
    // And what it went back for is the range the button says, not the one
    // whose readings are still drawn.
    const spans = asked.mock.calls.at(-1)?.[0]
    expect(spans && spans.toMs - spans.fromMs).toBeGreaterThan(3 * 24 * 60 * 60_000)
  })
})
