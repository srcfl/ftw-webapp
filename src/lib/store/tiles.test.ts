/* The tile cache.
 *
 * Two rules carry it: a closed tile is immutable and worth keeping, and the
 * trailing tile is still filling and is never kept. Getting the second one
 * wrong is how a chart shows an hour that ended forty minutes ago.
 */

import { describe, it, expect, beforeEach } from 'vitest'
import 'fake-indexeddb/auto'
import { db, resetDbForTests } from './db'
import { loadTiles, saveTile, haveList, pruneTiles } from './tiles'
import { packColumns } from '$lib/protocol/history'
import type { HistChunk } from '$lib/protocol/messages'

const SITE = 'sim-0001'
const DAY_MS = 86_400_000

function chunk(overrides: Partial<HistChunk> = {}): HistChunk {
  return {
    tileId: '5m/1/3061',
    etag: 'deadbeef',
    res: '5m',
    startMs: 3061 * 43_200_000,
    stepMs: 300_000,
    series: ['grid_w'],
    data: packColumns([new Int32Array([11400, 900, -2300])]),
    partial: false,
    ...overrides,
  }
}

async function wipe() {
  resetDbForTests()
  const database = await db()
  for (const store of ['keys', 'tiles'] as const) await database.clear(store)
}

describe('history tiles on disk', () => {
  beforeEach(wipe)

  it('keeps a closed tile and hands its samples back unchanged', async () => {
    await saveTile(SITE, chunk())

    const held = await loadTiles(SITE, ['5m/1/3061'])
    expect(held.size).toBe(1)
    expect([...held.get('5m/1/3061')!.data]).toEqual([...chunk().data])
  })

  it('never keeps the trailing tile', async () => {
    // It is still filling. A cache entry that is right for a minute is worse
    // than no cache entry, because nothing later tells the app it went wrong.
    await saveTile(SITE, chunk({ partial: true }))
    expect((await loadTiles(SITE, ['5m/1/3061'])).size).toBe(0)
  })

  it('seals the samples, so a year of the house is not on disk in the clear', async () => {
    await saveTile(SITE, chunk())

    const row = await (await db()).get('tiles', `${SITE}:5m/1/3061`)
    // 11400 W packs to bytes 0x98 0x2C 0x00 0x00; if those survive to disk in
    // order, nothing was sealed.
    const raw = Array.from(row!.data as Uint8Array).join(',')
    expect(raw).not.toContain([0x98, 0x2c, 0x00, 0x00].join(','))
  })

  it('reports a tile it has not seen as absent, not as an error', async () => {
    expect((await loadTiles(SITE, ['5m/1/9999'])).size).toBe(0)
    expect((await loadTiles(SITE, [])).size).toBe(0)
  })

  it('does not hand one home the tiles of another', async () => {
    await saveTile(SITE, chunk())
    expect((await loadTiles('other-site', ['5m/1/3061'])).size).toBe(0)
  })

  it('offers each held tile with its etag, so the box can send the rest', async () => {
    await saveTile(SITE, chunk())
    const held = await loadTiles(SITE, ['5m/1/3061'])
    expect(haveList(held)).toEqual([{ tileId: '5m/1/3061', etag: 'deadbeef' }])
  })

  it('drops tiles the box no longer keeps', async () => {
    // Otherwise the cache grows for as long as the app is installed, holding
    // years the box itself has already evicted.
    await saveTile(SITE, chunk())
    await saveTile(SITE, chunk({ tileId: '5m/1/3062', startMs: 3062 * 43_200_000 }))

    // A month past the newer tile: the older one has left the box's 5m
    // retention, the newer one sits exactly on its edge.
    const dropped = await pruneTiles(SITE, 3062 * 43_200_000 + 30 * DAY_MS)

    expect(dropped).toBe(1)
    expect((await loadTiles(SITE, ['5m/1/3061', '5m/1/3062'])).size).toBe(1)
  })

  it('prunes each resolution by its own retention', async () => {
    // The box keeps a month of 5m beside two years of 1h, and both answers
    // prune the same store. Judged by one cutoff, a 5m answer's month would
    // evict hour tiles deep inside their own two years — the year chart
    // self-destructing every time the day chart is opened.
    const nowMs = 3062 * 43_200_000 + 30 * DAY_MS
    await saveTile(SITE, chunk()) // 5m, a month and a half old: expired
    await saveTile(
      SITE,
      chunk({
        tileId: '1h/1/500',
        res: '1h',
        startMs: nowMs - 300 * DAY_MS,
        stepMs: 3_600_000,
      })
    )

    const dropped = await pruneTiles(SITE, nowMs)

    expect(dropped).toBe(1)
    const held = await loadTiles(SITE, ['5m/1/3061', '1h/1/500'])
    expect(held.has('1h/1/500'), 'the year cache was judged by the month’s window').toBe(true)
    expect(held.has('5m/1/3061')).toBe(false)
  })
})
