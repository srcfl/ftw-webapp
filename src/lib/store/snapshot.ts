/* Snapshot cache — what the app draws in its first frame.
 *
 * The read is started by a small inline script in index.html, before this
 * bundle has even been parsed. By the time Svelte mounts, the data is usually
 * already in hand. That ordering is the difference between an app and a web
 * page, and it is why the boot read lives in the document rather than here.
 *
 * Writes are throttled: at 1 Hz, sealing and storing every delta would spend
 * more time in IndexedDB than in rendering, and nothing is gained. What
 * matters is that a snapshot exists and is roughly current, not that it is
 * exact to the second.
 */

import { db, type StoredSnapshot } from './db'
import { cacheKey, sealJson, unsealJson, type Bytes } from './seal'
import type { SessionState } from '$lib/protocol/session'
import type { Source } from '$lib/protocol/types'

/** How often a live stream is allowed to hit disk. */
const WRITE_INTERVAL_MS = 15_000

/** Set by the inline boot script in index.html. */
declare global {
  interface Window {
    __ftwBoot: Promise<{ siteId: string; sealed: Bytes } | null> | undefined
  }
}

export function snapshotFromSession(siteId: string, s: SessionState): StoredSnapshot {
  return {
    siteId,
    savedAtMs: Date.now(),
    uptimeMs: s.uptimeMs,
    fields: Object.fromEntries(s.fields),
    sources: Object.fromEntries(s.sources),
    dispatchBlockedBy: [...s.dispatchBlockedBy],
    dict: s.dict,
    controlRev: s.controlRev,
  }
}

export async function saveSnapshot(snap: StoredSnapshot): Promise<void> {
  const key = await cacheKey()
  const sealed = await sealJson(key, snap)
  const database = await db()
  await database.put('snapshot', { siteId: snap.siteId, sealed } as never)
}

export async function loadSnapshot(siteId: string): Promise<StoredSnapshot | null> {
  const database = await db()
  const row = (await database.get('snapshot', siteId)) as unknown as
    | { siteId: string; sealed: Bytes }
    | undefined
  if (!row?.sealed) return null

  const key = await cacheKey()
  return unsealJson<StoredSnapshot>(key, row.sealed)
}

/**
 * Pick up whatever the inline boot script started.
 *
 * Returns null on a first run, a cleared cache, or a key that no longer
 * opens the blob. All three mean the same thing to the app — show the empty
 * state and fetch — so none of them is treated as an error.
 */
export async function takeBootSnapshot(): Promise<StoredSnapshot | null> {
  const boot = window.__ftwBoot
  if (!boot) return null

  try {
    const row = await boot
    if (!row) return null
    const key = await cacheKey()
    return unsealJson<StoredSnapshot>(key, row.sealed)
  } catch {
    return null
  } finally {
    // One shot. A later reconnect should read fresh state, not replay boot.
    window.__ftwBoot = undefined
  }
}

/**
 * Restores a cached snapshot into the shape the session exposes.
 *
 * The row's type is a claim about what was written, not a fact about what
 * comes back: an older build wrote fewer keys, and the cache carries no
 * version to tell one from the other. So every part is defaulted here, at the
 * one point where the disk stops and typed state begins.
 *
 * Missing is not the same as empty anywhere above this. A patch is applied by
 * spreading it over the current state, and a spread copies a key whatever it
 * holds — so an absent dictionary arrived as undefined rather than as the
 * empty one the session starts with, and the first getter to index it threw
 * while a view was being built. That is a blank app, and reloading is never
 * the fix in this one.
 */
export function sessionPatchFromSnapshot(snap: StoredSnapshot): Partial<SessionState> {
  const row: Partial<StoredSnapshot> = snap
  return {
    uptimeMs: row.uptimeMs ?? 0,
    controlRev: row.controlRev ?? 0,
    dict: (row.dict ?? {}) as SessionState['dict'],
    fields: new Map(Object.entries(row.fields ?? {}).map(([k, v]) => [Number(k), v])),
    sources: new Map(Object.entries((row.sources ?? {}) as Record<string, Source>)),
    dispatchBlockedBy: row.dispatchBlockedBy ?? [],
  }
}

/** Throttles writes so a 1 Hz stream does not thrash the disk. */
export class SnapshotWriter {
  #lastWriteMs = 0
  #pending: StoredSnapshot | null = null
  #timer: ReturnType<typeof setTimeout> | null = null
  #stopped = false

  offer(snap: StoredSnapshot): void {
    if (this.#stopped) return
    this.#pending = snap

    const since = Date.now() - this.#lastWriteMs
    if (since >= WRITE_INTERVAL_MS) {
      void this.#flush()
      return
    }

    this.#timer ??= setTimeout(() => void this.#flush(), WRITE_INTERVAL_MS - since)
  }

  /** Called when the page is hidden — the last chance to persist. */
  async flushNow(): Promise<void> {
    await this.#flush()
  }

  /**
   * Finished. Not paused — this writer never writes again.
   *
   * Cancelling the timer is not enough, because the frame it was going to
   * write is still held here and every path that flushes by hand would still
   * write it: the shell flushes on 'visibilitychange', which is exactly what
   * happens when someone signs out and switches app. That write lands after
   * the disk was cleared, so the household this phone has just left comes
   * back sealed under a cache key minted on demand to replace the one the
   * sign-out removed a moment earlier. Dropping the frame costs at most the
   * last fifteen seconds of a cache the box holds the record for.
   */
  stop(): void {
    if (this.#timer) clearTimeout(this.#timer)
    this.#timer = null
    this.#pending = null
    this.#stopped = true
  }

  async #flush(): Promise<void> {
    if (this.#timer) {
      clearTimeout(this.#timer)
      this.#timer = null
    }

    const snap = this.#pending
    if (!snap) return
    this.#pending = null
    this.#lastWriteMs = Date.now()

    try {
      await saveSnapshot(snap)
    } catch {
      // A failed cache write costs a slower next start and nothing else.
      // Surfacing it would be noise about something the user cannot act on.
    }
  }
}
