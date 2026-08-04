/* The cold start.
 *
 * The claim this app is built on: press the icon and readings are on screen
 * before anything touches the network. These tests hold that claim to
 * account — and check that what sits on disk is sealed.
 */

import { describe, it, expect, beforeEach } from 'vitest'
import 'fake-indexeddb/auto'
import { Session } from '$lib/protocol/session'
import { LoopbackCarrier } from '$lib/carrier/loopback'
import { SimBox } from '$lib/sim/box'
import { db, resetDbForTests } from '$lib/store/db'
import { cacheKey, seal, unseal, sealJson, unsealJson, type Bytes } from '$lib/store/seal'
import {
  saveSnapshot,
  loadSnapshot,
  snapshotFromSession,
  sessionPatchFromSnapshot,
} from '$lib/store/snapshot'


/**
 * Real timers here, unlike the pure-protocol tests.
 *
 * fake-indexeddb drives its own transactions on timers, so freezing the clock
 * deadlocks every database call. The loopback carrier runs at zero latency in
 * these tests, so a few real ticks are enough to settle it.
 */
async function settle(times = 6) {
  for (let i = 0; i < times; i++) await new Promise((r) => setTimeout(r, 5))
}

/** Uint8Array identity across realms is unreliable; compare contents. */
const bytes = (u: Uint8Array) => Array.from(u)

async function wipe() {
  resetDbForTests()
  const database = await db()
  for (const store of ['meta', 'keys', 'sites', 'snapshot', 'tiles', 'prefs'] as const) {
    await database.clear(store)
  }
}

describe('sealing the local projection', () => {
  beforeEach(wipe)

  it('round trips bytes', async () => {
    const key = await cacheKey()
    const plaintext = new TextEncoder().encode('11400 W from the grid') as Bytes

    const sealed = await seal(key, plaintext)
    expect(bytes((await unseal(key, sealed))!)).toEqual(bytes(plaintext))
  })

  it('never stores readings in the clear', async () => {
    const key = await cacheKey()
    const sealed = await sealJson(key, { gridW: 11400, houseName: 'Ahlgren' })

    const asText = new TextDecoder().decode(sealed)
    expect(asText).not.toContain('11400')
    expect(asText).not.toContain('Ahlgren')
    expect(asText).not.toContain('gridW')
  })

  it('uses a fresh nonce for every seal', async () => {
    const key = await cacheKey()
    const a = await sealJson(key, { x: 1 })
    const b = await sealJson(key, { x: 1 })

    // Identical plaintext must not produce identical ciphertext, or the
    // relative sizes of two stored snapshots would leak.
    expect(bytes(a)).not.toEqual(bytes(b))
  })

  it('reuses the same key across calls rather than regenerating', async () => {
    const a = await cacheKey()
    const b = await cacheKey()
    // A new key each call would silently orphan everything already stored.
    const out = await unseal(b, await seal(a, new Uint8Array([1, 2, 3]) as Bytes))
    expect(bytes(out!)).toEqual([1, 2, 3])
  })

  it('keeps the key non-extractable', async () => {
    const key = await cacheKey()
    expect(key.extractable).toBe(false)
    await expect(crypto.subtle.exportKey('raw', key)).rejects.toThrow()
  })

  it('returns null instead of throwing when a blob will not open', async () => {
    const key = await cacheKey()
    const sealed = await sealJson(key, { x: 1 })
    sealed.set([sealed[sealed.length - 1]! ^ 0xff], sealed.length - 1) // corrupt the tag

    // A cache that fails to open should drop the app to its empty state, not
    // break it. Throwing here would turn a stale key into a dead app.
    expect(await unsealJson(key, sealed)).toBeNull()
    expect(await unseal(key, new Uint8Array(4) as Bytes)).toBeNull()
  })
})

describe('cold start paints from cache', () => {
  beforeEach(wipe)

  it('restores real readings with no carrier at all', async () => {
    // First run: connect, receive, persist.
    const box = new SimBox({ now: () => Date.now() })
    const first = new Session({ build: 'test' })
    first.connect(new LoopbackCarrier(box, { latencyMs: 0 }))
    await settle()

    expect(first.state.phase).toBe('streaming')
    const live = new Map(first.state.fields)
    await saveSnapshot(snapshotFromSession('sim-0001', first.state))

    // Second run: a brand new session, nothing connected.
    const cached = await loadSnapshot('sim-0001')
    expect(cached).not.toBeNull()

    const second = new Session({ build: 'test' })
    second.restore(sessionPatchFromSnapshot(cached!))

    // Compared entry by entry: JSON has no negative zero, so a cached -0 comes
    // back as 0 and toEqual on the Map would call that a difference. The
    // reading is identical in every sense that matters.
    expect([...second.state.fields.entries()].map(([k, v]) => [k, v === 0 ? 0 : v])).toEqual(
      [...live.entries()].map(([k, v]) => [k, v === 0 ? 0 : v])
    )
    expect(second.state.carrier).toBe('cache')
    // Cache is a carrier, not a failure. The app has something honest to show.
    expect(second.state.phase).toBe('idle')
  })

  it('keeps source freshness across the restart, not just the numbers', async () => {
    const box = new SimBox({
      now: () => Date.now(),
      faults: { sourceStates: { 'inverter.sungrow': 'stale' } },
    })
    const first = new Session({ build: 'test' })
    first.connect(new LoopbackCarrier(box, { latencyMs: 0 }))
    await settle()

    await saveSnapshot(snapshotFromSession('sim-0001', first.state))

    const second = new Session({ build: 'test' })
    second.restore(sessionPatchFromSnapshot((await loadSnapshot('sim-0001'))!))

    // Without this the app would restore stale numbers and present them as
    // fresh, which is the one thing it must never do.
    expect(second.worstSourceState(['inverter.sungrow'])).toBe('stale')
  })

  it('does not let a restore overwrite a live stream', async () => {
    const box = new SimBox({ now: () => Date.now() })
    const session = new Session({ build: 'test' })
    session.connect(new LoopbackCarrier(box, { latencyMs: 0 }))
    await settle()

    const live = new Map(session.state.fields)
    session.restore({ fields: new Map([[2, 999999]]) })

    // A late cache read must never clobber fresher data.
    expect(session.state.fields).toEqual(live)
    expect(session.state.carrier).toBe('relay')
  })

  it('reports nothing cached rather than failing on a first run', async () => {
    expect(await loadSnapshot('never-seen')).toBeNull()
  })
})
