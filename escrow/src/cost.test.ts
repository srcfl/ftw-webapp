// @vitest-environment node

/* What a request costs, and why it must not depend on what is stored.
 *
 * store.test.ts is about the bytes the file leaves behind. This is about the
 * fifth place the sentence at the top of store.ts was false, and the first one
 * that was not on the disk at all: a read used to stop the moment an image
 * failed its digest, so a bucket with nobody in it cost a quarter of what a
 * bucket with somebody in it cost. Bucket occupancy is a household counter, and
 * a bucket going from empty to occupied is an arrival. Every answer was already
 * padded to one length, which fixed the size channel and did nothing about the
 * clock.
 *
 * MOSTLY NOT A CLOCK, DELIBERATELY. A wall-clock assertion on a shared machine
 * is a test people learn to ignore, and the property is not really about
 * microseconds — it is about work. So the instruments here count the work: how
 * many digests the store takes, how many signature verifications, and how many
 * bytes the handler base64-encodes. Those numbers are exact, they are the
 * mechanism rather than a symptom of it, and each of them was different between
 * the three cases before the fix. One clock test comes last, because a count
 * that is equal while the time is not would be its own kind of wrong.
 */

import { describe, it, expect, afterEach, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/**
 * The counters, hoisted because vi.mock's factory runs before the imports.
 *
 * `on` gates them so that setting a file up — which does a great deal of
 * hashing and signing — does not land in the numbers being compared.
 */
const tally = vi.hoisted(() => ({ on: false, digests: 0, hashed: 0, verifies: 0, encoded: 0 }))

vi.mock('node:crypto', async (importOriginal) => {
  const real = await importOriginal<typeof import('node:crypto')>()
  return {
    ...real,
    default: real,
    createHash(...args: Parameters<typeof real.createHash>) {
      const hash = real.createHash(...args)
      if (tally.on) tally.digests++
      const update = hash.update.bind(hash)
      hash.update = ((data: never, encoding: never) => {
        if (tally.on) {
          tally.hashed += typeof data === 'string' ? Buffer.byteLength(data, encoding) : (data as Uint8Array).length
        }
        return update(data, encoding)
      }) as typeof hash.update
      return hash
    },
    verify(...args: Parameters<typeof real.verify>) {
      if (tally.on) tally.verifies++
      return (real.verify as (...a: unknown[]) => boolean)(...args)
    },
  }
})

// Static, because vitest hoists the vi.mock above the imports: store.ts is
// loaded after the factory is registered and gets the counting createHash.
import { createHash, generateKeyPairSync, randomBytes, sign as signWith } from 'node:crypto'
import {
  BLOB_BYTES,
  bucketOf,
  bucketsFor,
  openSlotStore,
  WAYS,
  writeMessage,
  type EscrowStore,
} from './store.ts'
import { ESCROW_REQUEST_BYTES, handle } from './escrow.ts'

// The handler builds base64 with the global btoa, so counting what goes into it
// is how "the same bytes are encoded whether or not there is a copy" is
// measured without reaching inside the module.
const realBtoa = globalThis.btoa
globalThis.btoa = (text: string): string => {
  if (tally.on) tally.encoded += text.length
  return realBtoa(text)
}

// ---------------------------------------------------------------------------

let dir = ''
const open: EscrowStore[] = []

afterEach(() => {
  tally.on = false
  for (const store of open.splice(0)) {
    try {
      store.close()
    } catch {
      // Already closed.
    }
  }
  if (dir) rmSync(dir, { recursive: true, force: true })
  dir = ''
})

const HOUSEHOLDS = 256
const BUCKETS = bucketsFor(HOUSEHOLDS)

interface Household {
  id: string
  writeKey: Buffer
  /** A signature over this household's own id. */
  save: (version: number, blob: Uint8Array) => Buffer
  /** A signature over somebody else's, which is what an outsider sends. */
  saveAs: (id: string, version: number, blob: Uint8Array) => Buffer
}

function household(seed: Buffer): Household {
  const id = seed.toString('base64url')
  const { publicKey, privateKey } = generateKeyPairSync('ed25519')
  const writeKey = Buffer.from((publicKey.export({ format: 'jwk' }) as { x: string }).x, 'base64url')
  const saveAs = (over: string, version: number, blob: Uint8Array): Buffer =>
    signWith(null, writeMessage(over, version, blob), privateKey)
  return { id, writeKey, save: (version, blob) => saveAs(id, version, blob), saveAs }
}

/** Seeds that land on bucket `at`. Which bucket an id belongs to is fixed. */
function landingOn(at: number, count: number, tag: string): Buffer[] {
  const out: Buffer[] = []
  for (let i = 0; out.length < count; i++) {
    const seed = createHash('sha256').update(`${tag}-${i}`).digest()
    if (bucketOf(seed, BUCKETS) === at) out.push(seed)
  }
  return out
}

/**
 * A file with three buckets that differ only in how many households are in
 * them: bucket 0 empty, bucket 1 holding one, bucket 2 holding WAYS.
 *
 * And for each, an id that lands on it and was never written — so the three can
 * be compared on reads that all MISS, which is the comparison the leak was
 * found on. A hit doing more work than a miss is a separate question and the
 * tests below ask it separately.
 */
async function threeBuckets(): Promise<{
  store: EscrowStore
  miss: string[]
  hit: string[]
  outsider: ReturnType<typeof household>
}> {
  dir = mkdtempSync(join(tmpdir(), 'ftw-cost-'))
  const store = openSlotStore(join(dir, 'escrow.slots'), { households: HOUSEHOLDS })
  open.push(store)

  const one = landingOn(1, 1, 'in').map(household)
  const many = landingOn(2, WAYS, 'in').map(household)
  const blob = new Uint8Array(randomBytes(BLOB_BYTES))
  for (const who of [...one, ...many]) {
    expect(
      await store.write({ id: who.id, version: 1, blob, writeKey: who.writeKey, signature: who.save(1, blob) })
    ).toBe('written')
  }

  return {
    store,
    miss: [0, 1, 2].map((at) => landingOn(at, 1, 'out')[0]!.toString('base64url')),
    hit: [one[0]!.id, many[0]!.id],
    outsider: household(randomBytes(32)),
  }
}

/** What one call costs, in work rather than in time. */
async function cost(run: () => Promise<unknown>): Promise<Record<string, number>> {
  // Once first, so nothing being compared pays for a lazily compiled path.
  await run()
  tally.on = true
  tally.digests = tally.hashed = tally.verifies = tally.encoded = 0
  await run()
  tally.on = false
  return { digests: tally.digests, hashed: tally.hashed, verifies: tally.verifies, encoded: tally.encoded }
}

const request = (op: string, id: string): Request => {
  const empty = JSON.stringify({ op, id, pad: '' })
  return new Request('http://escrow.invalid/e', {
    method: 'POST',
    headers: { 'content-length': String(ESCROW_REQUEST_BYTES), 'content-type': 'application/json' },
    body: JSON.stringify({ op, id, pad: 'A'.repeat(ESCROW_REQUEST_BYTES - empty.length) }),
  })
}

// ---------------------------------------------------------------------------

describe('what a read costs', () => {
  it('is the same digests whether the bucket holds nobody, one household or sixty-four', async () => {
    // The blocker itself. readImage used to return the moment an image failed
    // its digest, before the WAYS loop — and an empty bucket is exactly a
    // bucket whose two images both fail. Measured on the store as it was: 32 us
    // against 119 us, on reads that both missed.
    const { store, miss } = await threeBuckets()

    const empty = await cost(() => store.read(miss[0]!))
    const one = await cost(() => store.read(miss[1]!))
    const full = await cost(() => store.read(miss[2]!))

    expect(one, 'a bucket with a household in it costs more to read than an empty one').toEqual(empty)
    expect(full, 'a read costs what the bucket holds').toEqual(empty)
    // And the control: the number is big enough that a skipped loop would show.
    // Two image digests and two per slot, over both images, plus the one that
    // picks the bucket.
    expect(empty['digests']).toBe(1 + 2 + 2 * 2 * WAYS)
  })

  it('is the same digests for a copy that is there as for one that is not', async () => {
    const { store, miss, hit } = await threeBuckets()

    const missed = await cost(() => store.read(miss[1]!))
    const found = await cost(() => store.read(hit[0]!))
    const crowded = await cost(() => store.read(hit[1]!))

    expect(found, 'finding a copy costs more than not finding one').toEqual(missed)
    expect(crowded, 'a household in a crowded bucket costs a different read').toEqual(missed)
  })

  it('encodes the same number of bytes whether or not there is a copy to send', async () => {
    // The layer above the store, and it was leaking the same fact. Turning 512
    // bytes into base64 and packing them into JSON happened only on a hit, so
    // the answer's length was constant and the time to build it was not — a
    // per-id existence oracle, which is worse than a per-bucket one.
    const { store, miss, hit } = await threeBuckets()

    const missed = await cost(() => handle(request('get', miss[1]!), store))
    const found = await cost(() => handle(request('get', hit[0]!), store))

    expect(found['encoded'], 'a hit encodes bytes a miss does not').toBe(missed['encoded'])
    expect(missed['encoded'], 'nothing was encoded at all, so this proves nothing').toBe(BLOB_BYTES)
    expect(found, 'the answers cost different amounts to build').toEqual(missed)
  })

  it('still answers what it always did', async () => {
    // The counters above would be just as equal if the store had stopped
    // working, so this is the control for all of them.
    const { store, miss, hit } = await threeBuckets()

    expect(await store.read(miss[0]!)).toBeNull()
    expect(await store.read(miss[1]!)).toBeNull()
    expect(await store.read(miss[2]!)).toBeNull()
    expect(await store.read(hit[0]!)).toMatchObject({ version: 1 })
    expect((await store.read(hit[0]!))!.blob).toHaveLength(BLOB_BYTES)
    expect((await handle(request('get', hit[0]!), store)).status).toBe(200)
    expect((await handle(request('get', miss[1]!), store)).status).toBe(404)
  })
})

describe('what a write costs', () => {
  /**
   * A put nobody is entitled to make: a real key of the sender's own, a good
   * signature over somebody else's id, and no right to that id at all.
   *
   * Signed properly rather than with rubbish, because the whole question is
   * whether the signature gets verified — a signature that could be thrown out
   * on its shape would not tell the two cases apart.
   */
  const forged = (who: Household, id: string) => {
    const blob = new Uint8Array(BLOB_BYTES).fill(9)
    return { id, version: 2, blob, writeKey: who.writeKey, signature: who.saveAs(id, 2, blob) }
  }

  it('is the same digests whether the bucket holds nobody, one household or sixty-four', async () => {
    // A put that cannot be signed still parses the bucket before it refuses, so
    // the read path's leak was reachable by anyone who could send one — no
    // credential and no id worth knowing. Measured as it was: 128 us against
    // 224 us and 238 us.
    const { store, miss, outsider } = await threeBuckets()

    const empty = await cost(() => store.write(forged(outsider, miss[0]!)))
    const one = await cost(() => store.write(forged(outsider, miss[1]!)))
    const full = await cost(() => store.write(forged(outsider, miss[2]!)))

    expect(one, 'a refused put costs what the bucket holds').toEqual(empty)
    expect(full, 'a refused put costs what the bucket holds').toEqual(empty)
  })

  it('verifies the signature even when the pinned key has already said no', async () => {
    // The write path's own leak, which nobody had measured. The pinned-key
    // check ran first and returned on its own, so a wrong key against an id
    // somebody holds skipped an Ed25519 verification that the same wrong key
    // against an unheld id had to pay for: 151 us against 224 us, an existence
    // oracle for anyone who has learned an id.
    const { store, miss, hit, outsider } = await threeBuckets()

    const unheld = await cost(() => store.write(forged(outsider, miss[1]!)))
    const held = await cost(() => store.write(forged(outsider, hit[0]!)))

    expect(held['verifies'], 'a wrong key against a held id skips the signature check').toBe(
      unheld['verifies']
    )
    expect(unheld['verifies'], 'nothing was verified at all, so this proves nothing').toBe(1)
    expect(held, 'refusing a held id costs less than refusing an unheld one').toEqual(unheld)
  })

  it('will not say a bucket is full to anyone who has not written to it', async () => {
    // `full` is the one answer that says something about the OTHER households
    // in a bucket, so it must not be free to ask for. It sits behind the
    // version check, so an outsider can only reach it at version 1 — and a
    // version 1 that clears the ceiling lands, claiming the id. There is no way
    // to ask the question without answering for it.
    dir = mkdtempSync(join(tmpdir(), 'ftw-cost-full-'))
    const store = openSlotStore(join(dir, 'escrow.slots'), { households: HOUSEHOLDS })
    open.push(store)

    const blob = new Uint8Array(BLOB_BYTES).fill(7)
    const crowd = landingOn(3, WAYS, 'crowd').map(household)
    for (const who of crowd) {
      expect(
        await store.write({ id: who.id, version: 1, blob, writeKey: who.writeKey, signature: who.save(1, blob) })
      ).toBe('written')
    }

    const nosy = household(randomBytes(32))
    const target = landingOn(3, WAYS + 1, 'crowd')[WAYS]!.toString('base64url')
    // The probe: a good signature over an id nobody holds, at a version that
    // cannot land. It must not be told the bucket is full.
    expect(
      await store.write({ id: target, version: 2, blob, writeKey: nosy.writeKey, signature: nosy.saveAs(target, 2, blob) }),
      'a full bucket answers a probe that was never going to write'
    ).toBe('version')
    // Only a write that would really have landed gets the ceiling.
    expect(
      await store.write({ id: target, version: 1, blob, writeKey: nosy.writeKey, signature: nosy.saveAs(target, 1, blob) })
    ).toBe('full')
  })

  it('still refuses what it always refused, and accepts what it always accepted', async () => {
    const { store, miss, hit, outsider } = await threeBuckets()

    // Held by somebody else: the pin refuses it however well it is signed.
    expect(await store.write(forged(outsider, hit[0]!)), 'a pinned key stopped holding').toBe('unauthorised')
    // Held by nobody: the pin has nothing to say, so the successor rule is what
    // turns it away. That is the outcome the reordered checks had to keep.
    expect(await store.write(forged(outsider, miss[1]!)), 'a version out of sequence was taken').toBe(
      'version'
    )
    // And the household itself still gets through, at the successor and only
    // at the successor.
    const mine = household(landingOn(1, 4, 'mine')[3]!)
    const blob = new Uint8Array(BLOB_BYTES).fill(3)
    expect(
      await store.write({ id: mine.id, version: 2, blob, writeKey: mine.writeKey, signature: mine.save(2, blob) })
    ).toBe('version')
    expect(
      await store.write({ id: mine.id, version: 1, blob, writeKey: mine.writeKey, signature: mine.save(1, blob) })
    ).toBe('written')
    expect(await store.read(mine.id)).toMatchObject({ version: 1 })
  })
})

describe('and the clock agrees', () => {
  it('takes the same time to read an empty bucket as a full one', async () => {
    // Last, and coarse on purpose. The counts above are the real assertion; a
    // wall clock on a machine somebody else is also using cannot be tight
    // without going red for reasons that have nothing to do with this code. So
    // this is here to catch a count that stayed equal while the time did not,
    // and the bound is loose enough to survive a busy runner: the gap it is
    // looking for was nearly fourfold.
    //
    // Interleaved and shuffled, so a machine that speeds up or slows down
    // during the run moves all three cases together rather than one of them.
    const { store, miss, hit } = await threeBuckets()
    const probes = [miss[0]!, miss[1]!, miss[2]!, hit[0]!, hit[1]!]
    const samples: number[][] = probes.map(() => [])

    for (let i = 0; i < 200; i++) for (const id of probes) await store.read(id)

    const order = probes.map((_, i) => i)
    for (let round = 0; round < 400; round++) {
      for (let i = order.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1))
        ;[order[i], order[j]] = [order[j]!, order[i]!]
      }
      for (const which of order) {
        const at = process.hrtime.bigint()
        await store.read(probes[which]!)
        samples[which]!.push(Number(process.hrtime.bigint() - at))
      }
    }

    const medians = samples.map((run) => run.sort((a, b) => a - b)[Math.floor(run.length / 2)]!)
    const ratio = Math.max(...medians) / Math.min(...medians)
    expect(
      ratio,
      `medians in microseconds: ${medians.map((n) => (n / 1000).toFixed(1)).join(', ')} — a read tells the clock what its bucket holds`
    ).toBeLessThan(1.5)
  })
})
