/* The sealed copy, from the phone that saved it to the phone that gets it back.
 *
 * Four things have to be true, and each one is a claim somebody could
 * reasonably ask us to prove:
 *
 *   a dump of everything Sourceful holds yields nothing a household would
 *     recognise — checked with a detector that is first proved sharp against
 *     the same payload unsealed;
 *   an old genuine blob cannot be put back, neither by the service refusing
 *     the write nor by the service lying about which version it is holding;
 *   a phone with nothing on it comes back with the passkey alone, as the same
 *     device the box already trusts — and, since Fredrik's change, does so
 *     without ever finding a switch: pairing holds the copy by default;
 *   and a passkey that cannot seal one — a device with no PRF — pays nothing
 *     at all, no prompt, no request, no row.
 *
 * The keychain outlives the install here, the way a synced passkey does, and
 * the storage does not. That is the whole situation this feature exists for.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { createPublicKey, generateKeyPairSync, sign, verify } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import 'fake-indexeddb/auto'
import {
  adoptRecoveredHome,
  escrowedHomes,
  markEscrowed,
  recoverFromEscrow,
  removeEscrowCopy,
  saveEscrowCopy,
} from '$lib/identity/escrow'
import { encodeRecoveryBlob, RECOVERY_BLOB_MAX_BYTES } from '$lib/identity/recovery-blob'
import { pairWithBox } from '$lib/identity/pairing'
import { buildEnrollmentUrl } from '$lib/identity/enrollment'
import {
  deviceStaticPublic,
  openVaultStore,
  resetIdentity,
  unlockWrappingKey,
  type WrappingKey,
} from '$lib/identity/vault'
import { db, type StoredSite } from '$lib/store/db'
import { installMockAuthenticator, newKeychain, type MockAuthenticator } from './support/passkey.ts'
import { startEscrowService, type EscrowService } from './support/escrow-service.ts'
import {
  ESCROW_ANSWER_BYTES,
  ESCROW_REQUEST_BYTES,
  pad,
} from '../escrow/src/escrow.ts'
import { writeMessage } from '../escrow/src/store.ts'

const BOX_KEY = new Uint8Array(32).fill(0xa7)
const RENDEZVOUS = new Uint8Array(32).fill(0xc3)
const LABEL = 'Home'

let service: EscrowService
let mock: MockAuthenticator
let dir = ''
const keychain = { current: newKeychain() }

/**
 * Every request body the app has sent, in order.
 *
 * Kept so a test can send one again exactly as it went out. A write carries a
 * signature now, so a replay that a test builds by hand is refused for the
 * wrong reason — it proves the signature check works and says nothing about the
 * rollback guard, which is the thing under test. Bytes somebody captured are
 * genuinely signed, and are what the guard has to refuse.
 */
let sent: string[] = []

/** The service, as the app's own options bag sees it. */
const wired = () => ({
  origin: service.origin,
  fetch: (async (input: RequestInfo | URL, init?: RequestInit) => {
    if (typeof init?.body === 'string') sent.push(init.body)
    return service.fetch(input, init)
  }) as typeof fetch,
})

/** A request nobody's client made now: bytes somebody kept and is sending again. */
const replay = (body: string) =>
  service.fetch(`${service.origin}/e`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body,
  })

/** The last put the app sent, whole and still signed. */
function lastSave(): string {
  const puts = sent.filter((body) => JSON.parse(body).op === 'put')
  const last = puts.at(-1)
  if (!last) throw new Error('the app sent no put, so there is nothing to replay')
  return last
}

beforeEach(async () => {
  // On a real file, not in memory, so `dump()` can read back everything the
  // service holds rather than only the columns this harness thought to ask for.
  dir = mkdtempSync(join(tmpdir(), 'ftw-escrow-e2e-'))
  service = startEscrowService('https://app.ftw.energy', join(dir, 'escrow.slots'))
  sent = []
  keychain.current = newKeychain()
  mock = installMockAuthenticator({ keychain: keychain.current })
  await wipeThisDevice()
})

afterEach(() => {
  mock.uninstall()
  service.close()
  rmSync(dir, { recursive: true, force: true })
  dir = ''
})

/**
 * A phone with nothing on it: no rows, no vault, no cache key.
 *
 * The stores are emptied rather than deleted, because deleting a database a
 * live connection still holds open blocks until that connection closes, and
 * nothing here closes it. The keychain is untouched — that is the point.
 */
async function wipeThisDevice(): Promise<void> {
  const database = await db()
  for (const store of ['sites', 'snapshot', 'tiles', 'meta', 'keys'] as const) {
    await database.clear(store)
  }
  await resetIdentity(openVaultStore())
}

function enrollmentUrl(): string {
  return buildEnrollmentUrl({
    boxStaticPublic: BOX_KEY,
    pairingCode: new Uint8Array(16).fill(0x11),
    rendezvousSecret: RENDEZVOUS,
    lanHint: '',
  })
}

/**
 * Pair, the way the pairing screen does — through the mock escrow, so the
 * copy pairing now holds by default lands in the test's own service. The
 * seal is awaited here (the app never does) so a test sees a settled world.
 */
async function pair(): Promise<string> {
  const { site, sealed } = await pairWithBox(enrollmentUrl(), { escrow: wired() })
  await sealed
  return site.siteId
}

const unlock = (): Promise<WrappingKey> => unlockWrappingKey(openVaultStore())

/**
 * Pair and write exactly one copy — version 1. Pairs by hand so the single
 * opt-in save is the first write, which is what the version-mechanics tests
 * narrate; the automatic-copy default is proved on its own, above.
 */
async function pairAndOptIn(): Promise<string> {
  const siteId = await pairByHand()
  await markEscrowed(siteId, true)
  expect(await saveEscrowCopy(openVaultStore(), await unlock(), wired())).toBe('saved')
  return siteId
}

/**
 * Pair without the automatic copy, for tests that drive the escrow by hand
 * and need to start from an empty one — the save/replay/version mechanics,
 * where an automatic v1 would only shift every number under test.
 */
async function pairByHand(): Promise<string> {
  const { site, sealed } = await pairWithBox(enrollmentUrl(), { escrow: wired(), holdCopy: false })
  await sealed
  return site.siteId
}

function findBytes(haystack: Uint8Array, needle: Uint8Array): boolean {
  if (needle.length === 0) return false
  outer: for (let i = 0; i + needle.length <= haystack.length; i++) {
    for (let j = 0; j < needle.length; j++) {
      if (haystack[i + j] !== needle[j]) continue outer
    }
    return true
  }
  return false
}

/** Which of the things a household would recognise are in these bytes. */
function leaks(dump: Uint8Array, siteId: string, scalar: Uint8Array): string[] {
  const text = new TextEncoder()
  const found: string[] = []
  const candidates: [string, Uint8Array][] = [
    ['label', text.encode(LABEL)],
    ['siteId', text.encode(siteId)],
    ['boxStaticKey', BOX_KEY],
    ['rendezvousSecret', RENDEZVOUS],
    ['deviceScalar', scalar],
  ]
  for (const [name, needle] of candidates) if (findBytes(dump, needle)) found.push(name)
  return found
}

// ---------------------------------------------------------------------------

describe('what Sourceful ends up holding', () => {
  it('dumps everything it has — the whole file — and gives nothing away', async () => {
    const siteId = await pairAndOptIn()
    const scalar = (await deviceStaticPublic(openVaultStore()))!

    // The control first. A detector that finds nothing proves nothing, so the
    // same needles must trip on the same payload before it is sealed.
    const plain = encodeRecoveryBlob({
      deviceScalar: new Uint8Array(32).fill(0x44),
      homes: [{ siteId, label: LABEL, boxStaticKey: BOX_KEY, rendezvousSecret: RENDEZVOUS }],
    })
    expect(leaks(plain, siteId, scalar).sort()).toEqual([
      'boxStaticKey',
      'label',
      'rendezvousSecret',
      'siteId',
    ])

    expect(leaks(service.dump(), siteId, scalar)).toEqual([])
  })

  it('holds one row: an opaque id, a number, and 512 bytes', async () => {
    await pairAndOptIn()

    const rows = service.rows()
    expect(rows).toHaveLength(1)
    expect(Object.keys(rows[0]!).sort()).toEqual(['blob', 'id', 'ver'])
    expect(rows[0]!.blob.length).toBe(RECOVERY_BLOB_MAX_BYTES)
    expect(rows[0]!.id).toHaveLength(43)
    // Nothing about which box, which household or when. The id is a function
    // of the passkey and a fixed salt and of nothing else on this device.
    expect(rows[0]!.id).not.toContain(LABEL)
  })

  it('writes the same length whatever the home is called', async () => {
    // The padding, seen from the outside. A copy whose length grew with the
    // name would let whoever holds it read something off it without a key.
    const siteId = await pairAndOptIn()
    const first = service.rows()[0]!.blob.length

    const database = await db()
    const row = (await database.get('sites', siteId)) as StoredSite
    await database.put('sites', { ...row, label: 'The house at the end of the lane' })
    expect(await saveEscrowCopy(openVaultStore(), await unlock(), wired())).toBe('saved')

    expect(service.rows()[0]!.blob.length).toBe(first)
  })
})

describe('an old copy cannot be put back', () => {
  it('refuses the write, and leaves the newer copy where it was', async () => {
    const siteId = await pairAndOptIn()
    // The exact bytes the app put on the wire for version 1, signature and all.
    const version1 = lastSave()
    await markEscrowed(siteId, true)
    expect(await saveEscrowCopy(openVaultStore(), await unlock(), wired())).toBe('saved')
    expect(service.rows()[0]!.ver).toBe(2)

    // Somebody who kept version 1 — from a backup, from the wire — puts it
    // back. It is the household's own genuine, signed write, so the signature
    // is no help here: the successor rule is what refuses it.
    const again = await replay(version1)

    expect(again.status).toBe(409)
    expect(service.rows()[0]!.ver, 'an old version was written back over a newer one').toBe(2)
  })

  it('cannot be resurrected by clearing the copy first', async () => {
    // The trap this design walked into once. A clear that deleted the row
    // would let versions start at 1 again, and version 1's ciphertext really
    // was sealed under version 1 — so whoever kept it could write it straight
    // back, and the household's next fresh install would be handed a home it
    // had removed. Clearing keeps the count going, so the write is refused.
    const siteId = await pairAndOptIn()
    const version1 = lastSave()

    await markEscrowed(siteId, false)
    expect(await saveEscrowCopy(openVaultStore(), await unlock(), wired())).toBe('cleared')
    expect(service.rows()[0]!.blob.length).toBe(0)

    const again = await replay(version1)

    expect(again.status).toBe(409)
    expect(service.rows()[0]!.blob.length, 'a cleared copy came back').toBe(0)

    await wipeThisDevice()
    await expect(recoverFromEscrow(wired())).resolves.toEqual([])
  })

  it('refuses an old copy handed back under a new version number', async () => {
    // The half the service cannot enforce, because it has no key. A service
    // that swapped the bytes and kept the number would otherwise hand a fresh
    // device a home its owner had removed, or a device that was locked out.
    const siteId = await pairAndOptIn()
    const old = service.rows()[0]!.blob.slice()

    await markEscrowed(siteId, true)
    expect(await saveEscrowCopy(openVaultStore(), await unlock(), wired())).toBe('saved')
    expect(service.rows()[0]!.ver).toBe(2)

    await wipeThisDevice()

    // A service telling the truth about the version and lying about the bytes.
    const lying: typeof fetch = async (input, init) => {
      const response = await service.fetch(input, init)
      if (response.status !== 200) return response
      const body = (await response.json()) as Record<string, unknown>
      if (!('blob' in body)) return new Response(JSON.stringify(body), { status: 200 })
      return new Response(
        JSON.stringify({ ...body, blob: btoa(String.fromCharCode(...old)) }),
        { status: 200, headers: { 'content-type': 'application/json' } }
      )
    }

    await expect(
      recoverFromEscrow({ origin: service.origin, fetch: lying })
    ).rejects.toMatchObject({ code: 'E_BLOB_LOCKED' })
  })
})

describe('who may write a household`s copy', () => {
  /* The hole this closes was written down in escrow/src/escrow.ts in as many
   * words: "Knowing an id is the authorisation: reading and writing both sit
   * behind it." So anyone who learned an id could write version+1 of anything
   * and destroy the spare copy. Reading is still the id alone, deliberately,
   * because a fresh install has a passkey and nothing else.
   */

  it('signs a save with a message the service builds the same way', async () => {
    // Two spellings of one canonical string, on opposite sides of a wire the
    // app must not import service code across. If they ever drift, every save
    // is refused and no test that checks only one side would notice — which is
    // the same argument that pins RECOVERY_BLOB_MAX_BYTES to ESCROW_BLOB_BYTES.
    await pairAndOptIn()
    const body = JSON.parse(lastSave()) as { id: string; version: number; blob: string; pub: string; sig: string }

    const blob = Uint8Array.from(atob(body.blob), (c) => c.charCodeAt(0))
    const key = createPublicKey({
      key: { kty: 'OKP', crv: 'Ed25519', x: body.pub },
      format: 'jwk',
    })

    expect(
      verify(null, writeMessage(body.id, body.version, blob), key, Buffer.from(body.sig, 'base64url')),
      'the app and the service do not agree on what a write says'
    ).toBe(true)
  })

  it('refuses a stranger who has the id, and leaves the copy where it was', async () => {
    // The id travels in every request, so anyone between the phone and the
    // service has it — and so does anyone who completed a passkey ceremony on
    // that credential. What they no longer have is the key.
    const siteId = await pairAndOptIn()
    const body = JSON.parse(lastSave()) as { id: string; version: number }
    const held = service.rows()[0]!

    const { publicKey, privateKey } = generateKeyPairSync('ed25519')
    const pub = Buffer.from((publicKey.export({ format: 'jwk' }) as { x: string }).x, 'base64url')
    const rubbish = new Uint8Array(RECOVERY_BLOB_MAX_BYTES).fill(0xee)
    const forged = {
      op: 'put',
      id: body.id,
      version: body.version + 1,
      blob: btoa(String.fromCharCode(...rubbish)),
      pub: pub.toString('base64url'),
      sig: sign(null, writeMessage(body.id, body.version + 1, rubbish), privateKey).toString('base64url'),
    }

    const answer = await replay(pad(forged, ESCROW_REQUEST_BYTES))

    expect(answer.status).toBe(403)
    expect(service.rows()[0]!.ver, 'a stranger pushed the version on').toBe(held.ver)
    expect(Array.from(service.rows()[0]!.blob), 'a stranger overwrote the copy').toEqual(
      Array.from(held.blob)
    )
    // And the household still gets their home back, which is what the copy is
    // for and what a destroyed one would have cost them.
    await wipeThisDevice()
    const homes = await recoverFromEscrow(wired())
    expect(homes.map((h) => h.siteId)).toEqual([siteId])
  })
})

describe('a phone with nothing on it', () => {
  it('comes back with the passkey alone, as the device the box already trusts', async () => {
    const siteId = await pairAndOptIn()
    const before = (await deviceStaticPublic(openVaultStore()))!

    // The install is gone: no rows, no vault, no cache key. The passkey is not.
    await wipeThisDevice()
    expect(await deviceStaticPublic(openVaultStore())).toBeNull()

    const homes = await recoverFromEscrow(wired())
    expect(homes.map((h) => h.label)).toEqual([LABEL])
    expect(homes[0]!.siteId).toBe(siteId)
    expect(await adoptRecoveredHome(homes[0]!)).toBe(siteId)

    // The same Noise static, which is what makes this a reconnection rather
    // than a stranger asking to be let in — there is no pairing code, and the
    // box has nothing to accept.
    expect(Array.from((await deviceStaticPublic(openVaultStore()))!)).toEqual(Array.from(before))

    const row = (await (await db()).get('sites', siteId)) as StoredSite
    expect(Array.from(row.boxStaticKey)).toEqual(Array.from(BOX_KEY))
    expect(Array.from(row.rendezvousSecret!)).toEqual(Array.from(RENDEZVOUS))
    // Still opted in, so the next save rebuilds the copy from the disk rather
    // than quietly dropping the household out of the escrow it recovered from.
    expect(row.escrow).toBe(true)
    // And no pairing code: it was spent at the first handshake and the box
    // remembers this device key instead.
    expect(row.pairingCode).toBeUndefined()
  })

  it('is told there is nothing held, rather than shown an error', async () => {
    // The ordinary answer for a passkey that never escrowed anything. Shown as
    // a failure it sends someone hunting for a fault that is not there.
    await pairByHand()
    await wipeThisDevice()

    await expect(recoverFromEscrow(wired())).resolves.toEqual([])
  })

  it('cannot be recovered by a different passkey', async () => {
    await pairAndOptIn()
    await wipeThisDevice()

    // Another account's keychain: a different credential, a different PRF
    // seed, and therefore a different lookup id. There is nothing under it.
    mock.uninstall()
    mock = installMockAuthenticator({ keychain: newKeychain() })
    await pairByHand()

    await expect(recoverFromEscrow(wired())).resolves.toEqual([])
  })
})

describe('what the wire gives away', () => {
  /**
   * Every byte the app sent and every byte it got back, per request.
   *
   * The app's own client, not a fixture: the copy of ESCROW_REQUEST_BYTES in
   * src/lib/identity/escrow.ts is private to that file, so the only honest way
   * to pin it to the service's is to drive one through the other and measure
   * what came out.
   */
  function recorded(): { calls: { sent: number; back: number }[]; fetch: typeof fetch } {
    const calls: { sent: number; back: number }[] = []
    const bytes = (body: BodyInit | null | undefined) =>
      typeof body === 'string' ? new TextEncoder().encode(body).length : -1
    const wrapped: typeof fetch = async (input, init) => {
      const response = await service.fetch(input, init)
      const text = await response.clone().text()
      calls.push({ sent: bytes(init?.body), back: new TextEncoder().encode(text).length })
      return response
    }
    return { calls, fetch: wrapped }
  }

  it('is one size for a save, a read, a miss and a clear', async () => {
    // The defect this rule exists for, and it was found in operation rather
    // than in review. The proxy in front of the escrow kept one line per
    // request with the URI, the headers and both address fields deleted — and
    // the fields the filter left behind told the three operations apart by
    // size alone: a put read 769 bytes and answered 13, a read of a copy that
    // was there read 63 and answered 707, and one that was not read 63 and
    // answered 2. Beside a stable pseudonym and a timestamp, that is a
    // household's activity record, which is the one thing this service must
    // not keep.
    //
    // Deleting the logs fixed the instance. This is the class: with every
    // request one length and every answer one length, a layer that counts
    // bytes has nothing to count.
    const { calls, fetch: watched } = recorded()
    const wire = () => ({ origin: service.origin, fetch: watched })

    // A save, which is a read of what is held and then a write.
    const siteId = await pairAndOptIn()
    await markEscrowed(siteId, true)
    expect(await saveEscrowCopy(openVaultStore(), await unlock(), wire())).toBe('saved')

    // A read that finds a copy.
    await wipeThisDevice()
    expect((await recoverFromEscrow(wire())).length).toBe(1)

    // A read that finds none: another account's keychain, so another id.
    mock.uninstall()
    mock = installMockAuthenticator({ keychain: newKeychain() })
    await pairByHand()
    expect(await recoverFromEscrow(wire())).toEqual([])

    // And a clear, which is a read and a write of zero bytes.
    const second = await pairAndOptIn()

    await markEscrowed(second, false)
    expect(await saveEscrowCopy(openVaultStore(), await unlock(), wire())).toBe('cleared')

    // Six: a save reads before it writes, a read is one, a miss is one, and a
    // clear reads before it writes zero bytes. Fewer means something above
    // stopped making the call this is measuring.
    expect(calls.length, 'no requests were watched, so this test proves nothing')
      .toBeGreaterThanOrEqual(6)
    expect(
      [...new Set(calls.map((c) => c.sent))],
      'a request length said which operation it was'
    ).toEqual([ESCROW_REQUEST_BYTES])
    expect(
      [...new Set(calls.map((c) => c.back))],
      'an answer length said whether a copy was there'
    ).toEqual([ESCROW_ANSWER_BYTES])
  })
})

describe('a copy held by default', () => {
  it('is sealed by pairing alone, with no second prompt, and opens on a fresh phone', async () => {
    // The change Fredrik asked for: the way back exists from the first
    // device without anyone finding a switch. Pairing is one passkey
    // ceremony, and the copy rides that same unlocked key — the prompt
    // count after pairing is exactly the pairing's own.
    const promptsBefore = mock.createCalls + mock.getCalls
    const siteId = await pair()

    expect(await escrowedHomes(), 'pairing did not hold a copy by default').not.toEqual([])
    expect(service.rows()[0]!.blob.length).toBe(RECOVERY_BLOB_MAX_BYTES)
    expect(
      mock.createCalls + mock.getCalls - promptsBefore,
      'the automatic copy cost a second passkey prompt'
    ).toBe(1)

    // And it is a real way back: a wiped phone recovers with the passkey
    // alone, having opted into nothing.
    await wipeThisDevice()
    const back = await recoverFromEscrow(wired())
    expect(back.map((h) => h.siteId)).toEqual([siteId])
  })

  it('empties on sign-out', async () => {
    const siteId = await pair()
    expect(service.rows()[0]!.blob.length).toBe(RECOVERY_BLOB_MAX_BYTES)

    expect(await removeEscrowCopy(wired())).toBe('removed')

    // An id and a number survive, with nothing sealed under them. That is the
    // price of the rollback guard and escrow/README.md names it in the same
    // words rather than claiming the row is gone.
    const [row] = service.rows()
    expect(row!.blob.length).toBe(0)
    expect(row!.ver).toBe(2)
    void siteId
    await wipeThisDevice()
    await expect(recoverFromEscrow(wired())).resolves.toEqual([])
  })

  it('does not mark a copy before Sourceful confirms the write', async () => {
    const { site, sealed } = await pairWithBox(enrollmentUrl(), {
      escrow: {
        origin: service.origin,
        fetch: async () => {
          throw new TypeError('offline')
        },
      },
    })
    await sealed

    const row = await (await db()).get('sites', site.siteId)
    expect(row?.escrow).not.toBe(true)
    expect(service.rows()).toEqual([])
  })
})

describe('a passkey that cannot seal a copy', () => {
  it('holds nothing, and was never asked to', async () => {
    // A device with no PRF derives no escrow id, on purpose — a copy sealed
    // under a key that sits unwrapped on disk is one anyone holding the
    // phone could upload. So the whole feature stays off for it, silently:
    // no row, no request, exactly where it was before the escrow existed.
    mock.prf = 'none'
    keychain.current = newKeychain()

    await pair()

    expect(await escrowedHomes()).toEqual([])
    expect(service.rows()).toEqual([])
    expect(service.requests, 'a phone that cannot seal was still asked about').toBe(0)
  })

  it('signs out with no passkey prompt and no request', async () => {
    mock.prf = 'none'
    keychain.current = newKeychain()
    await pair()
    const promptsBefore = mock.getCalls

    expect(await removeEscrowCopy(wired())).toBe('nothing-to-remove')

    expect(mock.getCalls, 'signing out asked for a passkey it did not need').toBe(promptsBefore)
    expect(service.requests, 'signing out reached for a copy that was never made').toBe(0)
  })
})
