/* Prices, end to end against the simulator.
 *
 * The app has no HTTP origin, so what a kilowatt-hour costs reaches it the
 * same way everything else does: a request on the bulk lane, answered with a
 * request id. These run the real exchange rather than a stub agreeing with
 * itself.
 */

import { describe, it, expect } from 'vitest'
import { Session, PriceError } from '$lib/protocol/session'
import { LoopbackCarrier } from '$lib/carrier/loopback'
import { SimBox } from '$lib/sim/box'

const HOUR_MS = 3_600_000

/** Mid-morning, so tomorrow's rates have not published yet. */
const MORNING = new Date(2026, 6, 15, 9, 0, 0).getTime()

function connect(box: SimBox) {
  const session = new Session({ build: 'test' })
  session.connect(new LoopbackCarrier(box, { latencyMs: 0 }))
  return session
}

async function settle(times = 30) {
  for (let i = 0; i < times; i++) await new Promise((r) => setTimeout(r, 2))
}

function today(atMs: number) {
  return new Date(atMs).setHours(0, 0, 0, 0)
}

describe('prices on the wire', () => {
  it('is being run in the timezone the suite pins', () => {
    // The control, and it comes first because without it the rest of this
    // file is decoration. Every claim below about a local hour — the day
    // boundary, the publish hour, where the evening peak lands — is written
    // as getHours(), and getHours() and getUTCHours() return the same number
    // wherever the offset is zero. Under TZ=UTC this whole file passes with
    // the simulator reading the curve in UTC, which is the bug it was written
    // to catch.
    //
    // So the zone is pinned in vitest.config.ts rather than left to the
    // machine, and this is what says the pin is in effect. The offset rather
    // than the name: ICU still answers 'Asia/Calcutta' for it on some builds,
    // and the offset is what the assertions below actually depend on anyway.
    //
    // -330 is +05:30, and the half hour is the point. A day boundary computed
    // by flooring to a UTC hour lands inside the local day here and nowhere in
    // Europe, so a whole-hour zone would hide it. Written out rather than
    // imported from the config: a control that reads the value it is checking
    // agrees with whatever it finds, which is the same nothing this test
    // exists to stop.
    expect(new Date(MORNING).getTimezoneOffset()).toBe(-330)
  })

  it('answers a window with labelled slots', async () => {
    const box = new SimBox({ now: () => MORNING })
    const session = connect(box)
    await settle()

    const prices = await session.prices({ fromMs: today(MORNING), toMs: MORNING + 48 * HOUR_MS })

    expect(prices.slots.length).toBeGreaterThan(0)
    // Without these, 45 is a number and not a price.
    expect(prices.zone).not.toBe('')
    expect(prices.currency).toBe('SEK')
  })

  it('carries money as integer minor units', async () => {
    // A price is money, and money in a float is a rounding argument waiting
    // to happen. The box rounds once, here, and nothing rounds again.
    const box = new SimBox({ now: () => MORNING })
    const session = connect(box)
    await settle()

    const prices = await session.prices({ fromMs: today(MORNING), toMs: MORNING + 48 * HOUR_MS })
    for (const slot of prices.slots) {
      expect(Number.isInteger(slot.spotMinor)).toBe(true)
      expect(Number.isInteger(slot.totalMinor)).toBe(true)
    }
  })

  it('costs more to import than the market charges, because the box adds the rest', async () => {
    // The app must never compute this itself: only the box holds the grid
    // tariff and the VAT rate.
    const box = new SimBox({ now: () => MORNING })
    const session = connect(box)
    await settle()

    const prices = await session.prices({ fromMs: today(MORNING), toMs: MORNING + 48 * HOUR_MS })
    for (const slot of prices.slots) {
      expect(slot.totalMinor).toBeGreaterThan(slot.spotMinor)
    }
  })

  it('is self-consistent: slots are contiguous and aligned', async () => {
    const box = new SimBox({ now: () => MORNING })
    const session = connect(box)
    await settle()

    const prices = await session.prices({ fromMs: today(MORNING), toMs: MORNING + 48 * HOUR_MS })
    for (let i = 1; i < prices.slots.length; i++) {
      const prev = prices.slots[i - 1]!
      // A gap would draw as a market that stopped for an hour.
      expect(prices.slots[i]!.startMs).toBe(prev.startMs + prev.durationMs)
    }
  })

  it('says so when the answer stops short of the window asked for', async () => {
    // Tomorrow's rates publish in the afternoon. A morning window that reaches
    // into tomorrow genuinely ends early, and "our numbers stop here" is a
    // different sentence from "the market went quiet".
    const box = new SimBox({ now: () => MORNING })
    const session = connect(box)
    await settle()

    const prices = await session.prices({ fromMs: today(MORNING), toMs: MORNING + 48 * HOUR_MS })
    const last = prices.slots[prices.slots.length - 1]!

    expect(prices.stale).toBe(true)
    expect(last.startMs + last.durationMs).toBeLessThan(MORNING + 48 * HOUR_MS)
  })

  it('is complete when the window ends inside what has published', async () => {
    const box = new SimBox({ now: () => MORNING })
    const session = connect(box)
    await settle()

    const prices = await session.prices({ fromMs: today(MORNING), toMs: MORNING + 6 * HOUR_MS })

    expect(prices.stale).toBe(false)
  })

  it('agrees with the plan about what an hour costs', async () => {
    // Two numbers would put one price on the chart and another on the timeline
    // directly below it, for the same hour, on the same screen. The plan's
    // priceMinor is the *import* price, which is what the box puts there —
    // comparing it against spot would agree about the wrong thing.
    const box = new SimBox({ now: () => MORNING })
    const session = connect(box)
    await settle()

    const [prices, plan] = await Promise.all([
      session.prices({ fromMs: today(MORNING), toMs: MORNING + 12 * HOUR_MS }),
      session.plan(),
    ])

    let compared = 0
    for (const slot of plan.slots) {
      const covering = prices.slots.find(
        (p) => p.startMs <= slot.startMs && slot.startMs < p.startMs + p.durationMs
      )
      if (!covering) continue
      expect(slot.priceMinor).toBe(covering.totalMinor)
      compared++
    }
    expect(compared).toBeGreaterThan(0)
  })

  it('puts the evening peak on the local evening', async () => {
    // The day boundary and the publish hour are read in local time. Reading
    // the curve in UTC as well as them shifted the sim's peaks one or two
    // hours off the local hours the rest of the view is drawn in, which makes
    // the dev screen a slightly wrong thing to review against.
    const box = new SimBox({ now: () => MORNING })
    const session = connect(box)
    await settle()

    const prices = await session.prices({
      fromMs: today(MORNING),
      toMs: today(MORNING) + 24 * HOUR_MS,
    })
    const dearest = prices.slots.reduce((a, b) => (b.spotMinor > a.spotMinor ? b : a))

    expect(new Date(dearest.startMs).getHours()).toBe(18)
  })

  it('refuses to price while the box is still booting', async () => {
    const box = new SimBox({ now: () => MORNING, faults: { booting: true } })
    const session = connect(box)
    await settle()

    // Scoped to the request, so one chart the box cannot draw does not raise
    // the session-wide error banner over the whole app.
    await expect(session.prices({ fromMs: today(MORNING), toMs: MORNING })).rejects.toBeInstanceOf(
      PriceError
    )
    expect(session.state.lastError).toBeNull()
  })

  it('offers prices only when the box says it has them', async () => {
    const box = new SimBox({ now: () => MORNING })
    const session = connect(box)
    await settle()

    // The capability is what the Plan view gates the whole chart on. From
    // contract/registry.yaml.
    expect(session.state.caps.has('price.spot')).toBe(true)
  })
})
