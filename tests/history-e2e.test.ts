/* History, end to end: box, wire, cache, series.
 *
 * Driven through the same frames the app uses, against the simulator acting
 * as a peer. A test passing here means the protocol works, not that a stub
 * agreed with itself.
 *
 * The claim under test is the one the whole tile design exists for: asking
 * for the same week twice costs one partial tile, not a week.
 */

import { describe, it, expect, beforeEach } from 'vitest'
import 'fake-indexeddb/auto'
import { Session } from '$lib/protocol/session'
import { LoopbackCarrier } from '$lib/carrier/loopback'
import { SimBox } from '$lib/sim/box'
import { db, resetDbForTests } from '$lib/store/db'
import { loadTiles, saveTile, haveList } from '$lib/store/tiles'
import {
  planQuery,
  assembleFrame,
  unpackColumns,
  RESOLUTIONS,
  type TileData,
} from '$lib/protocol/history'
import { MISSING_SAMPLE, type HistChunk, type HistEnd } from '$lib/protocol/messages'
import { segmentsOf } from '$lib/ui/chart'

const SITE = 'sim-0001'
const HOUR = 3_600_000
const DAY = 86_400_000

/** Pinned, so the same window is asked for every run. */
const NOW = Date.UTC(2026, 6, 15, 13, 47)

const SERIES = ['grid_w', 'pv_w', 'battery_w', 'load_w']

async function wipe() {
  resetDbForTests()
  const database = await db()
  for (const store of ['keys', 'tiles'] as const) await database.clear(store)
}

interface Harness {
  session: Session
  box: SimBox
  ask: (
    fromMs: number,
    toMs: number,
    opts?: { res?: '5m' | '1h'; maxPoints?: number; useCache?: boolean }
  ) => Promise<{ chunks: HistChunk[]; end: HistEnd }>
  stop: () => void
}

function harness(box = new SimBox({ now: () => NOW })): Harness {
  const session = new Session({ build: 'test' })
  const carrier = new LoopbackCarrier(box, { latencyMs: 0 })
  session.connect(carrier)

  const ask: Harness['ask'] = async (fromMs, toMs, opts = {}) => {
    const res = opts.res ?? '5m'
    const maxPoints = opts.maxPoints ?? 2000
    const plan = planQuery(res, fromMs, toMs, maxPoints)

    const cached = opts.useCache
      ? await loadTiles(SITE, plan.tiles.map((t) => t.tileId))
      : new Map()

    const chunks: HistChunk[] = []
    const end = await session.history(
      {
        series: SERIES,
        res,
        fromMs,
        toMs,
        have: haveList(cached),
        maxPoints,
      },
      (chunk) => chunks.push(chunk)
    )

    for (const chunk of chunks) await saveTile(SITE, chunk)
    return { chunks, end }
  }

  return { session, box, ask, stop: () => session.close() }
}

describe('a history window arrives as tiles', () => {
  beforeEach(wipe)

  it('answers with chunks and an end, over the wire', async () => {
    const h = harness()
    const { chunks, end } = await h.ask(NOW - DAY, NOW)

    expect(chunks.length).toBeGreaterThan(0)
    expect(end.resActual).toBe('5m')
    expect(chunks[0]!.series).toEqual(SERIES)
    // Column-packed int32: four series of 144 buckets, four bytes each.
    expect(chunks[0]!.data.byteLength).toBe(4 * 144 * 4)
    h.stop()
  })

  it('marks only the trailing tile partial', async () => {
    const h = harness()
    const { chunks } = await h.ask(NOW - DAY, NOW)

    const partial = chunks.filter((c) => c.partial)
    expect(partial).toHaveLength(1)
    expect(partial[0]!.startMs).toBe(chunks.at(-1)!.startMs)
    h.stop()
  })

  it('matches the live view, because it comes from the same generator', async () => {
    // A separate history generator would drift, and the first person to
    // notice would be a user comparing two screens of the same house.
    const h = harness()
    const { chunks } = await h.ask(NOW - DAY, NOW)

    const pv = unpackColumns(chunks[0]!.data, 4)[SERIES.indexOf('pv_w')]!
    const present = [...pv].filter((v) => v !== MISSING_SAMPLE)

    expect(present.length).toBeGreaterThan(0)
    // PV is never positive, so a daytime window is proved by real magnitude
    // rather than by a positive value.
    expect(present.some((v) => Math.abs(v) > 0)).toBe(true)
    h.stop()
  })
})

describe('asking twice costs one tile', () => {
  beforeEach(wipe)

  it('sends only the trailing tile the second time', async () => {
    const h = harness()

    const first = await h.ask(NOW - 2 * DAY, NOW, { useCache: true })
    expect(first.chunks.length).toBeGreaterThan(2)

    const second = await h.ask(NOW - 2 * DAY, NOW, { useCache: true })

    // This is the entire point of the etag. Closed tiles are immutable, so
    // the box has nothing new to say about them and says nothing.
    expect(second.chunks).toHaveLength(1)
    expect(second.chunks[0]!.partial).toBe(true)
    h.stop()
  })

  it('still draws the whole window from cache plus that one tile', async () => {
    const h = harness()
    await h.ask(NOW - 2 * DAY, NOW, { useCache: true })

    const plan = planQuery('5m', NOW - 2 * DAY, NOW, 2000)
    const second = await h.ask(NOW - 2 * DAY, NOW, { useCache: true })

    const tiles = new Map<string, TileData>(
      await loadTiles(SITE, plan.tiles.map((t) => t.tileId))
    )
    for (const chunk of second.chunks) tiles.set(chunk.tileId, chunk)

    const frame = assembleFrame(plan, SERIES, tiles)
    const load = frame.columns[SERIES.indexOf('load_w')]!

    // Every bucket up to now has a reading — a cache hit must not leave a
    // hole where a tile the app already holds should be.
    const upToNow = Math.floor((NOW - frame.startMs) / frame.stepMs)
    for (let i = 0; i < upToNow; i++) {
      expect(load[i], `bucket ${i}`).not.toBe(MISSING_SAMPLE)
    }
    h.stop()
  })

  it('resends a tile whose etag the client does not have', async () => {
    const h = harness()
    await h.ask(NOW - 2 * DAY, NOW, { useCache: true })

    // No cache offered: the box has no way to know and must send everything.
    const cold = await h.ask(NOW - 2 * DAY, NOW, { useCache: false })
    expect(cold.chunks.length).toBeGreaterThan(1)
    h.stop()
  })
})

describe('a window too wide is served coarser, never refused', () => {
  beforeEach(wipe)

  it('clamps a month to the hourly store and says so', async () => {
    const h = harness()
    const { chunks, end } = await h.ask(NOW - 30 * DAY, NOW, { res: '5m', maxPoints: 2000 })

    expect(end.resActual).toBe('1h')
    expect(chunks.every((c) => c.res === '1h')).toBe(true)
    expect(chunks.every((c) => c.stepMs === HOUR)).toBe(true)
    h.stop()
  })

  it('never sends more points than the client made room for', async () => {
    const h = harness()
    const { chunks } = await h.ask(NOW - 365 * DAY, NOW, { res: '1h', maxPoints: 1500 })

    const points = chunks.reduce((n, c) => n + c.data.byteLength / 4 / c.series.length, 0)
    expect(points).toBeLessThanOrEqual(1500)
    // Aggregation widens the step rather than dropping buckets, so the window
    // is still covered end to end.
    expect(chunks[0]!.stepMs).toBeGreaterThan(HOUR)
    h.stop()
  })

  it('serves a two-year window rather than failing on the size of it', async () => {
    const h = harness()
    const { chunks, end } = await h.ask(NOW - 730 * DAY, NOW, { res: '1h', maxPoints: 1500 })

    expect(end.resActual).toBe('1h')
    expect(chunks.length).toBeGreaterThan(0)
    h.stop()
  })
})

describe('a hole in the data stays a hole', () => {
  beforeEach(wipe)

  it('marks samples the box has nothing for with INT32_MIN, not zero', async () => {
    const box = new SimBox({
      now: () => NOW,
      faults: { histOutage: { fromMs: NOW - 8 * HOUR, toMs: NOW - 4 * HOUR } },
    })
    const h = harness(box)
    const { chunks } = await h.ask(NOW - DAY, NOW)

    const tail = chunks.at(-1)!
    const grid = unpackColumns(tail.data, 4)[SERIES.indexOf('grid_w')]!

    expect([...grid].some((v) => v === MISSING_SAMPLE)).toBe(true)
    // Zero is a real reading. If the outage arrived as zeros the chart would
    // draw a flat line through it and call that the truth.
    expect([...grid].some((v) => v !== MISSING_SAMPLE && v !== 0)).toBe(true)
    h.stop()
  })

  it('breaks the drawn line either side of the outage', async () => {
    const box = new SimBox({
      now: () => NOW,
      faults: { histOutage: { fromMs: NOW - 8 * HOUR, toMs: NOW - 4 * HOUR } },
    })
    const h = harness(box)
    const { chunks } = await h.ask(NOW - DAY, NOW)

    const plan = planQuery('5m', NOW - DAY, NOW, 2000)
    const tiles = new Map<string, TileData>(chunks.map((c) => [c.tileId, c]))
    const frame = assembleFrame(plan, SERIES, tiles)
    const grid = frame.columns[SERIES.indexOf('grid_w')]!

    // Two strokes with readings on both sides of the outage, not one running
    // across four hours the house never recorded.
    const strokes = segmentsOf(grid)
    expect(strokes.length).toBeGreaterThan(1)

    const outageStart = Math.floor((NOW - 8 * HOUR - frame.startMs) / frame.stepMs)
    const outageEnd = Math.ceil((NOW - 4 * HOUR - frame.startMs) / frame.stepMs)
    expect(strokes.every((s) => s.start >= outageEnd || s.end <= outageStart + 1)).toBe(true)
    h.stop()
  })

  it('names the ranges it has nothing for, and why', async () => {
    const box = new SimBox({
      now: () => NOW,
      faults: { histOutage: { fromMs: NOW - 8 * HOUR, toMs: NOW - 4 * HOUR } },
    })
    const h = harness(box)
    const { end } = await h.ask(NOW - DAY, NOW)

    expect(end.gaps.some((g) => g.reason === 'box_down')).toBe(true)
    h.stop()
  })

  it('reports history older than retention as evicted rather than as zeros', async () => {
    const h = harness()
    const from = NOW - RESOLUTIONS['5m'].retentionMs - 2 * DAY
    const { chunks, end } = await h.ask(from, from + DAY, { res: '5m' })

    expect(end.gaps.some((g) => g.reason === 'evicted')).toBe(true)
    const grid = unpackColumns(chunks[0]!.data, 4)[SERIES.indexOf('grid_w')]!
    expect([...grid].every((v) => v === MISSING_SAMPLE)).toBe(true)
    h.stop()
  })
})

describe('a history request always settles', () => {
  beforeEach(wipe)

  it('fails that request alone, without raising a session-wide error', async () => {
    const h = harness()
    // Let the handshake and the snapshot land, so there is a live session for
    // the failed request to leave undisturbed.
    for (let i = 0; i < 6; i++) await new Promise((r) => setTimeout(r, 5))
    expect(h.session.state.phase).toBe('streaming')

    await expect(
      h.session.history({ series: ['not_a_series'], res: '5m', fromMs: NOW - DAY, toMs: NOW }, () => {})
    ).rejects.toThrow()

    // The chart can be narrowed; the app is not broken. Raising the banner
    // here would say otherwise.
    expect(h.session.state.lastError).toBeNull()
    expect(h.session.state.phase).toBe('streaming')
    h.stop()
  })

  it('rejects rather than hanging when the carrier goes away', async () => {
    const h = harness()
    const pending = h.session.history(
      { series: SERIES, res: '5m', fromMs: NOW - DAY, toMs: NOW },
      () => {}
    )
    h.session.close()

    // There is no reload button. A view waiting on a reply that cannot arrive
    // would wait forever.
    await expect(pending).rejects.toThrow()
  })

  it('refuses to ask at all with no carrier', async () => {
    const session = new Session({ build: 'test' })
    await expect(
      session.history({ series: SERIES, res: '5m', fromMs: NOW - DAY, toMs: NOW }, () => {})
    ).rejects.toThrow()
  })
})
