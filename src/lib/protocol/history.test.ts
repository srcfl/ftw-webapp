/* Tile geometry, clamping and packing.
 *
 * Both peers compute tile boundaries independently, so these have to agree
 * exactly or the etag comparison degrades into "always refetch" without ever
 * failing loudly.
 */

import { describe, it, expect } from 'vitest'
import { MISSING_SAMPLE } from './messages'
import {
  RESOLUTIONS,
  DEFAULT_MAX_POINTS,
  planQuery,
  pointsPerTile,
  tileStartFor,
  tileId,
  packColumns,
  unpackColumns,
  assembleFrame,
  clipFrame,
  etagOf,
} from './history'

const HOUR = 3_600_000
const DAY = 86_400_000

describe('tile geometry', () => {
  it('matches the resolutions in the registry', () => {
    // 12 h at five minutes, 7 d at an hour. Both are contract/registry.yaml.
    expect(RESOLUTIONS['5m'].tileSpanMs).toBe(12 * HOUR)
    expect(RESOLUTIONS['1h'].tileSpanMs).toBe(7 * DAY)
    expect(pointsPerTile('5m')).toBe(144)
    expect(pointsPerTile('1h')).toBe(168)
  })

  it('aligns tiles to the epoch, so two peers cannot disagree', () => {
    const start = tileStartFor('5m', Date.UTC(2026, 6, 15, 13, 47))
    expect(start).toBe(Date.UTC(2026, 6, 15, 12, 0))
    expect(start % RESOLUTIONS['5m'].tileSpanMs).toBe(0)
  })

  it('names a tile by resolution, stride and index', () => {
    const start = Date.UTC(2026, 6, 15, 12, 0)
    expect(tileId('5m', 1, start)).toBe(tileId('5m', 1, start))
    // A tile aggregated six to one holds different numbers for the same
    // hours, so it has to be a different tile rather than the same one
    // meaning two things.
    expect(tileId('5m', 1, start)).not.toBe(tileId('5m', 6, start))
  })
})

describe('the box clamps rather than refusing', () => {
  const now = Date.UTC(2026, 6, 15, 12, 0)

  it('serves a day at the resolution asked for', () => {
    const plan = planQuery('5m', now - DAY, now, DEFAULT_MAX_POINTS)
    expect(plan.res).toBe('5m')
    expect(plan.stride).toBe(1)
    expect(plan.stepMs).toBe(300_000)
  })

  it('drops to the coarser store before it starts averaging', () => {
    // A month at five minutes is 8 640 points. Coarser stored data is real
    // data; an aggregate of finer data is only an average of it.
    const plan = planQuery('5m', now - 30 * DAY, now, 2000)
    expect(plan.res).toBe('1h')
    expect(plan.stride).toBe(1)
  })

  it('aggregates when even the coarsest store is too wide, and never fails', () => {
    const plan = planQuery('1h', now - 365 * DAY, now, 1500)
    expect(plan.res).toBe('1h')
    expect(plan.stride).toBeGreaterThan(1)
    // Whole buckets only, so a tile stays a whole number of points.
    expect(pointsPerTile('1h') % plan.stride).toBe(0)
  })

  it('keeps the delivered point count under the cap, tiles included', () => {
    // The cap has to cover what is actually sent. Budgeting for the requested
    // window and then adding two half-tiles is how a cap becomes advisory.
    for (const span of [DAY, 7 * DAY, 30 * DAY, 365 * DAY, 730 * DAY]) {
      for (const cap of [200, 1500, 2000]) {
        const plan = planQuery('5m', now - span, now, cap)
        const total = plan.tiles.reduce((n, t) => n + t.points, 0)
        expect(total, `${span}ms at cap ${cap}`).toBeLessThanOrEqual(cap)
      }
    }
  })

  it('covers the whole window it was asked for', () => {
    const from = now - 3 * DAY
    const plan = planQuery('5m', from, now, DEFAULT_MAX_POINTS)
    const first = plan.tiles[0]!
    const last = plan.tiles.at(-1)!
    expect(first.startMs).toBeLessThanOrEqual(from)
    expect(last.startMs + RESOLUTIONS[plan.res].tileSpanMs).toBeGreaterThanOrEqual(now)
  })
})

describe('column packing', () => {
  it('round trips int32 little-endian, one block per series', () => {
    const columns = [new Int32Array([1, -2, 3]), new Int32Array([MISSING_SAMPLE, 0, 7])]
    const back = unpackColumns(packColumns(columns), 2)

    expect([...back[0]!]).toEqual([1, -2, 3])
    expect([...back[1]!]).toEqual([MISSING_SAMPLE, 0, 7])
  })

  it('keeps INT32_MIN distinct from zero', () => {
    // Zero is a real reading: a house that drew nothing. Collapsing the two
    // is how a chart ends up drawing a flat line through an outage.
    const back = unpackColumns(packColumns([new Int32Array([MISSING_SAMPLE, 0])]), 1)
    expect(back[0]![0]).toBe(MISSING_SAMPLE)
    expect(back[0]![1]).toBe(0)
    expect(back[0]![0]).not.toBe(back[0]![1])
  })

  it('reads a byte string CBOR handed back at an odd offset', () => {
    // A decoder returns a view into a larger buffer, and Int32Array refuses
    // to sit on an offset that is not a multiple of four.
    const packed = packColumns([new Int32Array([5, 6, 7])])
    const padded = new Uint8Array(packed.length + 1)
    padded.set(packed, 1)

    const back = unpackColumns(padded.subarray(1), 1)
    expect([...back[0]!]).toEqual([5, 6, 7])
  })

  it('gives the same etag for the same bytes and a different one otherwise', () => {
    const a = packColumns([new Int32Array([1, 2, 3])])
    const b = packColumns([new Int32Array([1, 2, 4])])
    expect(etagOf(a)).toBe(etagOf(packColumns([new Int32Array([1, 2, 3])])))
    expect(etagOf(a)).not.toBe(etagOf(b))
  })
})

describe('assembling tiles into one series', () => {
  // Deliberately not on a tile boundary: the overhang is the case that has to
  // be trimmed, and a window that happens to align hides it.
  const now = Date.UTC(2026, 6, 15, 13, 47)
  const plan = planQuery('5m', now - DAY, now, DEFAULT_MAX_POINTS)

  const tileFor = (index: number, fill: number) => {
    const planned = plan.tiles[index]!
    return [
      planned.tileId,
      {
        startMs: planned.startMs,
        stepMs: plan.stepMs,
        series: ['grid_w'],
        data: packColumns([new Int32Array(planned.points).fill(fill)]),
      },
    ] as const
  }

  it('leaves a tile it does not hold as a hole rather than closing the ranks', () => {
    // Shifting the next tile earlier would not be showing a gap. It would be
    // showing the wrong hours.
    const tiles = new Map([tileFor(1, 4200)])
    const frame = assembleFrame(plan, ['grid_w'], tiles)

    expect(frame.columns[0]![0]).toBe(MISSING_SAMPLE)
    expect(frame.columns[0]![plan.tiles[0]!.points]).toBe(4200)
  })

  it('trims the tile overhang to the window that was asked for', () => {
    const tiles = new Map([tileFor(0, 1), tileFor(1, 2), tileFor(2, 3)])
    const full = assembleFrame(plan, ['grid_w'], tiles)
    const clipped = clipFrame(full, now - DAY, now)

    expect(clipped.points).toBeLessThan(full.points)
    expect(clipped.startMs).toBeGreaterThanOrEqual(full.startMs)
    expect(clipped.points * clipped.stepMs).toBeLessThanOrEqual(DAY + clipped.stepMs)
  })
})
