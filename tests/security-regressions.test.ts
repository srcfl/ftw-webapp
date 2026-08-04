/* Regressions for what the adversarial review found.
 *
 * Each of these passed review as correct code and was wrong anyway. They are
 * kept together because they share a shape: a security property that held in
 * the happy path and quietly did not hold at the edge.
 */

import { describe, it, expect, beforeEach } from 'vitest'
import 'fake-indexeddb/auto'
import { x25519 } from '@noble/curves/ed25519.js'
import { HandshakeState, NoiseError } from '$lib/crypto/noise'
import { RelayCarrier, CLOSE_EPOCH, CLOSE_ROTATED } from '$lib/carrier/relay'
import { rendezvousHandle, currentEpoch } from '$lib/carrier/rendezvous'
import { db, resetDbForTests } from '$lib/store/db'
import { cacheKey, sealJson, unsealJson } from '$lib/store/seal'
import { saveSnapshot, loadSnapshot } from '$lib/store/snapshot'
import { forgetEverything } from '$lib/store/reset'

// ---------------------------------------------------------------------------

describe('a handshake cannot be split twice', () => {
  // Splitting twice mints two send ciphers holding the same key, both at
  // nonce 0. The first frame of each then encrypts under an identical
  // (key, nonce) pair, which hands an observer the XOR of two plaintexts and
  // makes Poly1305 authenticators forgeable. The obvious way to write
  // reconnection is to keep the handshake and split again.
  async function completedPair() {
    const boxSecret = x25519.utils.randomSecretKey()
    const boxPublic = x25519.getPublicKey(boxSecret)
    const appSecret = x25519.utils.randomSecretKey()

    const app = HandshakeState.initiator({
      staticKey: { secretKey: appSecret, publicKey: x25519.getPublicKey(appSecret) },
      remoteStatic: boxPublic,
    })
    const box = HandshakeState.responder({
      staticKey: { secretKey: boxSecret, publicKey: boxPublic },
    })

    await box.readMessage(await app.writeMessage())
    await app.readMessage(await box.writeMessage())
    return { app, box }
  }

  it('refuses a second split', async () => {
    const { app } = await completedPair()
    expect(() => app.split()).not.toThrow()
    expect(() => app.split()).toThrow(NoiseError)
  })

  it('names the state rather than failing obscurely', async () => {
    const { box } = await completedPair()
    box.split()
    try {
      box.split()
      expect.unreachable('second split should throw')
    } catch (e) {
      expect((e as NoiseError).message).toMatch(/already split/)
    }
  })
})

// ---------------------------------------------------------------------------

describe('the relay cannot choose our rendezvous handle', () => {
  // The handle is derived from the epoch, so a relay free to name any epoch
  // can make the client compute and publish handle(secret, N) for every N it
  // likes — a table of that household's future handles that survives any
  // later fix, because the secret cannot be rotated remotely.
  const SECRET = new Uint8Array(32).fill(7)

  /** Sockets in construction order, so a test can drive the newest one. */
  let sockets: FakeSocket[] = []
  let dialled: string[] = []

  class FakeSocket {
    onopen: (() => void) | null = null
    onclose: ((e: { code: number; reason: string }) => void) | null = null
    onmessage: ((e: MessageEvent) => void) | null = null
    onerror: (() => void) | null = null
    binaryType = 'arraybuffer'
    readyState = 1

    constructor(url: string) {
      dialled.push(url)
      sockets.push(this)
    }
    send(): void {}
    close(): void {}
  }

  beforeEach(() => {
    sockets = []
    dialled = []
  })

  const build = () =>
    new RelayCarrier({
      url: 'ws://relay.example',
      secret: SECRET,
      WebSocketImpl: FakeSocket as unknown as typeof WebSocket,
      random: () => 0,
    })

  /**
   * Close the newest socket and wait for the redial.
   *
   * The redial is scheduled on a timer, so reading the dialled list
   * synchronously returns the URL from *before* the close — which made three
   * of these tests pass while asserting nothing.
   */
  const closeAndRedial = async (code: number, reason: string) => {
    const before = dialled.length
    sockets.at(-1)!.onclose?.({ code, reason })
    for (let i = 0; i < 50 && dialled.length === before; i++) {
      await new Promise((r) => setTimeout(r, 5))
    }
    expect(dialled.length, 'carrier should have redialled').toBeGreaterThan(before)
  }

  const epochOf = (url: string) => Number(url.split('/r/')[1]!.split('/')[0])

  it('ignores an epoch far from our own clock', async () => {
    const c = build()
    const ours = currentEpoch(Date.now())

    await closeAndRedial(CLOSE_EPOCH, '9000000')

    const next = dialled.at(-1)!
    expect(Math.abs(epochOf(next) - ours)).toBeLessThanOrEqual(1)
    expect(next).not.toContain(rendezvousHandle(SECRET, 9000000))
    c.close()
  })

  it('treats an empty reason as no correction rather than epoch zero', async () => {
    // Number('') is 0, which would pin the client to a single handle forever
    // — exactly the permanent identifier rotation exists to prevent.
    const c = build()
    const ours = currentEpoch(Date.now())

    await closeAndRedial(CLOSE_EPOCH, '')

    expect(epochOf(dialled.at(-1)!)).not.toBe(0)
    expect(Math.abs(epochOf(dialled.at(-1)!) - ours)).toBeLessThanOrEqual(1)
    c.close()
  })

  it('still accepts a correction small enough to be real clock drift', async () => {
    // The mechanism must keep working for the case it exists for: a phone
    // whose clock drifted, or that woke across an hour boundary.
    const c = build()
    const ours = currentEpoch(Date.now())

    await closeAndRedial(CLOSE_ROTATED, String(ours + 1))

    expect(epochOf(dialled.at(-1)!)).toBe(ours + 1)
    c.close()
  })

  it('rejects reasons that are not plainly an integer', async () => {
    const c = build()
    const ours = currentEpoch(Date.now())

    for (const reason of ['NaN', '1e9', 'Infinity', '0x10', 'abc']) {
      await closeAndRedial(CLOSE_EPOCH, reason)
      expect(Math.abs(epochOf(dialled.at(-1)!) - ours)).toBeLessThanOrEqual(1)
    }
    c.close()
  })
})

// ---------------------------------------------------------------------------

describe('forgetting a device forgets the readings too', () => {
  beforeEach(async () => {
    resetDbForTests()
    const database = await db()
    for (const s of ['meta', 'keys', 'sites', 'snapshot', 'tiles', 'prefs'] as const) {
      await database.clear(s)
    }
  })

  it('leaves nothing that can paint the previous household on first frame', async () => {
    // The failure this replaces: identity was cleared from one database while
    // the sealed snapshot and its key stayed in another, so a phone handed on
    // would still show the last owner's home.
    await saveSnapshot({
      siteId: 'sim-0001',
      savedAtMs: Date.now(),
      uptimeMs: 1000,
      fields: { 2: 11400 },
      sources: {},
      dispatchBlockedBy: [],
      dict: {},
      controlRev: 1,
    })
    expect(await loadSnapshot('sim-0001')).not.toBeNull()

    const vault = memoryVault()
    await forgetEverything(vault)

    expect(await loadSnapshot('sim-0001')).toBeNull()
  })

  it('destroys the key, not just the rows', async () => {
    const before = await cacheKey()
    const sealed = await sealJson(before, { gridW: 11400 })

    await forgetEverything(memoryVault())

    // A fresh key must not open what the old one sealed, or "start over"
    // would leave recoverable data behind on the disk.
    const after = await cacheKey()
    expect(after).not.toBe(before)
    expect(await unsealJson(after, sealed)).toBeNull()
  })

  it('keeps preferences, which are not the previous owner data', async () => {
    const database = await db()
    await database.put('prefs', 'dark', 'theme')

    await forgetEverything(memoryVault())

    // Losing the theme would make a reset feel like a fault.
    expect(await database.get('prefs', 'theme')).toBe('dark')
  })
})

function memoryVault() {
  const m = new Map<string, unknown>()
  return {
    get: async (k: string) => m.get(k),
    put: async (k: string, v: unknown) => void m.set(k, v),
    del: async (k: string) => void m.delete(k),
  }
}
