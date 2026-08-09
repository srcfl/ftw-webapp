/* History tile cache.
 *
 * A closed tile is immutable — the twelve hours it covers are over and the
 * box will never revise them — so it is worth keeping and worth trusting. The
 * trailing tile is still filling and is never written, because a cache entry
 * that is right for a minute is worse than no cache entry at all.
 *
 * That immutability is the whole transfer saving: the client sends the etags
 * it holds and the box answers with the difference, so opening the same week
 * twice costs one partial tile instead of a week.
 *
 * The samples are sealed with the same key as the snapshot. A history file is
 * a more complete picture of a household than any single reading, so leaving
 * it in the clear while sealing the snapshot would be sealing the front door
 * and leaving the records on the step.
 */

import { db } from './db'
import { cacheKey, seal, unseal, type Bytes } from './seal'
import { RESOLUTIONS, type ResolutionSpec } from '$lib/protocol/history'
import type { HistChunk, Resolution } from '$lib/protocol/messages'

export interface CachedTile {
  tileId: string
  etag: string
  startMs: number
  stepMs: number
  series: string[]
  /** Column-packed int32 LE, exactly as it came off the wire. */
  data: Uint8Array
}

function rowKey(siteId: string, tileId: string): string {
  return `${siteId}:${tileId}`
}

/**
 * Store a closed tile. Partial tiles are dropped on the floor by design.
 *
 * Never throws: a cache write that fails costs one refetch, and surfacing it
 * would be noise about something the user cannot act on.
 */
export async function saveTile(siteId: string, chunk: HistChunk): Promise<void> {
  if (chunk.partial) return

  try {
    const key = await cacheKey()
    const sealed = await seal(key, new Uint8Array(chunk.data) as Bytes)
    const database = await db()
    await database.put('tiles', {
      key: rowKey(siteId, chunk.tileId),
      siteId,
      res: chunk.res,
      tileId: chunk.tileId,
      etag: chunk.etag,
      startMs: chunk.startMs,
      stepMs: chunk.stepMs,
      series: chunk.series,
      data: sealed,
      savedAtMs: Date.now(),
    })
  } catch {
    /* A cache miss next time is the entire cost. */
  }
}

/**
 * Read whatever of a tile list is already held.
 *
 * Missing tiles are simply absent from the returned map — an empty result is
 * a first run, not a failure, and both mean "ask the box".
 */
export async function loadTiles(
  siteId: string,
  tileIds: readonly string[]
): Promise<Map<string, CachedTile>> {
  const out = new Map<string, CachedTile>()
  if (tileIds.length === 0) return out

  try {
    const database = await db()
    const key = await cacheKey()

    const rows = await Promise.all(tileIds.map((id) => database.get('tiles', rowKey(siteId, id))))

    for (const row of rows) {
      if (!row) continue
      const data = await unseal(key, row.data as Bytes)
      // A tile that will not open is a tile we do not have. Dropping it
      // silently is right: the box is about to send it again anyway.
      if (!data) continue
      out.set(row.tileId, {
        tileId: row.tileId,
        etag: row.etag,
        startMs: row.startMs,
        stepMs: row.stepMs,
        series: row.series,
        data,
      })
    }
  } catch {
    /* Fall through with whatever was read. */
  }

  return out
}

/** The `have` list for a query: what is held, so the box can send the rest. */
export function haveList(cached: ReadonlyMap<string, CachedTile>): { tileId: string; etag: string }[] {
  return [...cached.values()].map((t) => ({ tileId: t.tileId, etag: t.etag }))
}

/**
 * Drop tiles whose data the box no longer keeps.
 *
 * Without this the cache grows for as long as the app is installed, holding
 * years the box itself has already evicted. Cheap enough to run after a
 * query, which is the only time the answer changes.
 *
 * Every row is judged against its own resolution's retention. The store
 * holds a month of 5m beside two years of 1h, so a single cutoff would let
 * one answer's window evict the other resolution's whole cache — the year
 * chart self-destructing every time the day chart is opened.
 */
export async function pruneTiles(siteId: string, nowMs: number): Promise<number> {
  try {
    const database = await db()
    const tx = database.transaction('tiles', 'readwrite')
    let dropped = 0

    for (const row of await tx.store.getAll()) {
      if (row.siteId !== siteId) continue
      // A resolution this build has never heard of has no retention to judge
      // by, and data it cannot judge is data it must not delete.
      const spec: ResolutionSpec | undefined = RESOLUTIONS[row.res as Resolution]
      if (!spec) continue
      if (row.startMs >= nowMs - spec.retentionMs) continue
      await tx.store.delete(row.key)
      dropped += 1
    }

    await tx.done
    return dropped
  } catch {
    return 0
  }
}
