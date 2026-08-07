/* The escrow service, running in the test process.
 *
 * The handler is real, the store is real and the file is real: this is the
 * production `openSlotStore`, which is what runs on the host too. What is fake
 * is the socket — requests are handed to `handle` directly — because a
 * transport adds nothing to what these tests are trying to establish.
 * `escrow/src/main.test.ts` is where a real one is used.
 *
 * `dump()` is the point of the whole file. It returns everything the service
 * holds, as bytes, so a test can go looking through it for anything a
 * household would recognise.
 *
 * There is no in-memory mode any more, because the store is a file. Every
 * service here gets a real one in a temporary directory and takes it away when
 * it closes — which is better for these tests rather than worse: the file is
 * exactly what a test needs to read.
 *
 * Not a test file — vitest collects `*.test.ts` only.
 */

import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { handle } from '../../escrow/src/escrow.ts'
import {
  BUCKET_BYTES,
  liveImage,
  openSlotStore,
  type EscrowStore,
} from '../../escrow/src/store.ts'

export interface EscrowService {
  /** The origin the app is configured to call. */
  origin: string
  /** What a browser's fetch reaches. Same handler the server exports. */
  fetch: typeof fetch
  /** Where the file is, for a test that wants to read it off the disk. */
  path: string
  /**
   * Every record the file holds, parsed out of it.
   *
   * The store has no verb for this and never will — enumeration is not refused
   * by the handler, it has nowhere to ask for it. So this parses the file the
   * way anybody holding a copy of it could, which is the honest way for a test
   * to say what is in there.
   */
  rows(): { id: string; ver: number; blob: Uint8Array }[]
  /**
   * Every byte the service holds: the whole file, whole.
   *
   * Reading only the records would be a dump of what this harness thought to
   * ask for, and the claim the test makes is about what is there. The slots a
   * household has left, the empty ones and anything an interrupted write left
   * behind are exactly the places a leak would not be a record.
   */
  dump(): Uint8Array
  /** How many requests were handled. Nothing about them is kept. */
  requests: number
  close(): void
}

export function startEscrowService(
  origin = 'https://app.ftw.energy',
  path?: string,
  households = 64
): EscrowService {
  const owned = path ? '' : mkdtempSync(join(tmpdir(), 'ftw-escrow-svc-'))
  const file = path ?? join(owned, 'escrow.slots')
  const store: EscrowStore = openSlotStore(file, { households })

  const service: EscrowService = {
    origin: 'https://escrow.ftw.energy',
    path: file,
    requests: 0,
    async fetch(input: RequestInfo | URL, init?: RequestInit) {
      service.requests++
      return handle(new Request(input as RequestInfo, init), store, origin)
    },
    rows() {
      const bytes = readFileSync(file)
      const out: { id: string; ver: number; blob: Uint8Array }[] = []
      for (let index = 0; index * BUCKET_BYTES < bytes.length; index++) {
        const bucket = bytes.subarray(index * BUCKET_BYTES, (index + 1) * BUCKET_BYTES)
        for (const record of liveImage(bucket, index)?.records ?? []) {
          out.push({
            id: record.id.toString('base64url'),
            ver: record.version,
            blob: new Uint8Array(record.blob.subarray(0, record.length)),
          })
        }
      }
      return out
    },
    dump() {
      return new Uint8Array(readFileSync(file))
    },
    close() {
      store.close()
      if (owned) rmSync(owned, { recursive: true, force: true })
    },
  }

  return service
}
