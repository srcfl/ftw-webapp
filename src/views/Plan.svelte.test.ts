/* What the Plan view does about prices, mounted rather than read.
 *
 * The mapping has its own tests and the component is the box's own file. What
 * had nothing at all was the wiring between them: the capability gate, the
 * `fed` attribute, the notice when a window stops early, and the guard that
 * keeps a late failure from taking down a chart that is already drawn. All of
 * those are silent when they break — an app that lost `fed` would quietly
 * request /api/prices from an origin that has none, every five minutes for
 * the life of the page.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render } from '@testing-library/svelte'
import Plan from './Plan.svelte'
import { SiteStore } from '$lib/state/site.svelte'
import { LoopbackCarrier } from '$lib/carrier/loopback'
import { SimBox } from '$lib/sim/box'
import { ROLE_VIEWER, type Prices } from '$lib/protocol/messages'
import type { FtwPriceChartElement } from '$vendor/ftw/ftw-price-chart.js'

const HOUR_MS = 3_600_000

/** Mid-morning, so tomorrow's rates have not published yet. */
const MORNING = new Date(2026, 6, 15, 9, 0, 0).getTime()

function chart(): Element | null {
  return document.querySelector('ftw-price-chart')
}

describe('the Plan view, against the simulator', () => {
  let fetched: ReturnType<typeof vi.spyOn>

  beforeEach(() => {
    vi.spyOn(Date, 'now').mockReturnValue(MORNING)
    fetched = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('no origin'))
  })

  afterEach(() => {
    document.body.replaceChildren()
    vi.restoreAllMocks()
  })

  async function mount() {
    const site = new SiteStore('test')
    site.connect(new LoopbackCarrier(new SimBox({ now: () => MORNING }), { latencyMs: 0 }))
    render(Plan, { props: { site } })
    await vi.waitFor(() => expect(chart()).not.toBeNull(), { timeout: 2_000 })
    return site
  }

  it('feeds the chart rather than letting it fetch', async () => {
    await mount()

    // Without this attribute the component fetches /api/prices on a timer.
    // The app has no HTTP origin at all: every request is a 404.
    expect(chart()!.hasAttribute('fed')).toBe(true)
    expect(fetched).not.toHaveBeenCalled()
  })

  it('says tomorrow is not published yet when the window stops early', async () => {
    await mount()

    // The component keeps its own stale state for the compact card, which
    // this screen never renders — so without the app saying it, a market that
    // ends at midnight ends with no notice at all. Not an error: the
    // day-ahead market clears in the afternoon, so this is every morning.
    await vi.waitFor(() =>
      expect(document.body.textContent).toMatch(/tomorrow's rates aren't published yet/i)
    )
  })

  it('names the money the timeline column carries, and its unit', async () => {
    await mount()

    // The chart above prices the same hours. Two numbers for 21:00, one above
    // the other, with nothing saying which is which, is the failure this
    // screen exists to avoid — and naming the money without naming the unit
    // is what made a hundredfold gap between them read as agreement.
    await vi.waitFor(() => expect(document.body.textContent).toMatch(/to import, öre\/kWh/i))
  })

  it('prices the timeline in the unit the chart is drawn in', async () => {
    // The gap this closes: the chart's header read "NOW 144.0 öre" while the
    // row for the same hour read "1.44", with no currency named on it at all.
    // Both are the same money — which is exactly what makes two numbers a
    // hundred apart worse than one number with no label.
    const site = new SiteStore('test')

    // The real answer, kept as it goes past: what the chart draws is what the
    // box sent, so it is the only honest thing to compare a row against.
    let fed: Prices | undefined
    const answer = site.prices.bind(site)
    vi.spyOn(site, 'prices').mockImplementation(async (q) => (fed = await answer(q)))

    site.connect(new LoopbackCarrier(new SimBox({ now: () => MORNING }), { latencyMs: 0 }))
    render(Plan, { props: { site } })

    const current = () => document.querySelector('section.timeline li.now')
    await vi.waitFor(() => expect(chart()).not.toBeNull())
    await vi.waitFor(() => expect(current()).not.toBeNull())

    // Found by name, not by position: a new column would otherwise make this
    // read a different cell and go on passing. The plan and the price window
    // are built from one curve on the box, so for the hour happening now they
    // are the same number and on screen they must be too.
    const cell = current()!.querySelector('.slot-price')
    expect(cell, 'the row has no price cell').not.toBeNull()
    const shown = Number(cell!.textContent)
    const hour = fed!.slots.find((s) => MORNING >= s.startMs && MORNING < s.startMs + s.durationMs)
    expect(hour, 'the window the chart was fed has no slot for this hour').toBeDefined()
    expect(shown).toBe(hour!.totalMinor)
  })

  it('takes the price window away when the box stops offering prices', async () => {
    // A feed removed, a driver pulled, a box that came back speaking less
    // than it did. Nothing asks any more once the capability is gone, and the
    // last window it ever sent used to sit there until local midnight moved
    // the day out from under it — at which point the chart draws its empty
    // state, which reads as the market having gone quiet.
    const box = new SimBox({ now: () => MORNING })
    const carrier = new LoopbackCarrier(box, { latencyMs: 0 })
    const site = new SiteStore('test')
    site.connect(carrier)
    render(Plan, { props: { site } })

    await vi.waitFor(() => expect(chart()).not.toBeNull())

    // The box comes back as one that only speaks the floor protocol, whose
    // capability list is status.core and nothing else. A restart is what it
    // takes to reach: capabilities are settled at the handshake.
    box.faults = { ...box.faults, maxProto: 0 }
    carrier.drop('box restarted')
    carrier.restore()

    await vi.waitFor(() => expect(site.session.caps.has('price.spot')).toBe(false))
    await vi.waitFor(() => expect(chart(), 'a window nothing is asking about any more').toBeNull())
  })
})

/* What the chart is allowed to keep saying, and for how long.
 *
 * A drawn window survives an ask that failed, because today's prices are still
 * today's and a lost answer is no reason to take a block someone is reading
 * off the screen. That is a trade against "never fake live", and it only holds
 * while the two do not actually conflict — which is until local midnight, and
 * until the chart's own idea of "now" goes stale.
 *
 * Both halves are invisible when they break. The chart renders its NOW marker
 * and its "now" figure from the clock at render time, and `fed` took away the
 * five-minute poll that used to re-render it, so a marker frozen at nine in
 * the morning looks exactly like a marker.
 */
describe('a viewer on the Plan screen', () => {
  beforeEach(() => {
    vi.spyOn(Date, 'now').mockReturnValue(MORNING)
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('no origin'))
  })

  afterEach(() => {
    document.body.replaceChildren()
    vi.restoreAllMocks()
  })

  it('cannot press a mode, and is told why in the right words', async () => {
    // Not hidden: which mode the house runs in is a reading, and a viewer is
    // entitled to it. What must not happen is a live button the box will
    // refuse — they tap it, watch it fail, and learn that the app lies. And
    // the sentence has to be about this phone rather than about the box,
    // which supports the change perfectly well.
    const site = new SiteStore('test')
    site.connect(
      new LoopbackCarrier(new SimBox({ now: () => MORNING, role: ROLE_VIEWER }), { latencyMs: 0 })
    )
    render(Plan, { props: { site } })
    await vi.waitFor(() => expect(document.querySelector('button.choice')).not.toBeNull(), {
      timeout: 2_000,
    })

    const modes = [...document.querySelectorAll('button.choice')] as HTMLButtonElement[]
    expect(modes.length).toBeGreaterThan(0)
    expect(
      modes.every((b) => b.disabled),
      'a viewer was offered a mode the box would refuse'
    ).toBe(true)

    expect(document.body.textContent).toMatch(/view-only access/i)
    expect(document.body.textContent).not.toMatch(/box doesn't support/i)
  })

  it('believes the grant the box sent, not its own expansion of the role', async () => {
    // `hello_ok` carries the role AND that role expanded, and the box sends
    // both on purpose: the role is what a sentence names, the scopes are what
    // a control is checked against. This app expanded the role itself through
    // a copy of the registry's table, so a box whose table has moved on — a
    // newer registry, a scope taken out of a role — had its answer overruled
    // by the app's, and the app drew buttons the box would refuse.
    //
    // Named owner, and the grant does not carry the mode scope. The box is
    // the authority on that and this screen has to obey it.
    const site = new SiteStore('test')
    site.connect(
      new LoopbackCarrier(
        new SimBox({ now: () => MORNING, scopes: ['ftw.live.read', 'ftw.plan.read'] }),
        { latencyMs: 0 }
      )
    )
    render(Plan, { props: { site } })
    await vi.waitFor(() => expect(document.querySelector('button.choice')).not.toBeNull(), {
      timeout: 2_000,
    })

    const modes = [...document.querySelectorAll('button.choice')] as HTMLButtonElement[]
    expect(modes.length).toBeGreaterThan(0)
    expect(
      modes.every((b) => b.disabled),
      'a control was offered that the grant does not carry'
    ).toBe(true)
  })
})

describe('the Plan screen before the box has answered', () => {
  afterEach(() => {
    document.body.replaceChildren()
    vi.restoreAllMocks()
  })

  it('says nothing about what the box supports', async () => {
    // A cold start paints from cache with no carrier yet: `caps` is empty
    // because nobody has asked, not because the box said so. Both sentences
    // under the modes are facts about the box, and neither is known here.
    //
    // This is the bug the sharing screen already had and fixed. The same
    // empty set read as an answer put "this box doesn't support changing how
    // it runs" under every launch, about boxes that run the change perfectly
    // well and had simply not spoken yet.
    const site = new SiteStore('test')
    render(Plan, { props: { site } })
    await Promise.resolve()

    expect(document.body.textContent).not.toMatch(/box doesn't support/i)
    expect(document.body.textContent).not.toMatch(/view-only access/i)
  })
})

describe('a price window as the day moves under it', () => {
  afterEach(() => {
    document.body.replaceChildren()
    vi.useRealTimers()
    vi.restoreAllMocks()
  })

  /** Real box, real wire, and a clock the test drives. */
  async function drawn() {
    vi.useFakeTimers()
    vi.setSystemTime(MORNING)
    const box = new SimBox({ now: () => Date.now() })
    const site = new SiteStore('test')
    const asked = vi.spyOn(site, 'prices')
    site.connect(new LoopbackCarrier(box, { latencyMs: 20 }))
    render(Plan, { props: { site } })
    await vi.waitFor(() => expect(chart()).not.toBeNull(), { timeout: 2_000 })
    await vi.advanceTimersByTimeAsync(100)
    return { box, site, asked }
  }

  it('stays drawn through an ask that failed, while it is still today', async () => {
    const { box, asked } = await drawn()
    const first = asked.mock.calls.length

    // Nothing the box sends arrives. The session never notices, so this is the
    // quiet failure. Six hours takes the clock past the publication hour,
    // which is what earns a fresh ask without leaving the day — so there is a
    // real failure here and not merely nothing happening.
    box.faults = { ...box.faults, frameLossRate: 1 }
    // The clock is moved rather than walked: sixteen thousand one-second ticks
    // prove nothing this test is about, and cost more than the CI runner has.
    vi.setSystemTime(MORNING + 6 * 3_600_000)
    await vi.advanceTimersByTimeAsync(60_000)

    expect(asked.mock.calls.length, 'no second ask was made, so nothing failed').toBeGreaterThan(
      first
    )
    expect(new Date().getDate(), 'the clock left the day, which is a different case').toBe(15)
    expect(chart(), 'a lost answer took away a window that was still correct').not.toBeNull()
  })

  it('is gone once the day it covers is yesterday', async () => {
    const { box } = await drawn()

    // Past midnight with the box still unreachable. The bars are yesterday's
    // now, and the chart heads them "today" and calls the last of them "now".
    box.faults = { ...box.faults, frameLossRate: 1 }
    vi.setSystemTime(MORNING + 16 * 3_600_000)
    await vi.advanceTimersByTimeAsync(60_000)

    expect(new Date().getDate(), 'the clock did not reach the next day').toBe(16)
    expect(chart(), "yesterday's prices were still on screen, headed today").toBeNull()
  })

  it('moves its idea of now while the same window stays up', async () => {
    // No failure anywhere: a box answering everything, one window, and time
    // passing. The chart is fed by method, so nothing re-renders it unless
    // this view does.
    const { asked } = await drawn()
    const fedAt = (): number => (asked.mock.calls.length, Date.now())

    const early = chart()!.shadowRoot?.textContent ?? chart()!.textContent ?? ''
    const startedAt = fedAt()

    vi.setSystemTime(MORNING + 4 * 3_600_000)
    await vi.advanceTimersByTimeAsync(60_000)
    expect(Date.now() - startedAt).toBeGreaterThanOrEqual(4 * 3_600_000)

    const later = chart()!.shadowRoot?.textContent ?? chart()!.textContent ?? ''
    expect(later, 'the chart drew the same hour as now, four hours later').not.toBe(early)
  })
})

/* A plan the box never answers, with the wire still up.
 *
 * The other half of the healing, and the half that had none. A carrier that
 * drops is the loud failure: the phase moves, and everything asked for is
 * asked for again on the way back. Every quieter one leaves the phase exactly
 * where it is — a bulk answer lost on the relay, the eight-second deadline
 * against a box busy replanning, E_BOOTING for the minutes after an update —
 * and one of those used to be terminal for this screen. The sentence stayed
 * up until the tab was closed, promising a load that nothing would ever make.
 *
 * Frame loss rather than a fault switch, because it is the failure that
 * cannot be told apart from the box being slow, and because it leaves the
 * session untouched: still streaming, still counting the box as live.
 */
describe('a plan the box could not answer', () => {
  const rows = () => document.querySelectorAll('section.timeline li').length

  afterEach(() => {
    document.body.replaceChildren()
    vi.useRealTimers()
    vi.restoreAllMocks()
  })

  it('is asked for again on its own, without the session ever moving', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(MORNING)

    const box = new SimBox({ now: () => Date.now() })
    const carrier = new LoopbackCarrier(box, { latencyMs: 20 })
    const site = new SiteStore('test')
    const asked = vi.spyOn(site, 'plan')
    site.connect(carrier)

    render(Plan, { props: { site } })

    // Streaming, with the first ask on the wire and not yet answered.
    for (let i = 0; i < 50 && asked.mock.calls.length === 0; i++) {
      await vi.advanceTimersByTimeAsync(5)
    }
    expect(asked).toHaveBeenCalledTimes(1)

    // Nothing the box sends arrives from here on. The request is already on
    // its way, so what is lost is the answer to it.
    box.faults = { ...box.faults, frameLossRate: 1 }
    await vi.advanceTimersByTimeAsync(9_000)

    // The whole difficulty in one line: as far as the session is concerned
    // nothing has happened, so nothing about the connection is coming back to
    // trigger a fresh ask.
    expect(site.session.phase).toBe('streaming')
    expect(rows(), 'a plan arrived through a wire dropping every frame').toBe(0)
    expect(document.body.textContent).toMatch(/couldn't get the plan from your box/i)

    box.faults = { ...box.faults, frameLossRate: 0 }
    await vi.advanceTimersByTimeAsync(31_000)

    expect(asked.mock.calls.length, 'nothing ever asked again').toBeGreaterThan(1)
    expect(rows(), 'the timeline stayed empty against a box that was answering').toBeGreaterThan(0)
    // And the sentence goes with it. It said the app would keep trying; this
    // is the line that makes that a description rather than a hope.
    expect(document.body.textContent).not.toMatch(/couldn't get the plan/i)
  })

  it('is asked for again after a mode change whose replan never arrived', async () => {
    // The replan chased after a mode change used to be fetched by the store
    // itself, outside the healing rule. Its ten attempts are spent in thirty
    // seconds; if every one of them was lost, nothing was left to ask again —
    // and the screen kept saying it was still trying while nothing was.
    vi.useFakeTimers()
    vi.setSystemTime(MORNING)

    const box = new SimBox({ now: () => Date.now() })
    const carrier = new LoopbackCarrier(box, { latencyMs: 20 })
    const site = new SiteStore('test')
    const asked = vi.spyOn(site, 'plan')
    site.connect(carrier)

    render(Plan, { props: { site } })

    await vi.waitFor(() => expect(rows()).toBeGreaterThan(0), { timeout: 2_000 })
    const beforeChange = asked.mock.calls.length

    // The command itself lands. The wire is cut once the replan it triggers is
    // already travelling, so what goes missing is the answer to it and every
    // answer after — the mode really did change, and the plan for it never
    // arrives.
    const mode = [...document.querySelectorAll('button.choice')].find(
      (b) => b.getAttribute('aria-pressed') === 'false' && !(b as HTMLButtonElement).disabled
    ) as HTMLButtonElement
    expect(mode, 'no mode to switch to, so nothing under test happened').toBeTruthy()
    mode.click()

    for (let i = 0; i < 300 && asked.mock.calls.length === beforeChange; i++) {
      await vi.advanceTimersByTimeAsync(2)
    }
    expect(asked.mock.calls.length, 'the mode change asked for no replan at all').toBeGreaterThan(
      beforeChange
    )
    box.faults = { ...box.faults, frameLossRate: 1 }

    // Long enough for all ten attempts to be spent and give up.
    await vi.advanceTimersByTimeAsync(200_000)

    expect(site.session.phase, 'the session moved, so this is not the case under test').toBe(
      'streaming'
    )
    expect(document.body.textContent).toMatch(/couldn't get the plan from your box/i)
    const afterGivingUp = asked.mock.calls.length

    box.faults = { ...box.faults, frameLossRate: 0 }
    await vi.advanceTimersByTimeAsync(16 * 60_000)

    expect(
      asked.mock.calls.length,
      'the replan gave up for good against a box that was answering'
    ).toBeGreaterThan(afterGivingUp)
    expect(document.body.textContent).not.toMatch(/couldn't get the plan/i)
  })
})

/* The plan and the price window, over a wire that goes away and comes back.
 *
 * Everything here is real — a Session, a SimBox, and the loopback carrier
 * dropping the way a socket drops in the field, keeping its handlers and
 * returning on its own. Nothing is stubbed but the count of asks.
 *
 * The fault this covers was invisible to every other test in the tree: a drop
 * settles the request as a failure at once, the carrier comes back, the phase
 * returns to 'streaming', the box answers everything else — and nothing asked
 * again. The screen kept a sentence promising it would load, for as long as
 * the view stayed open, with no reconnect button anywhere in this app because
 * healing is meant to be automatic.
 *
 * Both asks in the one test because both leave on the same mount and die in
 * the same drop, and because a carrier can only be cut once. The price heal
 * had been covered only by tests that set `session.phase` to 'failed' and back
 * by hand — a path no user takes, and one that passes just as happily against
 * a heal wired to nothing.
 */
describe('a plan and a price window the wire cut short', () => {
  const rows = () => document.querySelectorAll('section.timeline li').length

  afterEach(() => {
    document.body.replaceChildren()
    vi.useRealTimers()
    vi.restoreAllMocks()
  })

  it('arrive on their own once the carrier is back', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(MORNING)

    const box = new SimBox({ now: () => Date.now() })
    // Enough latency that the wire can be cut while the ask is still on it,
    // which is the whole case: at zero the answer is home before anything can
    // go wrong.
    const carrier = new LoopbackCarrier(box, { latencyMs: 20 })
    const site = new SiteStore('test')
    const asked = vi.spyOn(site, 'plan')
    // Counted, not replaced: the box on the other end advertises price.spot
    // and answers price.get, and it is the real answer that draws the chart.
    const askedPrices = vi.spyOn(site, 'prices')
    site.connect(carrier)

    render(Plan, { props: { site } })

    // Streaming, and the first asks on the wire but not yet answered.
    for (let i = 0; i < 50 && asked.mock.calls.length === 0; i++) {
      await vi.advanceTimersByTimeAsync(5)
    }
    expect(asked).toHaveBeenCalledTimes(1)
    expect(askedPrices).toHaveBeenCalledTimes(1)

    carrier.drop('wire died')
    await vi.advanceTimersByTimeAsync(50)

    expect(rows(), 'the plan somehow survived the drop').toBe(0)
    expect(document.body.textContent).toMatch(/couldn't get the plan from your box/i)
    // The price ask died with the wire too. Nothing was ever drawn, so there
    // is no chart — which is what makes one appearing below mean something.
    expect(chart(), 'the price window somehow survived the drop').toBeNull()

    carrier.restore()
    await vi.advanceTimersByTimeAsync(500)

    expect(site.session.phase).toBe('streaming')
    expect(asked.mock.calls.length, 'nothing asked again once the box was back').toBeGreaterThan(1)
    expect(rows(), 'the timeline stayed empty against a box that was answering').toBeGreaterThan(0)
    expect(document.body.textContent).not.toMatch(/couldn't get the plan/i)

    expect(
      askedPrices.mock.calls.length,
      'nothing asked for prices again once the box was back'
    ).toBeGreaterThan(1)
    expect(chart(), 'the chart stayed away against a box that was answering').not.toBeNull()
  })
})

/* When the view asks, and for what.
 *
 * The store is real; only the one call under test is replaced, so the two
 * requests can be settled in the order a carrier blip settles them and the
 * clock can be moved without a box in the way.
 */
describe('when the Plan view asks for prices', () => {
  afterEach(() => {
    document.body.replaceChildren()
    vi.useRealTimers()
    vi.restoreAllMocks()
  })

  /** A store that believes it is streaming from a box that has prices. */
  function streamingStore() {
    const site = new SiteStore('test')
    site.session = {
      ...site.session,
      phase: 'streaming' as const,
      caps: new Set(['price.spot']),
    }
    return site
  }

  function deferred() {
    let settle!: (p: Prices) => void
    let fail!: (e: Error) => void
    const promise = new Promise<Prices>((res, rej) => {
      settle = res
      fail = rej
    })
    return { promise, settle, fail }
  }

  const WINDOW: Prices = {
    zone: 'SE4',
    currency: 'SEK',
    stale: false,
    slots: [
      { startMs: MORNING, durationMs: HOUR_MS, spotMinor: 40, totalMinor: 137 },
      { startMs: MORNING + HOUR_MS, durationMs: HOUR_MS, spotMinor: 17, totalMinor: 109 },
    ],
  }

  it('asks nothing of a box that does not advertise prices', async () => {
    const site = new SiteStore('test')
    site.session = { ...site.session, phase: 'streaming', caps: new Set(['status.core']) }
    const asked = vi.spyOn(site, 'prices')

    render(Plan, { props: { site } })
    await new Promise((r) => setTimeout(r, 20))

    // An empty chart would claim the market went quiet rather than that this
    // house has no price feed.
    expect(asked).not.toHaveBeenCalled()
    expect(chart()).toBeNull()
  })

  it('keeps the window inside one bulk frame, however late in the day it is', async () => {
    // Nine in the evening. Local midnight to now plus forty-eight hours is
    // seventy-two hours, which is 288 quarter-hour slots — past the box's
    // wall of roughly 270, so the market truncates and sets stale.
    vi.spyOn(Date, 'now').mockReturnValue(new Date(2026, 6, 15, 21, 0, 0).getTime())
    const site = streamingStore()
    const asked = vi.spyOn(site, 'prices').mockReturnValue(deferred().promise)

    render(Plan, { props: { site } })
    await vi.waitFor(() => expect(asked).toHaveBeenCalledTimes(1))

    const query = asked.mock.calls[0]![0]
    expect(query.toMs - query.fromMs).toBe(48 * HOUR_MS)
    expect(new Date(query.fromMs).getHours()).toBe(0)
  })

  it('asks again when the local day turns over', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date(2026, 6, 15, 23, 59, 30))
    const site = streamingStore()
    const asked = vi.spyOn(site, 'prices').mockReturnValue(deferred().promise)

    render(Plan, { props: { site } })
    await vi.advanceTimersByTimeAsync(0)
    expect(asked).toHaveBeenCalledTimes(1)

    // Past midnight the window on screen is yesterday's, with the NOW marker
    // off the end of it.
    vi.setSystemTime(new Date(2026, 6, 16, 0, 0, 30))
    await vi.advanceTimersByTimeAsync(30_000)

    expect(asked).toHaveBeenCalledTimes(2)
    expect(new Date(asked.mock.calls[1]![0].fromMs).getDate()).toBe(16)
  })

  it("asks again once tomorrow's rates have published", async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date(2026, 6, 15, 13, 30, 0))
    const site = streamingStore()
    const asked = vi.spyOn(site, 'prices').mockReturnValue(deferred().promise)

    render(Plan, { props: { site } })
    await vi.advanceTimersByTimeAsync(0)
    expect(asked).toHaveBeenCalledTimes(1)

    // A phone left on the counter all morning is the case this is for: on a
    // LAN carrier the phase may not change for days.
    vi.setSystemTime(new Date(2026, 6, 15, 14, 30, 0))
    await vi.advanceTimersByTimeAsync(30_000)

    expect(asked).toHaveBeenCalledTimes(2)
  })

  it('does not poll in between', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date(2026, 6, 15, 15, 0, 0))
    const site = streamingStore()
    const asked = vi.spyOn(site, 'prices').mockReturnValue(deferred().promise)

    render(Plan, { props: { site } })
    await vi.advanceTimersByTimeAsync(0)

    // Six hours inside the same day, all of them after publication. Rates
    // move once a day; a round trip every thirty seconds learns nothing.
    for (let i = 0; i < 12; i++) {
      vi.setSystemTime(new Date(2026, 6, 15, 15, 0, 0).getTime() + (i + 1) * 1_800_000)
      await vi.advanceTimersByTimeAsync(30_000)
    }

    expect(asked).toHaveBeenCalledTimes(1)
  })

  it('asks again after a failed ask, and backs off rather than polling', async () => {
    // E_UNAVAILABLE is marked retryable in the contract, and an eight-second
    // timeout against a busy box is the same shape. Neither changes the phase,
    // so before this the view sat on a blank chart until local midnight —
    // ten hours of nothing against a box that would have answered.
    vi.useFakeTimers()
    vi.setSystemTime(new Date(2026, 6, 15, 8, 0, 0))
    const site = streamingStore()
    const asked = vi.spyOn(site, 'prices').mockRejectedValue(new Error('E_UNAVAILABLE'))

    render(Plan, { props: { site } })
    await vi.advanceTimersByTimeAsync(0)
    expect(asked).toHaveBeenCalledTimes(1)

    // Not at once, and not on the 30-second clock the view already ticks on.
    await vi.advanceTimersByTimeAsync(25_000)
    expect(asked, 'retried before the backoff was up').toHaveBeenCalledTimes(1)

    await vi.advanceTimersByTimeAsync(10_000)
    expect(asked, 'never asked again while the carrier stayed up').toHaveBeenCalledTimes(2)

    // The second wait is longer than the first. A fixed timer here would be a
    // request every thirty seconds at a box that is already struggling.
    await vi.advanceTimersByTimeAsync(40_000)
    expect(asked, 'the wait did not grow').toHaveBeenCalledTimes(2)
    await vi.advanceTimersByTimeAsync(25_000)
    expect(asked).toHaveBeenCalledTimes(3)

    // Five hours of a box that never answers. A 30-second poll would be 600.
    await vi.advanceTimersByTimeAsync(5 * HOUR_MS)
    expect(asked.mock.calls.length, 'the retry became a poll').toBeLessThan(30)

    // And when the box does answer, the chart arrives without anything else
    // having to happen. This is what the ceiling is for: five hours of
    // doubling with nothing to stop it puts the next ask hours out, so prices
    // that land at noon would not be believed until the evening.
    const answered = asked.mock.calls.length
    asked.mockResolvedValue(WINDOW)
    await vi.advanceTimersByTimeAsync(20 * 60_000)
    expect(asked.mock.calls.length, 'the backoff grew without a ceiling').toBeGreaterThan(answered)
    await vi.waitFor(() => expect(chart()).not.toBeNull())
  })

  it('drops a retry the reconnect has already made redundant', async () => {
    // A failure schedules a wait. The carrier blinks five seconds later, the
    // ask that follows succeeds — and the wait is still running, against a
    // question that has been answered. Harmless, because the generation guard
    // throws the answer away, but it is a bulk round trip spent for nothing
    // and it is not one of the moments the doc above says earns an ask.
    vi.useFakeTimers()
    vi.setSystemTime(new Date(2026, 6, 15, 8, 0, 0))
    const site = streamingStore()
    const streaming = site.session

    const asked = vi
      .spyOn(site, 'prices')
      .mockRejectedValueOnce(new Error('E_UNAVAILABLE'))
      .mockResolvedValue(WINDOW)

    render(Plan, { props: { site } })
    await vi.advanceTimersByTimeAsync(0)
    expect(asked).toHaveBeenCalledTimes(1)

    await vi.advanceTimersByTimeAsync(5_000)
    site.session = { ...streaming, phase: 'failed' }
    await Promise.resolve()
    site.session = streaming
    await vi.waitFor(() => expect(asked).toHaveBeenCalledTimes(2))
    await vi.waitFor(() => expect(chart()).not.toBeNull())

    // Well past when the orphaned wait would have come due.
    await vi.advanceTimersByTimeAsync(60_000)
    expect(asked, 'a retry ran for an ask that had already been answered').toHaveBeenCalledTimes(2)
  })

  it('does not let the older failure clear the newer chart', async () => {
    const site = streamingStore()
    const streaming = site.session

    const first = deferred()
    const second = deferred()
    const asked = vi
      .spyOn(site, 'prices')
      .mockReturnValueOnce(first.promise)
      .mockReturnValueOnce(second.promise)

    render(Plan, { props: { site } })
    await vi.waitFor(() => expect(asked).toHaveBeenCalledTimes(1))

    // The carrier blinks and comes back. The first request is still in
    // flight — nothing settled it.
    site.session = { ...streaming, phase: 'failed' }
    await Promise.resolve()
    site.session = streaming
    await vi.waitFor(() => expect(asked).toHaveBeenCalledTimes(2))

    second.settle(WINDOW)
    await vi.waitFor(() => expect(chart()).not.toBeNull())

    // Eight seconds after the blip, the first request gives up.
    first.fail(new Error('price request timed out'))
    await vi.waitFor(() => expect(chart()).not.toBeNull())
    await new Promise((r) => setTimeout(r, 20))

    expect(chart(), 'a superseded failure removed a good chart').not.toBeNull()
  })

  it('does not let the older answer redraw over the newer one', async () => {
    // The other half of the same guard, and the half that survives a carrier
    // blink at 23:59:50: the superseded request answers, correctly, with
    // yesterday's window — a few seconds after the 00:00:10 request drew
    // today's. Without the generation check on the way in, the older window
    // wins because it landed last, and the chart is a day behind with no sign
    // that anything went wrong.
    const site = streamingStore()
    const streaming = site.session

    const first = deferred()
    const second = deferred()
    const asked = vi
      .spyOn(site, 'prices')
      .mockReturnValueOnce(first.promise)
      .mockReturnValueOnce(second.promise)

    render(Plan, { props: { site } })
    await vi.waitFor(() => expect(asked).toHaveBeenCalledTimes(1))

    site.session = { ...streaming, phase: 'failed' }
    await Promise.resolve()
    site.session = streaming
    await vi.waitFor(() => expect(asked).toHaveBeenCalledTimes(2))

    // Today's window draws.
    second.settle(WINDOW)
    await vi.waitFor(() => expect(chart()).not.toBeNull())

    // Everything the chart is fed from here on. A window is only ever on
    // screen because it was fed, so this is what "stays on screen" means.
    const fed = vi.spyOn(chart() as FtwPriceChartElement, 'setPrices')

    first.settle({
      ...WINDOW,
      slots: WINDOW.slots.map((s) => ({ ...s, startMs: s.startMs - 24 * HOUR_MS })),
    })
    await new Promise((r) => setTimeout(r, 20))

    expect(fed, 'a superseded answer redrew the chart').not.toHaveBeenCalled()
    expect(chart()).not.toBeNull()
  })
})

/* What the notice under the chart is allowed to claim.
 *
 * The box sets `stale` for any answer that does not cover the window asked
 * for — one that begins after the start, one with a hole in the middle, and
 * one that ends early. Only the app holds the slots, so only the app can tell
 * those apart, and they are not the same sentence: a day missing its own
 * morning is not a day waiting for tomorrow.
 */
describe('the notice under the price chart', () => {
  const MIDNIGHT = new Date(2026, 6, 15, 0, 0, 0).getTime()

  afterEach(() => {
    document.body.replaceChildren()
    vi.restoreAllMocks()
  })

  /** An hourly window over `hours`, skipping any hour in `missing`. */
  function window(hours: number, missing: readonly number[] = []): Prices {
    const slots = []
    for (let h = 0; h < hours; h++) {
      if (missing.includes(h)) continue
      slots.push({
        startMs: MIDNIGHT + h * HOUR_MS,
        durationMs: HOUR_MS,
        spotMinor: 20 + (h % 7),
        totalMinor: 120 + (h % 7),
      })
    }
    // Set by the box for every shape below, which is the whole difficulty.
    return { zone: 'SE4', currency: 'SEK', stale: true, slots }
  }

  async function show(prices: Prices) {
    vi.spyOn(Date, 'now').mockReturnValue(MORNING)
    const site = new SiteStore('test')
    site.session = {
      ...site.session,
      phase: 'streaming' as const,
      caps: new Set(['price.spot']),
    }
    vi.spyOn(site, 'prices').mockResolvedValue(prices)

    render(Plan, { props: { site } })
    // The chart and the notice are the same block, so one arriving means the
    // other has had its chance.
    await vi.waitFor(() => expect(chart()).not.toBeNull())
  }

  it('does not blame tomorrow for a hole in today', async () => {
    // Reaches the end of the 48 h window asked for, and has nothing for
    // 06:00–12:00 today — one failed midday fetch on the box. Tomorrow is
    // published and on the chart, so saying it is not is simply false.
    await show(window(48, [6, 7, 8, 9, 10, 11]))

    expect(document.body.textContent).not.toMatch(/tomorrow's rates aren't published yet/i)
    expect(document.body.textContent).toMatch(/some hours are missing their price/i)
  })

  it('still says tomorrow is not published when the window merely stops short', async () => {
    // The everyday morning case: contiguous from midnight, ending where the
    // market's published day does.
    await show(window(24))

    expect(document.body.textContent).toMatch(/tomorrow's rates aren't published yet/i)
    expect(document.body.textContent).not.toMatch(/some hours are missing their price/i)
  })

  it('says nothing at all about a window that covers what was asked for', async () => {
    await show({ ...window(48), stale: false })

    expect(document.body.textContent).not.toMatch(/tomorrow's rates aren't published yet/i)
    expect(document.body.textContent).not.toMatch(/some hours are missing their price/i)
  })

  it('does not blame tomorrow for a morning that never arrived', async () => {
    // The window asked for starts at local midnight; this one starts at 06:00
    // — a box whose store begins mid-day. Every slot in it joins the last, so
    // there is no gap to find between them, and the day looks whole.
    await show(window(48, [0, 1, 2, 3, 4, 5]))

    expect(document.body.textContent).toMatch(/some hours are missing their price/i)
    expect(document.body.textContent).not.toMatch(/tomorrow's rates aren't published yet/i)
  })

  it('says the hours are missing even when the box called the window complete', async () => {
    // Reproduced against the box: eighteen hourly slots covering 06:00–24:00
    // of a request for 00:00–24:00, answered stale:false. The chart lays bars
    // out by index and closes the gap visually, so six missing hours draw as
    // a complete day with the NOW marker on the wrong bar. This sentence is
    // the only thing on the screen that can say otherwise.
    await show({ ...window(24, [0, 1, 2, 3, 4, 5]), stale: false })

    expect(document.body.textContent).toMatch(/some hours are missing their price/i)
  })
})
