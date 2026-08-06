import { describe, it, expect, vi } from 'vitest'
import 'fake-indexeddb/auto'
import { CarrierBase, type Carrier, type CarrierStatus } from '$lib/carrier/carrier'
import { LoopbackCarrier } from '$lib/carrier/loopback'
import { SimBox } from '$lib/sim/box'
import { encodeFrame, decodeFrame, LANE_BULK, bulkBucketFor } from '$lib/protocol/frame'
import { PROTO_MAX, type HelloOk, type Snap, type SourceWire } from '$lib/protocol/messages'
import type { SourceState } from '$lib/protocol/types'
import { FID } from '$lib/format/explanation'
import { SiteStore } from './site.svelte'

/* The freshness band, against a box that is not the simulator.
 *
 * The band read "Live via encrypted relay · no reading yet" for a whole
 * session while every number on screen moved. The app was asking after three
 * source ids it had been compiled with — the simulator's — and a real box
 * names its sources after its own drivers, so all three came back unknown and
 * unknown ranks worse than dead.
 *
 * Hence a box shaped like a real one here. Nothing below may recognise a
 * source id; the box says which source is behind which field and this app
 * reads it.
 */

/** Fredrik's box: three drivers, and the heat pump is offline. */
const METER = 'sungrow'
const CHARGER = 'easee'
const HEAT_PUMP = 'myuplink'

const UPTIME_MS = 3_600_000

function source(state: SourceState, staleAfterMs: number): SourceWire {
  return {
    kind: 'driver',
    name: 'driver',
    // A source that is not live has not answered recently. Saying otherwise
    // would make the state and the stamp disagree.
    lastOkMs: state === 'live' ? UPTIME_MS : Math.max(0, UPTIME_MS - staleAfterMs * 8),
    staleAfterMs,
    state,
  }
}

/**
 * A snapshot in the shape `fieldDict` builds on the box.
 *
 * Every reading on the Now view comes off the site meter driver, the charger
 * sum has no single source, and the heat pump is a source the Now view never
 * draws.
 */
function realBoxSnap(meterState: SourceState = 'live'): Snap {
  return {
    uptimeMs: UPTIME_MS,
    controlRev: 7,
    dict: {
      [FID.MODE]: { name: 'mode', unit: null, srcId: null },
      [FID.GRID_W]: { name: 'grid_w', unit: 'W', srcId: METER },
      [FID.PV_W]: { name: 'pv_w', unit: 'W', srcId: METER },
      [FID.BATTERY_W]: { name: 'battery_w', unit: 'W', srcId: METER },
      [FID.BATTERY_SOC]: { name: 'battery_soc', unit: 'permille', srcId: METER },
      [FID.LOAD_W]: { name: 'load_w', unit: 'W', srcId: METER },
      [FID.EV_W]: { name: 'ev_w', unit: 'W', srcId: null },
    },
    fields: {
      [FID.MODE]: 0,
      [FID.GRID_W]: 1_240,
      [FID.PV_W]: -3_400,
      [FID.BATTERY_W]: -820,
      [FID.BATTERY_SOC]: 642,
      [FID.LOAD_W]: 2_060,
      [FID.EV_W]: 0,
    },
    sources: {
      [METER]: source(meterState, 5_000),
      [CHARGER]: source('live', 15_000),
      [HEAT_PUMP]: source('down', 60_000),
    },
    dispatchBlockedBy: [],
  }
}

function helloOk(): HelloOk {
  return {
    proto: PROTO_MAX,
    mode: 'full',
    box: { id: 'box-real', build: 'v1.16.1-beta.8', tz: 'Europe/Stockholm' },
    clock: { source: 'ntp', syncedAtMs: Date.now(), uptimeMs: UPTIME_MS },
    caps: ['status.core'],
    capsHash: 'real',
    modes: [
      {
        key: 'planner_passive_arbitrage',
        label: 'Passive arbitrage',
        tooltip: 'Charge from the cheapest available source.',
        tier: 'primary',
      },
    ],
  }
}

/** Answers a hello with a hello_ok and a sub with one snapshot. */
class RealBoxCarrier extends CarrierBase implements Carrier {
  readonly kind = 'relay' as const
  readonly rttMs = 40

  #status: CarrierStatus = { phase: 'open', sinceMs: Date.now() }
  #snap: Snap

  constructor(snap: Snap) {
    super()
    this.#snap = snap
  }

  get status(): CarrierStatus {
    return this.#status
  }

  send(bytes: Uint8Array): void {
    const { t } = decodeFrame(bytes).envelope
    // Deferred: no real box answers from inside the caller's stack.
    setTimeout(() => {
      if (t === 'hello') this.#reply('hello_ok', helloOk())
      else if (t === 'sub') this.#reply('snap', this.#snap)
    }, 0)
  }

  close(): void {
    this.#status = { phase: 'closed', reason: 'test over', retryable: false }
    this.clearHandlers()
  }

  #reply(t: string, b: unknown): void {
    const bucket = bulkBucketFor(4_000) ?? 4096
    this.emitFrame(encodeFrame({ lane: LANE_BULK, flags: 0, envelope: { t, b } }, bucket))
  }
}

async function settle(times = 10): Promise<void> {
  for (let i = 0; i < times; i++) await new Promise((r) => setTimeout(r, 1))
}

describe('freshness on a box the app was not compiled against', () => {
  it('is live when the box names its own drivers', async () => {
    const site = new SiteStore('test')
    await site.start('box-real')

    // Nothing has arrived from anywhere yet, so "no reading yet" is the plain
    // truth — this is the one state that sentence belongs to.
    expect(site.srcState).toBe('never')

    site.connect(new RealBoxCarrier(realBoxSnap()))
    await settle()

    expect(site.session.phase).toBe('streaming')

    // The readings are arriving and the sources behind them are answering.
    // Anything else here is the band calling a working box broken.
    expect(site.srcState, 'a live box read as').toBe('live')

    // And the age is a number, not the NaN three unknown sources produced.
    expect(Number.isNaN(site.ageMs), 'age of a live reading was NaN').toBe(false)
    expect(site.ageMs).toBeLessThan(5_000)

    site.destroy()
  })

  it('ignores a device the Now view does not draw', async () => {
    const site = new SiteStore('test')
    await site.start('box-real')

    // The heat pump is offline in every snapshot above. It is a real fault on
    // a real driver, and it is not a fault in anything on this screen — the
    // band speaks for the sources this view depends on, and an offline heat
    // pump must not make the whole house look broken.
    site.connect(new RealBoxCarrier(realBoxSnap()))
    await settle()

    expect(site.session.sources.get(HEAT_PUMP)?.state).toBe('down')
    expect(site.srcState).toBe('live')

    site.destroy()
  })

  it('still reports the source behind a reading on screen going quiet', async () => {
    const site = new SiteStore('test')
    await site.start('box-real')

    // The other half of the same claim: the meter feeds four of the numbers
    // being drawn, so when it stops the band has to say so. A fix that made
    // freshness always read live would pass everything above and this is
    // where it fails.
    site.connect(new RealBoxCarrier(realBoxSnap('down')))
    await settle()

    expect(site.srcState).toBe('down')
    expect(Number.isNaN(site.ageMs)).toBe(false)
    expect(site.ageMs).toBeGreaterThan(30_000)

    site.destroy()
  })

  it('does not call a box healthy for naming no sources at all', async () => {
    // A box with no site-meter driver sends a null srcId for every field
    // while still streaming every reading. The list of sources behind the
    // screen is then empty — and worstSourceState starts at 'live' and never
    // enters its loop, so an empty list used to read as all clear. Here every
    // driver the box reports is down.
    const snap = realBoxSnap()
    for (const fid of Object.keys(snap.dict)) snap.dict[fid]!.srcId = null
    snap.sources = {
      [METER]: source('down', 5_000),
      [CHARGER]: source('down', 15_000),
      [HEAT_PUMP]: source('down', 60_000),
    }

    const site = new SiteStore('test')
    await site.start('box-real')
    site.connect(new RealBoxCarrier(snap))
    await settle()

    expect(site.srcState, 'a box with every driver down reported as live').not.toBe('live')

    site.destroy()
  })

  it('does not claim the relay for readings that came off the disk', async () => {
    // The launch every returning user makes: cache paints, the socket opens,
    // and hello is still unanswered. The session claims its carrier the
    // moment the socket opens, so the band read "Live via encrypted relay"
    // over whatever the cache held — with the age suppressed, because the
    // band hides it while live. Nothing on screen betrayed it, and it held
    // for as long as the box stayed quiet.
    // Its own cache, seeded here. Leaning on a row an earlier test happened to
    // leave behind would make this pass or fail on the order the file runs in,
    // and quietly stop covering anything the day someone wipes between tests.
    const seed = new SiteStore('test')
    await seed.start('box-disk')
    seed.connect(new RealBoxCarrier(realBoxSnap()))
    await settle()
    await seed.persistNow()
    seed.destroy()

    const site = new SiteStore('test')
    await site.start('box-disk')
    expect(site.carrier, 'nothing was cached, so the rest proves nothing').toBe('cache')

    // A carrier that opens and then says nothing at all: a box mid-boot, a
    // wedged relay, a revoked device.
    const silent = new (class extends CarrierBase implements Carrier {
      readonly kind = 'relay' as const
      readonly rttMs = 40
      get status(): CarrierStatus {
        return { phase: 'open', sinceMs: Date.now() }
      }
      send(): void {}
      close(): void {
        this.clearHandlers()
      }
    })()

    site.connect(silent)
    await settle()

    expect(site.session.carrier, 'the session does claim the socket, which is the trap').toBe(
      'relay'
    )
    expect(site.carrier, 'the band was told the readings came over the relay').not.toBe('relay')
    expect(site.srcState, 'a box that has said nothing was reported live').not.toBe('live')

    site.destroy()
  })

  it('does not take an answered handshake for a reading', async () => {
    // The fifth hole, and the subtlest: hello_ok carries the box's clock, so
    // answering the handshake moves uptime without a single value being sent.
    // A box can answer hello and then boot for ten minutes, go quiet, or
    // refuse this device — and the band was reading "Live via encrypted
    // relay" over whatever the cache held, with the age suppressed because it
    // hides the age while live.
    const site = new SiteStore('test')
    await site.start('box-hello')

    // Something on disk to be wrongly presented as current.
    site.connect(new RealBoxCarrier(realBoxSnap()))
    await settle()
    expect(site.session.phase).toBe('streaming')
    site.destroy()

    const back = new SiteStore('test')
    await back.start('box-hello')
    expect(back.carrier, 'nothing was cached, so the rest proves nothing').toBe('cache')

    // A box that answers hello and then says nothing at all.
    const halfway = new (class extends CarrierBase implements Carrier {
      readonly kind = 'relay' as const
      readonly rttMs = 40
      get status(): CarrierStatus {
        return { phase: 'open', sinceMs: Date.now() }
      }
      send(bytes: Uint8Array): void {
        const { t } = decodeFrame(bytes).envelope
        if (t !== 'hello') return
        setTimeout(() => {
          const bucket = bulkBucketFor(4_000) ?? 4096
          this.emitFrame(
            encodeFrame({ lane: LANE_BULK, flags: 0, envelope: { t: 'hello_ok', b: helloOk() } }, bucket)
          )
        }, 0)
      }
      close(): void {
        this.clearHandlers()
      }
    })()

    back.connect(halfway)
    await settle()

    expect(back.session.phase, 'the handshake did not land, so nothing is under test').not.toBe(
      'idle'
    )
    expect(back.carrier, 'an answered hello was taken for a delivered reading').not.toBe('relay')
    expect(back.srcState, 'a box that has sent no reading was reported live').not.toBe('live')

    back.destroy()
  })

  it('stops calling a stream live once it has gone quiet', async () => {
    // An open socket is not a stream. Every source state on screen was read
    // off the last frame, so when the frames stop that judgement stops with
    // them — and saying live suppresses the age, which is the one fact being
    // asked for.
    const site = new SiteStore('test')
    await site.start('box-quiet')
    site.connect(new RealBoxCarrier(realBoxSnap()))
    await settle()

    expect(site.srcState, 'the stream never started, so silence proves nothing').toBe('live')

    // The socket stays open and the box says nothing more. Moving the wall
    // clock rather than waiting a minute: what is under test is the rule, not
    // the patience of the test runner.
    const realNow = Date.now
    Date.now = () => realNow() + 60_000
    try {
      // One real beat, so the store's own one-second ticker reads the moved
      // clock. Everything else here is instant.
      await new Promise((r) => setTimeout(r, 1_100))
      expect(site.srcState, 'a minute of silence still read as live').not.toBe('live')
      expect(site.ageMs).toBeGreaterThan(30_000)
    } finally {
      Date.now = realNow
    }

    site.destroy()
  })

  it('still reads the simulator, which every other test runs against', async () => {
    const site = new SiteStore('test')
    await site.start('sim-0001')

    const box = new SimBox({ now: () => Date.now() })
    site.connect(new LoopbackCarrier(box, { latencyMs: 0 }))
    await settle()
    box.tick()
    await settle()

    expect(site.session.phase).toBe('streaming')
    expect(site.srcState).toBe('live')
    expect(Number.isNaN(site.ageMs)).toBe(false)

    site.destroy()
  })
})
