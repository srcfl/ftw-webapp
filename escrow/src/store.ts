/* One file of fixed slots, and the reason it is not a database.
 *
 * Everything this service is allowed to remember is a record: an id, a version
 * and 512 sealed bytes, plus the public key that is allowed to write it. There
 * is no account, no email, no box id, no site id, no device id, no address, no
 * user agent, no created-at, no updated-at and no access log.
 *
 * The timestamp is the one that gets argued for and it is refused. A write time
 * beside an opaque id is a household's activity record — when they set a phone
 * up, when they added one, when they left — and "nothing beside it" would stop
 * being true the day it was added.
 *
 * WHY A SLOT FILE, WHICH IS THE WHOLE POINT OF THIS FILE.
 *
 * The same sentence has been false four times on a disk, each time one layer
 * below where the previous fix looked. Two more were not on one and are not what
 * this file is about: a document that went stale, and the clock the two fsyncs
 * below run — see the note above them, and README.md, which carries all six.
 * On Cloudflare D1, whose Time Travel kept the write
 * times the schema refuses. In the proxy, whose access log kept a timestamp and
 * byte counts that told a put from a get from a miss. Then in the storage
 * engine's own file: a b-tree page keeps its cell pointers in key order and
 * allocates the cell contents from the end of the page downward in WRITE order,
 * so sorting a page's cells by descending byte offset handed back the
 * households in the order they joined. And then in the fix for that — a VACUUM
 * after every write, which writes a full arrival-ordered copy of the database
 * beside it as a rollback journal on every save, so a household LEAVING put its
 * own ciphertext in that journal on the way out.
 *
 * A b-tree records the arrival order structurally: in the page, in the journal,
 * in the page allocation. Chasing it a layer at a time is fighting the tool. So
 * there is no tree. A record's position is a function of its id and of nothing
 * else, every slot is the same size and is there from the moment the file is
 * created, and a write lands in place. There is no order to remove because
 * there is no order: the bytes on the disk are a function of WHAT is stored,
 * never of WHEN. A test writes the same households in opposite orders and fails
 * unless the two files are byte for byte the same.
 *
 * Nothing off the shelf keeps that. Every store that was measured is in
 * README.md with what it did: a file or an object per household is an mtime per
 * household, an LSM keeps a write-ahead log of the arrival order in plain text,
 * Redis answers OBJECT IDLETIME per key, Postgres puts an arrival counter on
 * every row in xmin, and LMDB and the dbm family both leave files that differ
 * when the same households arrive in a different order.
 *
 * THE LAYOUT, and layout.md carries the same thing for someone who would rather
 * not read TypeScript. A test holds the two together.
 *
 *   file    = BUCKETS buckets, and nothing else. No header, no index, no free
 *             list. The capacity is the file's length divided by a constant.
 *   bucket  = two images of the same size, side by side.
 *   image   = WAYS records, then a 32-byte digest of all of them.
 *   record  = id 32 B, head 8 B, write key 32 B, blob 512 B, digest 32 B.
 *   head    = version 4 B, blob length 2 B, two zero bytes — masked, see below.
 *
 * WHY TWO IMAGES. There is no transaction now, and a 39 kB write is not atomic:
 * a machine that dies in the middle of one leaves a slot that is half old and
 * half new. So a write never touches the image it would destroy. It builds the
 * whole new image, writes it into the OTHER one and only then wipes the one it
 * replaced, so at every instant at least one image of a bucket is whole. A
 * half-written image fails its digest and is refused rather than read as data.
 *
 * That costs the file twice the space and buys atomicity with no journal — and
 * a journal is exactly what leaked last time, so this is the trade being made
 * deliberately rather than by accident.
 *
 * WHY THE OLD IMAGE IS WIPED RATHER THAN LEFT. Double buffering is a journal by
 * another name if the replaced copy is left where it is: a household that
 * clears its copy would leave the previous image holding the ciphertext they
 * just took away. So the write is two steps — the new image, then random bytes
 * over the old one — and neither the file nor anything beside it keeps a
 * household's last copy after they leave.
 *
 * WHY EMPTY LOOKS LIKE FULL. Every slot the file has is written at creation,
 * with random bytes. An id is 32 bytes of HKDF output, a write key is a curve
 * point, a blob is AES-GCM ciphertext and a digest is SHA-256 — all
 * indistinguishable from random — so the only fields that would stand out are
 * the version and the length, and those are masked with bytes derived from the
 * record's own id. The result is that the file's length says what it could
 * hold and nothing in it says what it does hold: a byte histogram, a
 * compressor, `strings` and a search for runs of zeroes all come back the same
 * whether it holds one household or four hundred, and a test measures exactly
 * that. What it is NOT is a secret from someone who has the file and knows this
 * layout — they can verify each digest and count. README.md says so in those
 * words rather than claiming more.
 *
 * WHY COLLISIONS ARE NOT PROBED FOR. Two ids can land on one bucket, and the
 * obvious answer — walk to the next free slot — writes the arrival order back
 * into the file, because the household that got the home slot is the one that
 * came first. So a bucket holds WAYS records and they are kept sorted by id.
 * Where a record sits is a function of the set of ids in its bucket and of
 * nothing else, which is the same property the whole file has and is why the
 * byte-for-byte test passes.
 *
 * WHY EVERY READ DOES THE SAME WORK, which is another place the sentence at the
 * top was false and one that left no bytes anywhere.
 *
 * The ones above were about bytes somebody could read. This one needed nothing
 * but a stopwatch. Parsing a bucket used to stop the moment an image
 * failed its digest, so a bucket with nobody in it cost two hashes and a bucket
 * with somebody in it cost those plus a hundred and twenty-eight more: measured
 * at 32 us against 119 us for reads that BOTH missed. Bucket occupancy is a
 * household counter, and watching a bucket go from empty to occupied is an
 * arrival — the same thing the file layout refuses, arriving over the wire
 * instead. Every answer was already padded to 1024 bytes, which fixed the size
 * channel and did nothing at all about the clock.
 *
 * So a bucket is parsed whole, every time: both images, all 2*WAYS slots, the
 * same digests, the same loop and the same allocations whether the bucket holds
 * nobody, one household or sixty-four. Nothing on the read path returns early
 * on something the file decides, the search over the slots compares every one
 * of them, and the comparisons are a fixed number of steps rather than a
 * memcmp that stops at the first difference. It costs about twice what the old
 * fast path cost — a read went from 119 us to 219 us. That is the price and it
 * is worth it: this service does one read when somebody reinstalls, and 219 us
 * is not a number any household will ever notice. cost.test.ts counts the
 * digests rather than trusting a clock, and README.md says what is left over.
 *
 * The write path had the same hole and a second one of its own: the pinned-key
 * check ran before the signature check, so a write with the wrong key against
 * an id somebody holds skipped an Ed25519 verification that the same write
 * against an unheld id had to pay for — 151 us against 224 us, an existence
 * oracle for anyone who has learned an id. Both checks run now, always, and
 * the answer is decided after.
 */

import { createHash, createPublicKey, randomFillSync, timingSafeEqual, verify } from 'node:crypto'
import { closeSync, existsSync, fstatSync, fsyncSync, openSync, readSync, writeSync } from 'node:fs'
import { dirname } from 'node:path'

/** base64url of 32 bytes, unpadded. The id, and the write key, are both this. */
const B64URL_32 = 43

export const ID_BYTES = 32
export const BLOB_BYTES = 512
export const WRITE_KEY_BYTES = 32
export const SIGNATURE_BYTES = 64
const HEAD_BYTES = 8
const DIGEST_BYTES = 32

/** id, head, write key, blob, digest. */
export const RECORD_BYTES = ID_BYTES + HEAD_BYTES + WRITE_KEY_BYTES + BLOB_BYTES + DIGEST_BYTES

/**
 * How many records a bucket holds.
 *
 * The only thing this number does is make a bucket overflowing rare enough to
 * ignore, and the tail is what decides it rather than taste. At half full a
 * bucket holds WAYS/2 households on average and refuses the next new id at
 * WAYS; with 64 ways that is a mean of 32 against a ceiling of 64, which
 * store.test.ts measures at about one bucket in a quarter of a million. Wider
 * buckets are also cheaper per household, because the empty half of every
 * bucket is the price of not probing.
 */
export const WAYS = 64

/** Slots in a bucket across both its images. Every read looks at all of them. */
const SLOTS = 2 * WAYS

/** Households per bucket at the capacity the file is created for. */
const LOAD = WAYS / 2

export const IMAGE_BYTES = WAYS * RECORD_BYTES + DIGEST_BYTES
export const BUCKET_BYTES = 2 * IMAGE_BYTES

/**
 * The capacity a fresh file is created with, in households.
 *
 * Small on purpose. This is 10 MB, it is created in one go, and growing it is a
 * documented five-minute job with the service stopped — see grow.ts. Sizing it
 * for a population that does not exist yet would be the only thing in this
 * directory that is bigger than it needs to be.
 */
export const DEFAULT_HOUSEHOLDS = 4096

export function bucketsFor(households: number): number {
  return Math.max(1, Math.ceil(households / LOAD))
}

/** What one household of capacity costs on the disk. About 2.5 kB. */
export function bytesFor(households: number): number {
  return bucketsFor(households) * BUCKET_BYTES
}

/**
 * Domain strings, so no two digests in this file can ever be each other's.
 *
 * Exported because layout.md names them and a test forges a slot with them —
 * which is the only way to ask whether a slot that merely looks like a record
 * is taken for one. They are not secrets and nothing rests on their being
 * unknown: every one of them is in a file anybody can read.
 */
export const DOMAINS = {
  bucket: 'ftw.escrow.slot.bucket.v1',
  head: 'ftw.escrow.slot.head.v1',
  record: 'ftw.escrow.slot.record.v1',
  image: 'ftw.escrow.slot.image.v1',
} as const

const D_BUCKET = DOMAINS.bucket
const D_HEAD = DOMAINS.head
const D_RECORD = DOMAINS.record
const D_IMAGE = DOMAINS.image

/**
 * The string a write is signed over.
 *
 * Exported because the app builds the same one and a test drives one through
 * the other. The blob is covered by its digest rather than by its bytes, so the
 * message is short and the same shape whether a household is saving 512 bytes
 * or clearing them.
 */
export function writeMessage(id: string, version: number, blob: Uint8Array): Uint8Array {
  const digest = createHash('sha256').update(blob).digest('hex')
  return Buffer.from(`ftw-escrow:v1:${id}:${version}:${digest}`, 'utf8')
}

export interface StoredBlob {
  version: number
  blob: Uint8Array
}

/** Everything a write carries. The last two are what make it authorised. */
export interface WriteRequest {
  id: string
  version: number
  /** 512 bytes, or none at all — which is how a household clears its copy. */
  blob: Uint8Array
  /** Ed25519, 32 bytes. Pinned on the first write and never changed after. */
  writeKey: Uint8Array
  /** Ed25519 over writeMessage(id, version, blob), 64 bytes. */
  signature: Uint8Array
}

export type WriteOutcome =
  | 'written'
  /** The version was not the immediate successor. */
  | 'version'
  /** The signature failed, or the write key is not the one pinned here. */
  | 'unauthorised'
  /** This id's bucket is full and this id is not already in it. */
  | 'full'

/**
 * What the handler is allowed to do to storage. Two verbs, and no list.
 *
 * There is deliberately no `all`, no `count` and no `since`: enumeration is not
 * refused by the handler, it has nowhere to ask for it. And no `delete` — see
 * ESCROW_CLEARED_BYTES in ./escrow for why a record is emptied rather than
 * removed, which is the difference between a rollback guard that holds and one
 * with a door in it.
 */
export interface EscrowStore {
  read(id: string): Promise<StoredBlob | null>
  write(request: WriteRequest): Promise<WriteOutcome>
  /**
   * False once wiping a replaced image has failed, which is a privacy fault and
   * not a storage one — every household is served correctly while the file
   * holds a copy somebody has taken away. The health check reads it, because
   * this service writes no logs and a property that quietly stops holding is
   * the thing this whole directory exists to avoid.
   */
  tidy(): boolean
  close(): void
}

export interface SlotOptions {
  /** Households the file is created for. Ignored if the file already exists. */
  households?: number
  /**
   * Where the random filling comes from. Injected by the test that proves the
   * layout carries no arrival order, and by nothing else: it passes a function
   * of the file offset, so the two files it compares differ only where the
   * content differs. In production this is the system's random source, which
   * depends on nothing at all and so cannot record an order either.
   */
  entropy?(out: Uint8Array, at: number): void
  /**
   * Injected by the test that kills a write in the middle, and by nothing else.
   */
  writeAt?(fd: number, bytes: Uint8Array, at: number): void
}

/** One household's record, as it sits in a slot. */
export interface SlotRecord {
  id: Buffer
  version: number
  length: number
  writeKey: Buffer
  blob: Buffer
}

/**
 * Open the store, creating the file if it is not there.
 *
 * Creating it writes every byte rather than declaring a length, and that is not
 * housekeeping either. A file with holes in it has its blocks handed out by the
 * filesystem as they are first written, so the physical order of the blocks
 * would be the order the households arrived in — the same defect one layer
 * further down than the one that started this. Writing the whole file at
 * creation puts every block on the disk before any household exists.
 */
export function openSlotStore(path: string, opts: SlotOptions = {}): EscrowStore {
  const entropy = opts.entropy ?? ((out: Uint8Array) => void randomFillSync(out))
  const put =
    opts.writeAt ?? ((fd: number, bytes: Uint8Array, at: number) => void writeSync(fd, bytes, 0, bytes.length, at))

  if (!existsSync(path)) create(path, bucketsFor(opts.households ?? DEFAULT_HOUSEHOLDS), entropy)

  const fd = openSync(path, 'r+')
  const size = fstatSync(fd).size
  if (size === 0 || size % BUCKET_BYTES !== 0) {
    closeSync(fd)
    throw new Error(`${path} is ${size} bytes, which is not a whole number of slots`)
  }
  const buckets = size / BUCKET_BYTES
  let tidy = true

  const bucketAt = (index: number): Buffer => {
    const out = Buffer.allocUnsafe(BUCKET_BYTES)
    readSync(fd, out, 0, BUCKET_BYTES, index * BUCKET_BYTES)
    return out
  }

  return {
    tidy: () => tidy,
    close: () => closeSync(fd),

    /**
     * A household's copy, and the same work whether or not there is one.
     *
     * Everything below the first line is a function of the id and of the bucket
     * SIZE, never of what the bucket holds: one read of a fixed length, one
     * parse that always walks every slot of both images, one search that always
     * compares every slot, and one 512-byte copy that happens even when there
     * was nothing to copy. What is left after that is a single branch and one
     * small object, which is stated in README.md rather than glossed.
     */
    async read(id) {
      const raw = decodeId(id)
      if (!raw) return null
      const index = bucketOf(raw, buckets)
      const parsed = readBucket(bucketAt(index), index)
      const at = slotOf(parsed, raw)

      // Slot 0 stands in when there was no match, so that the copy a hit makes
      // is a copy a miss makes too. It is thrown away on the next line.
      const found = parsed.slots[at < 0 ? 0 : at]!
      const blob = new Uint8Array(BLOB_BYTES)
      blob.set(found.blob)
      if (at < 0) return null
      return { version: found.version, blob: blob.subarray(0, found.length) }
    },

    /**
     * Read, decide and write, in one synchronous run.
     *
     * This is where the rollback guard used to rest on a single SQL statement,
     * and it rests on this instead: every call below is the synchronous form,
     * so nothing yields between reading a version and writing its successor and
     * two devices cannot race through the middle. It is why this service must
     * run as one process — deploy/README.md says so beside the compose file, and
     * a test fires concurrent writes at one id and fails unless exactly one wins.
     */
    async write({ id, version, blob, writeKey, signature }) {
      const raw = decodeId(id)
      if (!raw) return 'unauthorised'
      const index = bucketOf(raw, buckets)
      const bucket = bucketAt(index)
      // The same whole-bucket parse a read does, and for the same reason: a put
      // that cannot be signed still gets this far, so a refusal that was quick
      // over an empty bucket would count the households for anyone who can send
      // one — no credential, no id worth knowing, just a stopwatch.
      const parsed = readBucket(bucket, index)
      const at = slotOf(parsed, raw)
      const held = at < 0 ? null : parsed.slots[at]!

      // Who first, and the version after. A caller who cannot sign is told
      // nothing about the version they guessed, and a signature is over the
      // version anyway — so a write with the wrong number is not a version
      // conflict, it is somebody else's write.
      //
      // Trust on first write, and never a second key after that. Constant time,
      // because the comparison is against a value an attacker is trying to
      // guess byte by byte.
      //
      // BOTH checks, always, and the answer decided after them. The pinned-key
      // check used to come first and return on its own, so a wrong key against
      // an id somebody holds cost 151 us and the same wrong key against an id
      // nobody holds cost 224 us — the difference being the Ed25519 verify the
      // first one skipped. That is an existence oracle, and `&&` is what built
      // it. The refusal is the same either way, so nothing is lost by paying
      // for both.
      const signed = authentic(id, version, blob, writeKey, signature)
      const mine = held === null || equalKeys(held.writeKey, writeKey)
      if (!signed || !mine) return 'unauthorised'

      // Strictly the successor, never merely greater. A gap means a write was
      // lost or forged, and accepting one lets anyone who watched a number go
      // by push a household past a copy they are holding — with their own good
      // signature over their own old version, which is why this survives the
      // check above rather than being covered by it.
      if (version !== (held ? held.version : 0) + 1) return 'version'

      // And the ceiling last, which matters more than it looks. `full` is the
      // one answer that says something about the OTHER households in a bucket,
      // so it must not be reachable by a probe. Behind the version check it is
      // only ever reached at version 1 — and a version 1 that gets past the
      // ceiling lands, claiming the id. So there is no way to ask "is this
      // bucket full" without writing to it. Swapping these two lines round
      // would turn a 507 into a free household counter.
      if (!held && parsed.count >= WAYS) return 'full'

      // Past the gate, so the work below is a household's own and may depend on
      // what its bucket holds. Nobody who cannot sign reaches this line.
      const next: SlotRecord[] = []
      for (let slot = 0; slot < SLOTS; slot++) {
        if (parsed.held[slot] && slot !== at) next.push(parsed.slots[slot]!)
      }
      next.push({
        id: raw,
        version,
        length: blob.length,
        writeKey: Buffer.from(writeKey),
        blob: padded(blob, entropy),
      })
      // Sorted by id, so where a record sits is a function of the set in its
      // bucket. The moment this becomes "wherever there was room", the file
      // starts recording which household came first.
      next.sort((a, b) => Buffer.compare(a.id, b.id))

      // Every accepted write adds exactly one to the bucket's total, so the
      // image with the larger total is the newer one and the parity of that
      // total says which image it must be written into. Both are a function of
      // what is stored: nothing here counts writes or looks at a clock.
      const total = next.reduce((sum, record) => sum + record.version, 0)
      const target = total % 2

      // TWO FSYNCS, AND THEY CAN BE HEARD. Nothing else in this file touches the
      // disk: a get and a refused write pay none. So an accepted write answers
      // about 2 ms later than anything else, and because this whole function is
      // synchronous in a single process, every request already in flight waits
      // for it — which is how anybody who can send one learns that a write
      // landed and about when. That is the sixth time the claim was false and
      // the only one left open, because it carries no id, no bucket and no
      // household: README.md prices it under "what it still knows" against what
      // closing it would cost, which is two fsyncs on every read.
      //
      // So these two lines and the read path's lack of them are load-bearing for
      // a number written down in three places. tests/escrow-claims.test.ts in
      // the app's repository fails if either side of that moves.
      put(fd, image(next, index, target, entropy), imageAt(index, target))
      fsyncSync(fd)

      // Only now is the copy this one replaces taken away. Until this line both
      // images are whole, which is what makes a machine dying in the middle of
      // the line above cost nothing.
      try {
        const scratch = Buffer.allocUnsafe(IMAGE_BYTES)
        entropy(scratch, imageAt(index, 1 - target))
        put(fd, scratch, imageAt(index, 1 - target))
        fsyncSync(fd)
      } catch {
        // The save landed and saying otherwise would cost the household their
        // copy: the app would retry the same version, which the successor rule
        // then refuses for the rest of time. So the truth goes to the health
        // check instead, which is the only place with no household in it.
        tidy = false
      }
      return 'written'
    },
  }
}

// ---------------------------------------------------------------------------
// The file
// ---------------------------------------------------------------------------

function create(path: string, buckets: number, entropy: (out: Uint8Array, at: number) => void): void {
  const fd = openSync(path, 'wx', 0o600)
  try {
    const chunk = Buffer.allocUnsafe(BUCKET_BYTES)
    for (let index = 0; index < buckets; index++) {
      entropy(chunk, index * BUCKET_BYTES)
      writeSync(fd, chunk, 0, BUCKET_BYTES, index * BUCKET_BYTES)
    }
    fsyncSync(fd)
  } finally {
    closeSync(fd)
  }
  // The file itself, not only its contents. Without this a power cut in the
  // first minute can leave a directory entry with no file behind it.
  const dir = openSync(dirname(path), 'r')
  try {
    fsyncSync(dir)
  } finally {
    closeSync(dir)
  }
}

const imageAt = (bucket: number, image: number): number => bucket * BUCKET_BYTES + image * IMAGE_BYTES

/** Which bucket an id belongs to. A function of the id, and of nothing else. */
export function bucketOf(id: Uint8Array, buckets: number): number {
  const digest = createHash('sha256').update(D_BUCKET).update(id).digest()
  return digest.readUInt32BE(0) % buckets
}

// ---------------------------------------------------------------------------
// Reading a bucket
// ---------------------------------------------------------------------------

/**
 * A bucket, parsed whole. The shape of this is a constant.
 *
 * Always SLOTS entries, always in the same order, whatever the bucket holds —
 * which is the point. The parse below does the same digests, the same loop and
 * the same allocations for a bucket with nobody in it as for a full one, so
 * timing a read says nothing about how many households are behind it.
 */
interface ParsedBucket {
  /** Every slot of both images, image 0 first. Views into `bucket`, not copies. */
  slots: SlotRecord[]
  /** 1 where a slot holds a record OF THE LIVE IMAGE, 0 everywhere else. */
  held: Uint8Array
  /** Which image is the live one. 0 when neither is whole. */
  image: number
  /** Whether the live image's digest checks out at all. */
  whole: number
  /** How many households the live image holds. */
  count: number
}

/**
 * Every slot in a bucket, at a cost that is a function of the bucket's SIZE.
 *
 * There is no early return anywhere below and there is meant not to be. The old
 * parser stopped when an image failed its digest, which is exactly the state an
 * empty bucket is in — so an empty bucket cost two hashes and an occupied one
 * cost a hundred and thirty. Both images are hashed and both are walked, every
 * time, and a slot that holds noise costs a slot that holds a household.
 */
function readBucket(bucket: Buffer, index: number): ParsedBucket {
  const slots = new Array<SlotRecord>(SLOTS)
  const held = new Uint8Array(SLOTS)
  const whole = new Uint8Array(2)
  // A version is a uint32 and a bucket holds WAYS of them, which is well inside
  // what a double counts exactly.
  const totals = new Float64Array(2)

  for (let which = 0; which < 2; which++) {
    const bytes = bucket.subarray(which * IMAGE_BYTES, (which + 1) * IMAGE_BYTES)
    const body = bytes.subarray(0, WAYS * RECORD_BYTES)
    // A half-written image is refused rather than read as data. There is no
    // transaction any more, and this is what replaces one. It no longer
    // shortens the work when it fails.
    whole[which] = same(
      createHash('sha256').update(D_IMAGE).update(header(index, which)).update(body).digest(),
      bytes.subarray(WAYS * RECORD_BYTES)
    )

    for (let way = 0; way < WAYS; way++) {
      const at = which * WAYS + way
      const slot = readSlot(body.subarray(way * RECORD_BYTES, (way + 1) * RECORD_BYTES), index, which, way)
      slots[at] = slot.record
      held[at] = slot.live & whole[which]!
      totals[which] = totals[which]! + slot.record.version * held[at]!
    }
  }

  // Whole images only, and of two whole ones the one with the larger total.
  // Both can be whole for exactly as long as it takes to wipe the older, and
  // that window is the one a machine dying mid-write leaves behind.
  //
  // Arithmetic rather than a loop that breaks: a whole image scores its total
  // and a torn one scores less than any of them.
  const score = (i: number): number => whole[i]! * (totals[i]! + 1) - 1
  const image = score(1) > score(0) ? 1 : 0

  // And only the live image's slots count. Both were parsed either way, which
  // is the whole reason the loop above has no `continue` in it.
  const from = image * WAYS
  let count = 0
  for (let at = 0; at < SLOTS; at++) {
    held[at]! &= at >= from && at < from + WAYS ? 1 : 0
    count += held[at]!
  }

  return { slots, held, image, whole: whole[image]!, count }
}

/**
 * Where an id sits in a parsed bucket, or -1.
 *
 * Every slot, every time, and `same` rather than `Buffer.equals`: stopping at
 * the first match would make a read of the household in way 0 cheaper than a
 * read of the one in way 63, and stopping at the first differing byte would
 * make a near miss cost more than a far one. Neither is a number this service
 * is allowed to hand out.
 */
function slotOf(parsed: ParsedBucket, raw: Buffer): number {
  let found = -1
  for (let at = 0; at < SLOTS; at++) {
    found = (parsed.held[at]! & same(parsed.slots[at]!.id, raw)) === 1 ? at : found
  }
  return found
}

/**
 * Whether two byte strings match, in a fixed number of steps.
 *
 * `Buffer.equals` is a memcmp and stops at the first difference, so it tells
 * anyone timing it how far in the two agreed. This does not stop. It is not a
 * claim about what the CPU does underneath — see README.md, which says what is
 * left — it is a claim about the number of steps this loop takes.
 */
function same(a: Uint8Array, b: Uint8Array): number {
  let diff = a.length ^ b.length
  for (let i = 0; i < a.length; i++) diff |= a[i]! ^ b[i]!
  return ((diff - 1) >>> 31) & 1
}

/**
 * One slot, and whether it holds a record.
 *
 * Always a record and always a flag, never null: a caller that got null for an
 * empty slot could not help doing less work for one. The fields are views into
 * the bucket rather than copies, so the allocation count is the same for a slot
 * of noise as for a household.
 */
function readSlot(
  bytes: Buffer,
  index: number,
  image: number,
  way: number
): { record: SlotRecord; live: number } {
  const id = bytes.subarray(0, ID_BYTES)
  const head = Buffer.from(bytes.subarray(ID_BYTES, ID_BYTES + HEAD_BYTES))
  const mask = headMask(id)
  for (let i = 0; i < HEAD_BYTES; i++) head[i]! ^= mask[i]!

  const version = head.readUInt32BE(0)
  const length = head.readUInt16BE(4)
  const writeKey = bytes.subarray(ID_BYTES + HEAD_BYTES, ID_BYTES + HEAD_BYTES + WRITE_KEY_BYTES)
  const blob = bytes.subarray(
    ID_BYTES + HEAD_BYTES + WRITE_KEY_BYTES,
    ID_BYTES + HEAD_BYTES + WRITE_KEY_BYTES + BLOB_BYTES
  )
  // The one thing that tells a record from 616 random bytes. Random bytes fail
  // it, which is why an empty slot needs no marker and the file can be filled
  // with noise from the moment it is made.
  //
  // All three checks, always. `&` rather than `&&`, because `&&` is a branch
  // and a branch here is the whole defect this file was rewritten for.
  const digest = recordDigest(id, head, writeKey, blob, index, image, way)
  const live =
    same(digest, bytes.subarray(RECORD_BYTES - DIGEST_BYTES)) &
    (length === 0 || length === BLOB_BYTES ? 1 : 0) &
    (version >= 1 ? 1 : 0)

  return { record: { id, version, length, writeKey, blob }, live }
}

/**
 * The records in a bucket, from whichever of its two images is current.
 *
 * Exported because grow.ts and the tests need it, and because a parser is the
 * honest way to say what this file does and does not hide. It reveals nothing
 * that reading this source does not.
 *
 * NOT on the service's read or write path, and that is deliberate: what it
 * returns is a list as long as the bucket is full, and building one costs what
 * the bucket holds. Everything a household waits on goes through readBucket
 * above instead. This is for the resize tool and the tests, where an operator
 * is standing in front of it and there is nobody to time.
 *
 * The records are copies rather than views because grow.ts reads the whole file
 * through one buffer it reuses for every bucket, and a view would end up
 * pointing at whichever bucket was read last.
 */
export function liveImage(
  bucket: Buffer,
  index: number
): { image: number; records: SlotRecord[]; total: number } | null {
  const parsed = readBucket(bucket, index)
  if (!parsed.whole) return null

  const records: SlotRecord[] = []
  for (let at = 0; at < SLOTS; at++) {
    if (!parsed.held[at]) continue
    const record = parsed.slots[at]!
    records.push({
      id: Buffer.from(record.id),
      version: record.version,
      length: record.length,
      writeKey: Buffer.from(record.writeKey),
      blob: Buffer.from(record.blob),
    })
  }
  return { image: parsed.image, records, total: records.reduce((sum, r) => sum + r.version, 0) }
}

// ---------------------------------------------------------------------------
// Writing a bucket
// ---------------------------------------------------------------------------

/**
 * One whole bucket, built from a set of records and from nothing else.
 *
 * Used when a file is made from scratch — see grow.ts — where there is no
 * earlier copy to protect and both images can be written at once. The live one
 * goes where the rule below says it goes and the other is noise, which is
 * exactly the state a bucket is left in by an ordinary write.
 *
 * Exported so that the rule for where a record sits has one spelling. A second
 * copy of it in the growing tool is a file that comes out different from the one
 * the service would have written, and nobody would notice until a household
 * could not find their copy.
 */
export function packBucket(
  records: SlotRecord[],
  index: number,
  entropy: (out: Uint8Array, at: number) => void = (out) => void randomFillSync(out)
): Buffer {
  if (records.length > WAYS) throw new Error(`bucket ${index} would hold ${records.length} of ${WAYS}`)
  const sorted = [...records].sort((a, b) => Buffer.compare(a.id, b.id))
  const total = sorted.reduce((sum, record) => sum + record.version, 0)
  const target = total % 2

  const bucket = Buffer.allocUnsafe(BUCKET_BYTES)
  image(sorted, index, target, entropy).copy(bucket, target * IMAGE_BYTES)
  const other = Buffer.allocUnsafe(IMAGE_BYTES)
  entropy(other, imageAt(index, 1 - target))
  other.copy(bucket, (1 - target) * IMAGE_BYTES)
  return bucket
}

/** One whole image: the records, packed and sorted, then noise, then a digest. */
function image(
  records: SlotRecord[],
  index: number,
  which: number,
  entropy: (out: Uint8Array, at: number) => void
): Buffer {
  const bytes = Buffer.allocUnsafe(IMAGE_BYTES)
  // Noise first, over the whole thing, so every byte a record does not use is
  // random rather than left over. The empty half of a bucket looks exactly like
  // the empty half of an unused one.
  entropy(bytes, imageAt(index, which))

  records.forEach((record, way) => {
    const at = way * RECORD_BYTES
    const head = Buffer.alloc(HEAD_BYTES)
    head.writeUInt32BE(record.version, 0)
    head.writeUInt16BE(record.length, 4)
    const digest = recordDigest(record.id, head, record.writeKey, record.blob, index, which, way)

    record.id.copy(bytes, at)
    const mask = headMask(record.id)
    for (let i = 0; i < HEAD_BYTES; i++) bytes[at + ID_BYTES + i] = head[i]! ^ mask[i]!
    record.writeKey.copy(bytes, at + ID_BYTES + HEAD_BYTES)
    record.blob.copy(bytes, at + ID_BYTES + HEAD_BYTES + WRITE_KEY_BYTES)
    digest.copy(bytes, at + RECORD_BYTES - DIGEST_BYTES)
  })

  createHash('sha256')
    .update(D_IMAGE)
    .update(header(index, which))
    .update(bytes.subarray(0, WAYS * RECORD_BYTES))
    .digest()
    .copy(bytes, WAYS * RECORD_BYTES)
  return bytes
}

/** The blob, at its one stored length, with noise where it does not reach. */
function padded(blob: Uint8Array, entropy: (out: Uint8Array, at: number) => void): Buffer {
  const out = Buffer.allocUnsafe(BLOB_BYTES)
  entropy(out, 0)
  Buffer.from(blob).copy(out)
  return out
}

function header(index: number, image: number): Buffer {
  const out = Buffer.alloc(5)
  out.writeUInt32BE(index, 0)
  out.writeUInt8(image, 4)
  return out
}

function recordDigest(
  id: Uint8Array,
  head: Uint8Array,
  writeKey: Uint8Array,
  blob: Uint8Array,
  index: number,
  image: number,
  way: number
): Buffer {
  const place = Buffer.alloc(7)
  place.writeUInt32BE(index, 0)
  place.writeUInt8(image, 4)
  place.writeUInt16BE(way, 5)
  return createHash('sha256')
    .update(D_RECORD)
    .update(place)
    .update(id)
    .update(head)
    .update(writeKey)
    .update(blob)
    .digest()
}

/**
 * Eight bytes that make a version and a length look like everything else.
 *
 * Not encryption and never described as any: the id it is derived from is
 * sitting in the same slot, so anyone who knows this layout unmasks it in a
 * line. What it defeats is the tool that does not — a byte histogram over the
 * file, which would otherwise see a spike of zeroes exactly proportional to the
 * number of households and count them without knowing anything at all.
 */
function headMask(id: Uint8Array): Buffer {
  return createHash('sha256').update(D_HEAD).update(id).digest().subarray(0, HEAD_BYTES)
}

// ---------------------------------------------------------------------------
// Who may write
// ---------------------------------------------------------------------------

/**
 * Whether this write is signed by the key it presents.
 *
 * Knowing an id used to be the whole authorisation, so anyone who learned one
 * could write version+1 of anything and destroy a household's spare copy. Now a
 * write carries an Ed25519 key and a signature over the id, the version and the
 * blob's digest; the first write pins the key and no later write with a
 * different one is taken. The key is a sibling of the sealing key, derived from
 * the same passkey, so it costs the household nothing.
 *
 * Reading is deliberately still the id alone: a fresh device has a passkey and
 * nothing else, and it has to be able to read.
 */
function authentic(
  id: string,
  version: number,
  blob: Uint8Array,
  writeKey: Uint8Array,
  signature: Uint8Array
): boolean {
  if (writeKey.length !== WRITE_KEY_BYTES || signature.length !== SIGNATURE_BYTES) return false
  try {
    const key = createPublicKey({
      key: { kty: 'OKP', crv: 'Ed25519', x: Buffer.from(writeKey).toString('base64url') },
      format: 'jwk',
    })
    return verify(null, writeMessage(id, version, blob), key, signature)
  } catch {
    // A 32-byte string that is not a point on the curve. Not a write.
    return false
  }
}

function equalKeys(pinned: Buffer, offered: Uint8Array): boolean {
  return offered.length === pinned.length && timingSafeEqual(pinned, Buffer.from(offered))
}

// ---------------------------------------------------------------------------

/**
 * The 32 bytes behind a 43-character id, or null if it is not one.
 *
 * One spelling per id, and the round trip is what enforces it. 43 base64
 * characters carry 258 bits and an id is 256, so two of the last character's
 * bits are thrown away — which means several different strings decode to the
 * same 32 bytes. A record is keyed by the bytes, so without this check one
 * household would have several names, and the signature covers the name it was
 * sent under. The app sends the canonical one; anything else is refused.
 */
export function decodeId(id: string): Buffer | null {
  if (id.length !== B64URL_32 || !/^[A-Za-z0-9_-]{43}$/.test(id)) return null
  const raw = Buffer.from(id, 'base64url')
  if (raw.length !== ID_BYTES || raw.toString('base64url') !== id) return null
  return raw
}
