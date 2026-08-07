// @vitest-environment node

/* The file, and what can be read out of it by somebody holding a copy.
 *
 * escrow.test.ts is about what the service will and will not do. This is about
 * the bytes it leaves behind, which is where the last four failures were: a
 * managed store's own history, a proxy's access log, a b-tree page's cell
 * layout, and the rollback journal the fix for that one wrote on every save.
 *
 * Every assertion here goes at a file read off the disk. Where a claim is about
 * something not being there, a control comes first — a detector that finds
 * nothing proves nothing.
 */

import { describe, it, expect, afterEach } from 'vitest'
import { createHash, generateKeyPairSync, randomBytes, sign as signWith } from 'node:crypto'
import { gzipSync } from 'node:zlib'
import { mkdtempSync, openSync, closeSync, readFileSync, rmSync, statSync, writeSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import {
  BLOB_BYTES,
  BUCKET_BYTES,
  DOMAINS,
  bucketOf,
  bucketsFor,
  bytesFor,
  IMAGE_BYTES,
  liveImage,
  openSlotStore,
  RECORD_BYTES,
  WAYS,
  writeMessage,
  type EscrowStore,
} from './store.ts'
import { grow } from './grow.ts'

let dir = ''
const open: EscrowStore[] = []

afterEach(() => {
  for (const store of open.splice(0)) {
    try {
      store.close()
    } catch {
      // Already closed by the test.
    }
  }
  if (dir) rmSync(dir, { recursive: true, force: true })
  dir = ''
})

function scratch(): string {
  dir = mkdtempSync(join(tmpdir(), 'ftw-slots-'))
  return dir
}

function store(path: string, households = 64, opts = {}): EscrowStore {
  const made = openSlotStore(path, { households, ...opts })
  open.push(made)
  return made
}

/**
 * One household: an id, and the key that is allowed to write it.
 *
 * node:crypto rather than the curve library the app uses, deliberately — the
 * signature has to be verified by a second implementation or the test is only
 * checking that one library agrees with itself.
 */
function household(seed?: Buffer): {
  id: string
  writeKey: Buffer
  save: (version: number, blob: Uint8Array) => Buffer
} {
  const id = (seed ?? randomBytes(32)).toString('base64url')
  const { publicKey, privateKey } = generateKeyPairSync('ed25519')
  const writeKey = Buffer.from((publicKey.export({ format: 'jwk' }) as { x: string }).x, 'base64url')
  return {
    id,
    writeKey,
    save: (version, blob) => signWith(null, writeMessage(id, version, blob), privateKey),
  }
}

const blobOf = (fill: number) => new Uint8Array(BLOB_BYTES).fill(fill)

async function put(
  target: EscrowStore,
  who: ReturnType<typeof household>,
  version: number,
  blob: Uint8Array
): Promise<string> {
  return target.write({
    id: who.id,
    version,
    blob,
    writeKey: who.writeKey,
    signature: who.save(version, blob),
  })
}

/**
 * Random bytes that are a function of where they land and of nothing else.
 *
 * The file is filled with noise, so two files built from the same households
 * are only the same bytes if the noise is the same too. Injecting a stream
 * keyed on the file offset makes that so, and it is legitimate for exactly the
 * reason the assertion is about: a function of the offset cannot carry an
 * arrival order, and neither can the system random source it stands in for.
 * The test after it checks the same thing with the production source.
 */
function stream(seed: string): (out: Uint8Array, at: number) => void {
  return (out, at) => {
    for (let i = 0; i < out.length; i += 32) {
      const block = createHash('sha256').update(seed).update(String(at + i)).digest()
      out.set(block.subarray(0, Math.min(32, out.length - i)), i)
    }
  }
}

// ---------------------------------------------------------------------------

describe('the shape of the file', () => {
  it('is a whole number of buckets and carries no header', () => {
    const path = join(scratch(), 'escrow.slots')
    store(path, 64)

    const size = statSync(path).size
    expect(size).toBe(bytesFor(64))
    expect(size % BUCKET_BYTES).toBe(0)
    expect(bucketsFor(64)).toBe(2)
  })

  it('has every one of its blocks on the disk before any household exists', () => {
    // Not housekeeping. A file with holes in it has its blocks handed out by
    // the filesystem as they are first written, so the physical order of the
    // blocks would be the order the households arrived in — the same defect one
    // layer below the one that started all this. Declaring a length with
    // ftruncate would do exactly that; writing every byte does not.
    const path = join(scratch(), 'escrow.slots')
    store(path, 256)

    const stat = statSync(path)
    expect(stat.blocks * 512, 'the file is sparse, so its blocks are handed out as households arrive')
      .toBeGreaterThanOrEqual(stat.size)
  })

  it('holds a household at a place that is a function of its id', async () => {
    const path = join(scratch(), 'escrow.slots')
    const s = store(path, 64)
    const who = household()

    expect(await put(s, who, 1, blobOf(0x11))).toBe('written')

    const at = bucketOf(Buffer.from(who.id, 'base64url'), bucketsFor(64))
    const file = readFileSync(path)
    const bucket = file.subarray(at * BUCKET_BYTES, (at + 1) * BUCKET_BYTES)
    expect(liveImage(bucket, at)?.records.map((r) => r.id.toString('base64url'))).toEqual([who.id])
  })
})

/* ---------------------------------------------------------------------------
 * When it was written
 *
 * A schema with no timestamp column proves nothing on a store that keeps its
 * own history, and a service that keeps none can still have one kept for it by
 * the platform underneath, the proxy in front or the file on the disk. This
 * reads the file off the disk and looks for a time in every shape one could be
 * written in.
 * ------------------------------------------------------------------------- */

const NEAR_MS = 120_000

/**
 * Every window in these bytes that could be an instant near `nowMs`.
 *
 * Every hit, not every kind of hit, and that is the difference between this
 * version and the one that ran against a b-tree. The file is now random bytes
 * from end to end, so a scan of it finds a four-byte window that looks like a
 * unix second by chance — measured at three runs in three hundred over 158 kB
 * with this window, and never twice in the same run. A time this store actually
 * wrote would be in every record, so the test below fails on two rather than on
 * one and says what one costs.
 */
function timesIn(bytes: Uint8Array, nowMs: number): string[] {
  const found: string[] = []
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  const add = (what: string) => void found.push(what)

  const check = (value: number, how: string) => {
    if (Math.abs(value * 1000 - nowMs) <= NEAR_MS) add(`${how} seconds`)
    if (Math.abs(value - nowMs) <= NEAR_MS) add(`${how} milliseconds`)
  }

  for (const width of [4, 5, 6, 8]) {
    for (let at = 0; at + width <= bytes.length; at++) {
      let big = 0
      let little = 0
      for (let i = 0; i < width; i++) {
        big = big * 256 + bytes[at + i]!
        little = little * 256 + bytes[at + width - 1 - i]!
      }
      check(big, 'big-endian')
      check(little, 'little-endian')
    }
  }

  const julian = nowMs / 86_400_000 + 2440587.5
  for (let at = 0; at + 8 <= bytes.length; at++) {
    for (const little of [true, false]) {
      if (Math.abs(view.getFloat64(at, little) - julian) * 86_400_000 <= NEAR_MS) {
        add('a julian day')
      }
    }
  }

  const text = new TextDecoder('latin1').decode(bytes)
  const day = new Date(nowMs).toISOString().slice(0, 10)
  for (const [needle, what] of [
    [day, 'an ISO date'],
    [day.replaceAll('-', '/'), 'a slashed date'],
    // A digit short of the whole number, so the needle covers ten seconds
    // either way rather than the single instant the clock happened to read.
    [String(Math.floor(nowMs / 1000)).slice(0, -1), 'a decimal time'],
    [String(nowMs).slice(0, -1), 'a decimal time'],
  ] as const) {
    for (let at = text.indexOf(needle); at >= 0; at = text.indexOf(needle, at + 1)) add(what)
  }

  return found.sort()
}

describe('when it was written', () => {
  it('finds a time when one is there, which is why the next test means anything', () => {
    // Three rows, not one, because the test below fails on two hits rather
    // than on one — so the control has to produce two of each as well.
    const path = join(scratch(), 'control.db')
    const db = new DatabaseSync(path)
    db.exec(`CREATE TABLE t (created_at INTEGER, stamped TEXT, day REAL)`)
    for (let i = 0; i < 3; i++) {
      db.exec(`INSERT INTO t VALUES (unixepoch(), CURRENT_TIMESTAMP, julianday('now'))`)
    }
    db.close()

    const found = timesIn(readFileSync(path), Date.now())
    const count = (what: string) => found.filter((hit) => hit === what).length

    expect(count('big-endian seconds'), 'the detector missed unixepoch()').toBeGreaterThan(1)
    expect(count('an ISO date'), 'the detector missed CURRENT_TIMESTAMP').toBeGreaterThan(1)
    expect(count('a julian day'), 'the detector missed julianday()').toBeGreaterThan(1)
  })

  it('leaves no time in the file, however many times a household writes', async () => {
    // Nothing in a slot file is a clock, and this is what says so. A household
    // writes its copy, writes it again and clears it; what is left says nothing
    // about when any of that happened.
    //
    // Twenty households rather than one, so that a time this store wrote would
    // be in the file twenty times over. That matters, because the file is
    // random bytes from end to end and a scan of 158 kB of noise turns up a
    // four-byte window that looks like a unix second about three runs in three
    // hundred — measured, over three hundred files of pure noise, which also
    // never turned up two in the same run. So one hit is chance and two is a
    // clock.
    //
    // What that leaves, said rather than hidden: a single time written once for
    // the whole file would pass this. There is nowhere for one to be — the file
    // has no header at all — and the modification time the filesystem keeps is
    // named as residue in README.md.
    const path = join(scratch(), 'escrow.slots')
    const s = store(path, 64)

    for (let i = 0; i < 20; i++) {
      const who = household(createHash('sha256').update(`clock-${i}`).digest())
      expect(await put(s, who, 1, blobOf(0x01))).toBe('written')
      expect(await put(s, who, 2, blobOf(0x02))).toBe('written')
      expect(await put(s, who, 3, new Uint8Array(0))).toBe('written')
    }
    s.close()

    const found = timesIn(readFileSync(path), Date.now())
    expect(found.length, `the file carries a clock: ${found.join(', ')}`).toBeLessThan(2)
  })

  it('keeps nothing beside the file — no journal, no temporary copy, no lock', async () => {
    // The place a recent write used to sit. A b-tree needs a journal to commit
    // and a second copy of itself to compact; a slot file needs neither, so
    // there is nothing beside it to look in.
    const home = scratch()
    const path = join(home, 'escrow.slots')
    const s = store(path, 64)
    const who = household()
    await put(s, who, 1, blobOf(0x01))
    await put(s, who, 2, blobOf(0x02))

    const { readdirSync } = await import('node:fs')
    expect(readdirSync(home)).toEqual(['escrow.slots'])
  })
})

/* ---------------------------------------------------------------------------
 * In what order it was written
 * ------------------------------------------------------------------------- */

/** A SQLite variable-length integer: big-endian, seven bits a byte. */
function varint(bytes: Uint8Array, at: number): [value: number, width: number] {
  let value = 0
  for (let i = 0; i < 8; i++) {
    const byte = bytes[at + i]!
    value = value * 128 + (byte & 0x7f)
    if ((byte & 0x80) === 0) return [value, i + 1]
  }
  return [value * 256 + bytes[at + 8]!, 9]
}

/** The old attack: a b-tree page's cells, sorted by descending byte offset. */
function idsByCell(file: Uint8Array): string[] {
  const view = new DataView(file.buffer, file.byteOffset, file.byteLength)
  const declared = view.getUint16(16)
  const pageSize = declared === 1 ? 65536 : declared
  const found: string[] = []

  for (let page = 1; page <= file.length / pageSize; page++) {
    const base = (page - 1) * pageSize
    const header = base + (page === 1 ? 100 : 0)
    const type = file[header]!
    if (type !== 0x02 && type !== 0x0a) continue

    const cells = view.getUint16(header + 3)
    const pointers = header + (type === 0x02 ? 12 : 8)
    const here: { at: number; id: string }[] = []

    for (let i = 0; i < cells; i++) {
      const at = base + view.getUint16(pointers + i * 2)
      let cursor = at + (type === 0x02 ? 4 : 0)
      cursor += varint(file, cursor)[1]
      const [headerBytes] = varint(file, cursor)
      const [serial] = varint(file, cursor + varint(file, cursor)[1])
      if (serial !== 2 * 43 + 13) continue
      const start = cursor + headerBytes
      here.push({ at, id: new TextDecoder().decode(file.subarray(start, start + 43)) })
    }
    for (const cell of here.sort((a, b) => b.at - a.at)) found.push(cell.id)
  }
  return found
}

/** Every id in a slot file, in the order its bytes sit in the file. */
function idsByPosition(file: Uint8Array): string[] {
  const out: { at: number; id: string }[] = []
  for (let index = 0; index * BUCKET_BYTES < file.length; index++) {
    const bucket = Buffer.from(file.subarray(index * BUCKET_BYTES, (index + 1) * BUCKET_BYTES))
    const live = liveImage(bucket, index)
    if (!live) continue
    live.records.forEach((record, way) => {
      out.push({
        at: index * BUCKET_BYTES + live.image * IMAGE_BYTES + way * RECORD_BYTES,
        id: record.id.toString('base64url'),
      })
    })
  }
  return out.sort((a, b) => a.at - b.at).map((row) => row.id)
}

describe('in what order it was written', () => {
  it('recovers the arrival order from a b-tree, which is why the next tests mean anything', () => {
    // The control, and the blocker restated as code. This is the store that was
    // here before, with the same schema and the same pragmas, and the attack
    // that worked on it: a page keeps its cell pointers in key order and
    // allocates the cell contents from the end of the page downward as the rows
    // arrive, so sorting one page's cells by descending byte offset hands the
    // households back in the order they joined. Six of them, in the reverse of
    // the order their ids sort in, so nothing about the key could explain it.
    const path = join(scratch(), 'ordinary.db')
    const db = new DatabaseSync(path)
    db.exec('PRAGMA journal_mode = DELETE')
    db.exec(`CREATE TABLE escrow (id TEXT PRIMARY KEY NOT NULL, ver INTEGER NOT NULL, blob BLOB NOT NULL)
             STRICT, WITHOUT ROWID`)
    const arrival = ['F', 'E', 'D', 'C', 'B', 'A'].map((letter) => letter.repeat(43))
    for (const id of arrival) {
      db.prepare(`INSERT INTO escrow VALUES (?, ?, ?)`).run(id, 1, new Uint8Array(BLOB_BYTES).fill(1))
    }
    db.close()

    expect(idsByCell(readFileSync(path)), 'the attack no longer works, so it proves nothing').toEqual(
      arrival
    )
  })

  it('puts the records where the ids say, never where the queue says', async () => {
    // The same attack on the slot file. The ids come back in key order, which
    // is a function of who is there — and the households arrived in the exact
    // reverse of it, so if the file recorded arrival this would fail.
    const path = join(scratch(), 'escrow.slots')
    const s = store(path, 64, { entropy: stream('a') })
    // One bucket, so this is about where records sit inside one and not about
    // which bucket they landed in.
    const at = 0
    const people: ReturnType<typeof household>[] = []
    for (let i = 0; people.length < 6; i++) {
      const seed = createHash('sha256').update(`who-${i}`).digest()
      if (bucketOf(seed, bucketsFor(64)) !== at) continue
      people.push(household(seed))
    }
    const arrival = [...people].sort((a, b) => (a.id < b.id ? 1 : -1))
    for (const who of arrival) expect(await put(s, who, 1, blobOf(0x11))).toBe('written')
    s.close()

    const positions = idsByPosition(readFileSync(path))
    const byKey = (ids: string[]) =>
      [...ids].sort((a, b) => Buffer.compare(Buffer.from(a, 'base64url'), Buffer.from(b, 'base64url')))
    expect(positions).toHaveLength(6)
    expect(positions, 'the file put them in the order they arrived').not.toEqual(arrival.map((w) => w.id))
    expect(positions, 'the file is not in key order either, so something else decided').toEqual(
      byKey(positions)
    )
  })

  it('leaves the same bytes whichever order the households arrived in', async () => {
    // The assertion the whole store choice exists for. Two files, the same
    // households, opposite arrival orders. If a single byte differs, that byte
    // is a household's place in the queue and somebody holding a copy of the
    // file can read it.
    //
    // The random filling is injected as a function of the file offset, because
    // otherwise the two files differ everywhere for a reason that carries
    // nothing. The test after this one checks the same property with the
    // production random source, where the assertion has to be about where the
    // records sit rather than about every byte.
    const people = Array.from({ length: 40 }, (_, i) =>
      household(createHash('sha256').update(`house-${i}`).digest())
    )
    const digests: string[] = []
    const home = scratch()

    for (const [which, arrival] of [
      ['forwards', people],
      ['backwards', [...people].reverse()],
    ] as const) {
      const path = join(home, `${which}.slots`)
      const s = store(path, 64, { entropy: stream('shared') })
      for (const who of arrival) expect(await put(s, who, 1, blobOf(0x11))).toBe('written')
      s.close()
      digests.push(createHash('sha256').update(readFileSync(path)).digest('hex'))
    }

    expect(digests[1], 'the file records the arrival order somewhere').toBe(digests[0])
  })

  it('puts every record at the same offset whichever order they arrived in, on the real random source', async () => {
    // The same property without the injected filling: the noise differs, and
    // nothing else does. This is what the deployment actually runs.
    const people = Array.from({ length: 40 }, (_, i) =>
      household(createHash('sha256').update(`house-${i}`).digest())
    )
    const home = scratch()
    const layouts: string[][] = []

    for (const [which, arrival] of [
      ['forwards', people],
      ['backwards', [...people].reverse()],
    ] as const) {
      const path = join(home, `${which}.slots`)
      const s = store(path, 64)
      for (const who of arrival) expect(await put(s, who, 1, blobOf(0x11))).toBe('written')
      s.close()
      layouts.push(idsByPosition(readFileSync(path)))
    }

    expect(layouts[0]).toHaveLength(40)
    expect(layouts[1], 'a record sits somewhere else depending on when it arrived').toEqual(layouts[0])
  })
})

/* ---------------------------------------------------------------------------
 * How many households are in there
 * ------------------------------------------------------------------------- */

function histogram(bytes: Uint8Array): number[] {
  const counts = new Array<number>(256).fill(0)
  for (const byte of bytes) counts[byte]!++
  return counts
}

/** How far apart two byte histograms are, in units of what chance would give. */
function apart(a: number[], b: number[]): number {
  let worst = 0
  for (let value = 0; value < 256; value++) {
    const expected = (a[value]! + b[value]!) / 2
    if (expected < 1) continue
    worst = Math.max(worst, Math.abs(a[value]! - b[value]!) / Math.sqrt(2 * expected))
  }
  return worst
}

function longestRun(bytes: Uint8Array): number {
  let best = 0
  let run = 0
  for (let i = 1; i < bytes.length; i++) {
    run = bytes[i] === bytes[i - 1] ? run + 1 : 0
    best = Math.max(best, run)
  }
  return best + 1
}

describe('how many households are in there', () => {
  /**
   * A blob the way a household's really is: sealed, so indistinguishable from
   * random.
   *
   * That matters here rather than being tidiness. What makes a used slot look
   * like an empty one is that every field in it is noise — the id is HKDF
   * output, the key is a curve point, the head is masked and the blob is
   * AES-GCM ciphertext. The service cannot check the last of those and does not
   * try: a household that put 512 bytes of one value in there would be
   * countable, and it is the seal in the app that stops them. README.md says
   * this in the same words. A test that wrote a constant would be measuring a
   * property the deployment does not have.
   */
  const sealed = () => new Uint8Array(randomBytes(BLOB_BYTES))

  async function fill(path: string, count: number): Promise<void> {
    const s = store(path, 256)
    for (let i = 0; i < count; i++) {
      const who = household(createHash('sha256').update(`${path}-${i}`).digest())
      expect(await put(s, who, 1, sealed())).toBe('written')
    }
    s.close()
  }

  it('looks the same whether it holds two households or two hundred', async () => {
    // Every slot is written with random bytes when the file is made, so an
    // empty one is not distinguishable from a used one by any of the tools that
    // do not know this layout — which is what an operator's casual look is made
    // of. A parser that does know it can count, and README.md says so.
    const home = scratch()
    const nearly = join(home, 'nearly-empty.slots')
    const busy = join(home, 'busy.slots')
    await fill(nearly, 2)
    await fill(busy, 200)

    const empty = readFileSync(nearly)
    const full = readFileSync(busy)

    expect(full.length, 'the file grew with the households in it').toBe(empty.length)
    expect(apart(histogram(empty), histogram(full)), 'a byte histogram counts the households')
      .toBeLessThan(6)
    // A compressor is the same question asked another way: structure squeezes
    // and noise does not.
    const squeeze = (bytes: Uint8Array) => gzipSync(bytes, { level: 9 }).length / bytes.length
    expect(Math.abs(squeeze(empty) - squeeze(full)), 'a compressor counts the households')
      .toBeLessThan(0.005)
    expect(Math.abs(longestRun(empty) - longestRun(full)), 'a run of repeated bytes says where the data is')
      .toBeLessThan(8)
  })

  it('catches all three when the empty slots are left as zeroes, which is why the last test means anything', async () => {
    // The control. The same file with its noise taken out — which is what a
    // slot file looks like if somebody decides the random filling is
    // decoration — and every one of the three measurements above screams.
    const home = scratch()
    const nearly = join(home, 'nearly-empty.slots')
    const busy = join(home, 'busy.slots')
    await fill(nearly, 2)
    await fill(busy, 200)

    const flatten = (path: string): Uint8Array => {
      const file = readFileSync(path)
      const out = new Uint8Array(file.length)
      for (let index = 0; index * BUCKET_BYTES < file.length; index++) {
        const bucket = Buffer.from(file.subarray(index * BUCKET_BYTES, (index + 1) * BUCKET_BYTES))
        const live = liveImage(bucket, index)
        if (!live) continue
        const from = index * BUCKET_BYTES + live.image * IMAGE_BYTES
        const used = live.records.length * RECORD_BYTES
        out.set(file.subarray(from, from + used), from)
      }
      return out
    }
    const empty = flatten(nearly)
    const full = flatten(busy)

    expect(apart(histogram(empty), histogram(full)), 'the histogram detector is blind').toBeGreaterThan(50)
    const squeeze = (bytes: Uint8Array) => gzipSync(bytes, { level: 9 }).length / bytes.length
    expect(Math.abs(squeeze(empty) - squeeze(full)), 'the compressor detector is blind').toBeGreaterThan(0.005)
  })

  it('keeps the version and the length out of the file in the clear', async () => {
    // The two fields that are not random-looking on their own. Masked with
    // bytes from the record's own id, which is obfuscation and not encryption —
    // but it is what stops a histogram seeing a spike of zeroes exactly
    // proportional to the number of households.
    const path = join(scratch(), 'escrow.slots')
    const s = store(path, 64)
    for (let i = 0; i < 20; i++) {
      const who = household(createHash('sha256').update(`mask-${i}`).digest())
      expect(await put(s, who, 1, blobOf(0x11))).toBe('written')
    }
    s.close()

    // version 1, length 512, two zero bytes — what the head would be if it were
    // written as it is meant.
    const plain = Buffer.from([0, 0, 0, 1, 0x02, 0x00, 0, 0])
    expect(readFileSync(path).includes(plain), 'a version and a length are sitting in the file').toBe(false)
  })
})

/* ---------------------------------------------------------------------------
 * A machine that dies in the middle
 * ------------------------------------------------------------------------- */

describe('a write that does not finish', () => {
  it('leaves the copy that was there, and refuses the half-written one', async () => {
    // There is no transaction any more. A write builds a whole image and puts
    // it where the current one is not, so a machine that dies in the middle
    // destroys nothing — and the half that landed fails its digest and is
    // refused rather than read as data.
    const path = join(scratch(), 'escrow.slots')
    const who = household()

    const good = store(path, 64)
    expect(await put(good, who, 1, blobOf(0x01))).toBe('written')
    good.close()

    // The same file, opened by a store whose writes stop halfway through.
    const torn = openSlotStore(path, {
      writeAt(fd, bytes, at) {
        writeSync(fd, bytes, 0, Math.floor(bytes.length / 2), at)
        throw new Error('the machine went away')
      },
    })
    await expect(put(torn, who, 2, blobOf(0x02))).rejects.toThrow('the machine went away')
    torn.close()

    const after = store(path, 64)
    expect(await after.read(who.id), 'a half-written image was read as data').toMatchObject({ version: 1 })
    expect(Array.from((await after.read(who.id))!.blob.slice(0, 4))).toEqual([1, 1, 1, 1])
    // And the household is not stuck: the next attempt at the same version
    // lands, because nothing was committed.
    expect(await put(after, who, 2, blobOf(0x02))).toBe('written')
    expect(await after.read(who.id)).toMatchObject({ version: 2 })
  })

  it('keeps a save that landed even when the wipe afterwards cannot run, and says so', async () => {
    // The one seam left. A write is two steps — the new image, then random
    // bytes over the one it replaced — and the second can fail on its own.
    //
    // Answering with a failure would be a lie that costs the household their
    // copy: the app would retry the same version, and the successor rule
    // refuses that one for the rest of time. So the save is reported as what it
    // was. What must not happen is that the file quietly stops being wiped and
    // nobody ever knows, and with no logs anywhere the health check is the only
    // place that can say so.
    const path = join(scratch(), 'escrow.slots')
    const who = household()
    let writes = 0
    const s = openSlotStore(path, {
      households: 64,
      writeAt(fd, bytes, at) {
        // The first write of a pair lands; the wipe after the second does not.
        if (++writes === 4) throw new Error('disk full')
        writeSync(fd, bytes, 0, bytes.length, at)
      },
    })
    open.push(s)

    expect(s.tidy()).toBe(true)
    expect(await put(s, who, 1, blobOf(0x01))).toBe('written')
    expect(s.tidy(), 'a wipe that worked was reported as a fault').toBe(true)

    expect(await put(s, who, 2, blobOf(0x02)), 'a save that landed was reported as a failure').toBe(
      'written'
    )
    expect(s.tidy(), 'a wipe failed and nothing anywhere would have said so').toBe(false)
    // And the copy really is there, at the version it was written under, so the
    // household is not left retrying a version that can never be accepted.
    expect(await s.read(who.id)).toMatchObject({ version: 2 })
  })

  it('does not take a slot that merely looks like a record for one', async () => {
    // What the digest on each record is for, which is not the same job as the
    // digest on the image. An empty slot is random bytes and carries no marker
    // saying so, because a marker is what a histogram counts. So a slot is a
    // record if and only if its own digest checks out — and this forges one
    // that passes every other check there is: a head that unmasks to version 1
    // and a length of 512, sitting inside an image whose digest is recomputed
    // so the image itself is beyond reproach.
    const path = join(scratch(), 'escrow.slots')
    const s = store(path, 64)
    const who = household()
    expect(await put(s, who, 1, blobOf(0x01))).toBe('written')
    s.close()

    const index = bucketOf(Buffer.from(who.id, 'base64url'), bucketsFor(64))
    const file = readFileSync(path)
    const bucket = Buffer.from(file.subarray(index * BUCKET_BYTES, (index + 1) * BUCKET_BYTES))
    const image = liveImage(bucket, index)!.image
    const from = image * IMAGE_BYTES + RECORD_BYTES

    // A plausible head over the random id that is already sitting there.
    const id = bucket.subarray(from, from + 32)
    const head = Buffer.alloc(8)
    head.writeUInt32BE(1, 0)
    head.writeUInt16BE(BLOB_BYTES, 4)
    const mask = createHash('sha256').update(DOMAINS.head).update(id).digest()
    for (let i = 0; i < 8; i++) bucket[from + 32 + i] = head[i]! ^ mask[i]!

    // And the image digest again, so nothing above the record objects.
    const place = Buffer.alloc(5)
    place.writeUInt32BE(index, 0)
    place.writeUInt8(image, 4)
    createHash('sha256')
      .update(DOMAINS.image)
      .update(place)
      .update(bucket.subarray(image * IMAGE_BYTES, image * IMAGE_BYTES + WAYS * RECORD_BYTES))
      .digest()
      .copy(bucket, image * IMAGE_BYTES + WAYS * RECORD_BYTES)

    const fd = openSync(path, 'r+')
    writeSync(fd, bucket, 0, BUCKET_BYTES, index * BUCKET_BYTES)
    closeSync(fd)

    expect(
      liveImage(Buffer.from(readFileSync(path).subarray(index * BUCKET_BYTES, (index + 1) * BUCKET_BYTES)), index)
        ?.records,
      'a slot of random bytes was read as a household'
    ).toHaveLength(1)
  })

  it('refuses a record whose bytes have been changed under it', async () => {
    // Not a crash — a bad disk, or somebody editing the file. A record is a
    // record only if its digest checks out, so a single flipped byte takes the
    // whole image out rather than handing back something that is nearly right.
    const path = join(scratch(), 'escrow.slots')
    const s = store(path, 64)
    const who = household()
    expect(await put(s, who, 1, blobOf(0x01))).toBe('written')
    s.close()

    const at = bucketOf(Buffer.from(who.id, 'base64url'), bucketsFor(64)) * BUCKET_BYTES
    const file = readFileSync(path)
    const live = liveImage(Buffer.from(file.subarray(at, at + BUCKET_BYTES)), at / BUCKET_BYTES)!
    const fd = openSync(path, 'r+')
    // One byte, in the middle of the blob of the live image's first record.
    const target = at + live.image * IMAGE_BYTES + 200
    writeSync(fd, Buffer.from([file[target]! ^ 0xff]), 0, 1, target)
    closeSync(fd)

    const after = store(path, 64)
    expect(await after.read(who.id), 'a changed record was handed back anyway').toBeNull()
  })

  it('does not keep the copy a household has taken away', async () => {
    // What double buffering would cost if the replaced image were left where it
    // is: it would be a journal by another name, holding the leaver's
    // ciphertext for as long as nobody else wrote to that bucket. That is
    // exactly what the last fix did and why it was thrown away.
    const LEAVER = 0xc7
    const path = join(scratch(), 'escrow.slots')
    const s = store(path, 64)
    const leaver = household()
    for (let i = 0; i < 20; i++) {
      const who = household(createHash('sha256').update(`stays-${i}`).digest())
      expect(await put(s, who, 1, blobOf(0x39))).toBe('written')
    }
    expect(await put(s, leaver, 1, blobOf(LEAVER))).toBe('written')

    const needle = Buffer.alloc(64, LEAVER)
    expect(readFileSync(path).includes(needle), 'the detector missed a copy that is really there').toBe(true)

    expect(await put(s, leaver, 2, new Uint8Array(0))).toBe('written')
    s.close()

    expect(readFileSync(path).includes(needle), 'a cleared copy is still legible in the file').toBe(false)
  })
})

/* ---------------------------------------------------------------------------
 * Two households in one bucket
 * ------------------------------------------------------------------------- */

describe('two ids that land on the same bucket', () => {
  function neighbours(count: number, buckets: number, at = 0): ReturnType<typeof household>[] {
    const out: ReturnType<typeof household>[] = []
    for (let i = 0; out.length < count; i++) {
      const seed = createHash('sha256').update(`neighbour-${i}`).digest()
      if (bucketOf(seed, buckets) === at) out.push(household(seed))
    }
    return out
  }

  it('keep their own versions, their own keys and their own copies', async () => {
    const path = join(scratch(), 'escrow.slots')
    const s = store(path, 64)
    const [a, b] = neighbours(2, bucketsFor(64))

    expect(await put(s, a!, 1, blobOf(0xaa))).toBe('written')
    expect(await put(s, b!, 1, blobOf(0xbb))).toBe('written')
    expect(await put(s, a!, 2, blobOf(0xa2))).toBe('written')

    expect(await s.read(a!.id)).toMatchObject({ version: 2 })
    expect(await s.read(b!.id)).toMatchObject({ version: 1 })
    expect(Array.from((await s.read(b!.id))!.blob.slice(0, 2))).toEqual([0xbb, 0xbb])
    // And neither can write the other's, which is the pin doing its job across
    // a collision rather than only across a fresh id.
    expect(
      await s.write({ id: b!.id, version: 2, blob: blobOf(0), writeKey: a!.writeKey, signature: a!.save(2, blobOf(0)) })
    ).toBe('unauthorised')
  })

  it('refuses a household the bucket has no room for, and serves the ones in it', async () => {
    // The ceiling. It is a wall rather than a slope, so it answers with
    // something the app can tell apart and grow.ts is what moves it.
    const path = join(scratch(), 'escrow.slots')
    const s = store(path, 64)
    const crowd = neighbours(WAYS + 1, bucketsFor(64))

    for (const who of crowd.slice(0, WAYS)) expect(await put(s, who, 1, blobOf(0x11))).toBe('written')
    expect(await put(s, crowd[WAYS]!, 1, blobOf(0x11)), 'a bucket took more than it holds').toBe('full')

    // Everyone already in it carries on, including writing again.
    expect(await s.read(crowd[0]!.id)).toMatchObject({ version: 1 })
    expect(await put(s, crowd[0]!, 2, blobOf(0x22))).toBe('written')
    expect(await s.read(crowd[WAYS]!.id)).toBeNull()
  })

  it('overflows about as rarely as the ways were chosen for', () => {
    // The number behind WAYS, measured rather than asserted. A file made for N
    // households is made with N/32 buckets, so at capacity a bucket holds 32 of
    // 64 on average — and what matters is the tail, not the mean.
    const households = 100_000
    const buckets = bucketsFor(households)
    const counts = new Array<number>(buckets).fill(0)
    for (let i = 0; i < households; i++) counts[bucketOf(randomBytes(32), buckets)]!++
    const fullest = Math.max(...counts)
    const over = counts.filter((n) => n > WAYS).length

    expect(over, `${over} of ${buckets} buckets overflowed at capacity; fullest held ${fullest}`).toBe(0)
    expect(fullest, `the fullest bucket held ${fullest} of ${WAYS}`).toBeLessThan(WAYS)
  })
})

/* ---------------------------------------------------------------------------
 * The ceiling, and moving it
 * ------------------------------------------------------------------------- */

describe('growing the file', () => {
  it('carries every household over, and lands where a fresh file would have put them', async () => {
    // A resize reveals a new capacity and a new modification time, both of
    // which are one number for the whole service. It must not reveal an order,
    // and this is what says so: the grown file is the same bytes a file built
    // from scratch for those households would have been.
    const home = scratch()
    const path = join(home, 'escrow.slots')
    const s = store(path, 64, { entropy: stream('same') })
    const people = Array.from({ length: 30 }, (_, i) =>
      household(createHash('sha256').update(`grow-${i}`).digest())
    )
    for (const who of people) expect(await put(s, who, 1, blobOf(0x11))).toBe('written')
    expect(await put(s, people[0]!, 2, blobOf(0x22))).toBe('written')
    s.close()

    const result = grow(path, 512)
    expect(result.records).toBe(30)
    expect(statSync(path).size).toBe(bytesFor(512))

    const after = store(path, 512)
    for (const who of people) expect(await after.read(who.id), who.id).not.toBeNull()
    expect(await after.read(people[0]!.id)).toMatchObject({ version: 2 })
    // And the household can carry on from where it was, which means the version
    // and the pinned key came across too.
    expect(await put(after, people[0]!, 3, blobOf(0x33))).toBe('written')
    expect(await put(after, people[1]!, 3, blobOf(0x33)), 'a version survived that should not have').toBe(
      'version'
    )
  })

  it('refuses to shrink onto a bucket that would not hold what is in it', async () => {
    const home = scratch()
    const path = join(home, 'escrow.slots')
    const s = store(path, 4096)
    for (let i = 0; i < 200; i++) {
      const who = household(createHash('sha256').update(`shrink-${i}`).digest())
      expect(await put(s, who, 1, blobOf(0x11))).toBe('written')
    }
    s.close()

    expect(() => grow(path, 32)).toThrow(/would put \d+ records in one bucket/)
    // And the old file is untouched, because the rename is the last thing.
    expect(statSync(path).size).toBe(bytesFor(4096))
  })
})
