/* Growing the file, which is the one thing that happens at the ceiling.
 *
 *   node escrow/src/grow.ts /srv/escrow/data/escrow.slots 100000
 *
 * The file has a capacity because a slot file has to: it is preallocated, so
 * its length is the number of households it can hold. A bucket that is full
 * refuses a household it has never seen with a 507, and the app tells them
 * their home works either way. That is rare — deploy/README.md has the measured
 * number and the row count to watch — but it is a wall rather than a slope, so
 * it is named here rather than discovered on the day.
 *
 * WHAT A RESIZE REVEALS, stated rather than glossed. It reads every record,
 * which is something anyone holding the file can do anyway and which the
 * service itself still has no verb for. It writes a new file, so that file has
 * a new modification time — one time, for the whole service, on a day an
 * operator chose. And it reveals the new capacity, which is the file's length
 * and was never a secret. What it does NOT reveal is any order: the new layout
 * is a function of the set of records, the same as the old one, and the two
 * files are the same bytes for the same households however they arrived.
 *
 * The service must be stopped. There is no locking here and no attempt at any:
 * a resize is an operator standing in front of it, not a background job.
 */

import { closeSync, existsSync, fstatSync, fsyncSync, openSync, readSync, renameSync, writeSync } from 'node:fs'
import { dirname } from 'node:path'
import {
  BUCKET_BYTES,
  bucketOf,
  bucketsFor,
  liveImage,
  packBucket,
  WAYS,
  type SlotRecord,
} from './store.ts'

export interface Growth {
  households: number
  buckets: number
  records: number
  bytes: number
  /** The fullest bucket in the new file, against WAYS. */
  fullest: number
}

/**
 * Rewrite `path` at a new capacity, in place, through a temporary file.
 *
 * The rename is the last step, so a machine that dies during this leaves the
 * old file exactly as it was. It refuses to shrink below what is already there,
 * because a bucket that would overflow is a household whose copy would be
 * dropped on the floor.
 */
export function grow(path: string, households: number): Growth {
  if (!existsSync(path)) throw new Error(`${path} is not there`)

  const fd = openSync(path, 'r')
  const records: SlotRecord[] = []
  try {
    const size = fstatSync(fd).size
    if (size === 0 || size % BUCKET_BYTES !== 0) throw new Error(`${path} is not a whole number of slots`)
    const bucket = Buffer.allocUnsafe(BUCKET_BYTES)
    for (let index = 0; index < size / BUCKET_BYTES; index++) {
      readSync(fd, bucket, 0, BUCKET_BYTES, index * BUCKET_BYTES)
      for (const record of liveImage(bucket, index)?.records ?? []) records.push(record)
    }
  } finally {
    closeSync(fd)
  }

  const buckets = bucketsFor(households)
  const spread: SlotRecord[][] = Array.from({ length: buckets }, () => [])
  for (const record of records) spread[bucketOf(record.id, buckets)]!.push(record)
  const fullest = spread.reduce((most, bucket) => Math.max(most, bucket.length), 0)
  if (fullest > WAYS) {
    throw new Error(`${households} households would put ${fullest} records in one bucket of ${WAYS}`)
  }

  const scratch = `${path}.growing`
  const out = openSync(scratch, 'wx', 0o600)
  try {
    for (let index = 0; index < buckets; index++) {
      const bytes = packBucket(spread[index]!, index)
      writeSync(out, bytes, 0, BUCKET_BYTES, index * BUCKET_BYTES)
    }
    fsyncSync(out)
  } finally {
    closeSync(out)
  }
  renameSync(scratch, path)
  const dir = openSync(dirname(path), 'r')
  try {
    fsyncSync(dir)
  } finally {
    closeSync(dir)
  }

  return {
    households,
    buckets,
    records: records.length,
    bytes: buckets * BUCKET_BYTES,
    fullest,
  }
}

// Run directly, or imported by the test. Nothing is written to stdout unless a
// person asked for it on a command line, which is not a household's request.
if (process.argv[1] && import.meta.url.endsWith(process.argv[1].split('/').pop() ?? '')) {
  const [, , path, households] = process.argv
  if (path && households) {
    const result = grow(path, Number(households))
    process.stdout.write(
      `${result.records} records into ${result.buckets} buckets, ` +
        `${result.bytes} bytes, fullest bucket ${result.fullest} of ${WAYS}\n`
    )
  }
}
