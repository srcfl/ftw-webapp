// @vitest-environment node

/* What the service will and will not do.
 *
 * The claim it has to keep is "an opaque id and nothing beside it", and the
 * rollback guard is what makes the copy safe to keep at all. So the assertions
 * here go at storage rather than at status codes wherever they can: a refusal
 * that returns 409 and writes anyway is exactly the test that passes whichever
 * way the code is written.
 *
 * What the file it writes gives away is store.test.ts.
 */

import { describe, it, expect, afterEach } from 'vitest'
import { generateKeyPairSync, sign as signWith } from 'node:crypto'
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  BUCKET_BYTES,
  IMAGE_BYTES,
  RECORD_BYTES,
  WAYS,
  writeMessage,
} from './store.ts'
import { ESCROW_ANSWER_BYTES, ESCROW_BLOB_BYTES, ESCROW_REQUEST_BYTES, pad } from './escrow.ts'
import { startEscrowService, type EscrowService } from '../../tests/support/escrow-service.ts'

/**
 * Two ids, in the one spelling each of them has.
 *
 * 43 base64 characters carry 258 bits and an id is 256, so several strings
 * decode to the same 32 bytes and the service takes only the one that comes
 * back out of them. `'B'.repeat(43)` is not it, which is a mistake worth making
 * once in a fixture rather than in a household's client.
 */
const ID = 'A'.repeat(43)
const OTHER = Buffer.alloc(32, 0xbb).toString('base64url')

let service: EscrowService | null = null

afterEach(() => {
  service?.close()
  service = null
})

function start(): EscrowService {
  service = startEscrowService()
  return service
}

/**
 * The key a household writes with, and how it signs.
 *
 * node:crypto rather than the curve library the app uses, on purpose: a
 * signature verified by the same library that made it establishes nothing about
 * whether the two sides of the wire agree.
 */
const keys = new Map<string, ReturnType<typeof mint>>()
function mint() {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519')
  return {
    pub: Buffer.from((publicKey.export({ format: 'jwk' }) as { x: string }).x, 'base64url').toString(
      'base64url'
    ),
    sign: (message: Uint8Array) => signWith(null, message, privateKey).toString('base64url'),
  }
}
function who(id: string): ReturnType<typeof mint> {
  const held = keys.get(id) ?? mint()
  keys.set(id, held)
  return held
}
afterEach(() => keys.clear())

function bytesOf(base64: string): Uint8Array {
  const binary = atob(base64)
  const out = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i)
  return out
}

function blobOf(fill: number): string {
  const bytes = new Uint8Array(ESCROW_BLOB_BYTES).fill(fill)
  let binary = ''
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return btoa(binary)
}

/** A put with the signature the service expects. */
function signed(id: string, version: number, blob: string): Record<string, unknown> {
  const signer = who(id)
  return {
    op: 'put',
    id,
    version,
    blob,
    pub: signer.pub,
    sig: signer.sign(writeMessage(id, version, bytesOf(blob))),
  }
}

/** What the app puts on the wire: JSON padded to the one length there is. */
async function call(
  s: EscrowService,
  body: Record<string, unknown>,
  init: RequestInit = {}
): Promise<{ status: number; json: Record<string, unknown>; bytes: number }> {
  return raw(s, pad(body, ESCROW_REQUEST_BYTES), init)
}

/** A body exactly as given, for the tests that are about the length itself. */
async function raw(
  s: EscrowService,
  body: string,
  init: RequestInit = {}
): Promise<{ status: number; json: Record<string, unknown>; bytes: number }> {
  const response = await s.fetch(`${s.origin}/e`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body,
    ...init,
  })
  const text = await response.text()
  return {
    status: response.status,
    json: (text ? JSON.parse(text) : {}) as Record<string, unknown>,
    bytes: new TextEncoder().encode(text).length,
  }
}

const put = (s: EscrowService, version: number, fill: number, id = ID) =>
  call(s, signed(id, version, blobOf(fill)))

/** What is actually in the file for an id, or null. */
function stored(s: EscrowService, id = ID): { ver: number; first: number } | null {
  const row = s.rows().find((r) => r.id === id)
  return row ? { ver: row.ver, first: row.blob[0]! } : null
}

describe('the rollback guard', () => {
  it('takes a first write only as version 1', async () => {
    const s = start()

    expect((await put(s, 5, 0x05)).status, 'a first write jumped straight to 5').toBe(409)
    expect(stored(s), 'a record was created for a version that was never 1').toBeNull()

    expect((await put(s, 1, 0x01)).status).toBe(200)
    expect(stored(s)).toEqual({ ver: 1, first: 0x01 })
  })

  it('refuses an old genuine blob, and leaves the newer one where it was', async () => {
    // The whole point of the guard. Someone holding a copy of version 2 —
    // taken from a backup, or captured on the wire — must not be able to put
    // it back over version 3 and resurrect a home that was removed or a device
    // that was locked out. The signature does not help them: it is the
    // household's own, over their own old version, and still genuine.
    const s = start()
    await put(s, 1, 0x01)
    await put(s, 2, 0x02)
    await put(s, 3, 0x03)

    const replay = await put(s, 2, 0x02)

    expect(replay.status).toBe(409)
    // The assertion that matters. Checking only the status passes just as well
    // against a service that answers 409 and writes the record anyway.
    expect(stored(s), 'an old version was written back over a newer one').toEqual({
      ver: 3,
      first: 0x03,
    })
  })

  it('refuses a replay of the version that is already stored', async () => {
    const s = start()
    await put(s, 1, 0x01)
    await put(s, 2, 0x02)

    expect((await put(s, 2, 0xee)).status).toBe(409)
    expect(stored(s), 'a second write at the stored version overwrote it').toEqual({
      ver: 2,
      first: 0x02,
    })
  })

  it('refuses a gap, because a gap means a write was lost or forged', async () => {
    const s = start()
    await put(s, 1, 0x01)

    expect((await put(s, 3, 0x03)).status).toBe(409)
    expect(stored(s)).toEqual({ ver: 1, first: 0x01 })

    expect((await put(s, 2, 0x02)).status).toBe(200)
    expect(stored(s)).toEqual({ ver: 2, first: 0x02 })
  })

  it('lets exactly one of many devices that saw the same version win', async () => {
    // Two phones on one passkey both read version 2 and both write 3. This used
    // to be settled by SQLite's atomicity for a single statement, and there is
    // no statement any more: it is settled by the store doing its whole
    // read-decide-write synchronously, so nothing yields in the middle of it.
    // Eight at once rather than two, because one racer is a coin toss that
    // passes half the time against code with a real window in it.
    const s = start()
    await put(s, 1, 0x01)
    await put(s, 2, 0x02)

    const answers = await Promise.all(
      Array.from({ length: 8 }, (_, i) => put(s, 3, 0xa0 + i))
    )

    expect(answers.filter((a) => a.status === 200)).toHaveLength(1)
    expect(answers.filter((a) => a.status === 409)).toHaveLength(7)
    expect(stored(s)!.ver).toBe(3)
  })

  it('keeps counting after a household clears its copy, so nothing can come back', async () => {
    const s = start()
    await put(s, 1, 0x01)
    await put(s, 2, 0x02)

    expect((await call(s, signed(ID, 3, ''))).status).toBe(200)
    expect(stored(s)!.ver).toBe(3)
    expect(s.rows()[0]!.blob.length).toBe(0)

    // Someone holding version 1's ciphertext tries to put it back.
    expect((await put(s, 1, 0x01)).status).toBe(409)
    expect(s.rows()[0]!.blob.length, 'an old copy came back after a clear').toBe(0)
  })

  it('counts versions per id, so one household never inherits another', async () => {
    const s = start()
    await put(s, 1, 0x01)
    await put(s, 2, 0x02)

    expect((await put(s, 2, 0x22, OTHER)).status, 'a second id inherited a version').toBe(409)
    expect((await put(s, 1, 0x11, OTHER)).status).toBe(200)
    expect(stored(s, OTHER)).toEqual({ ver: 1, first: 0x11 })
    expect(stored(s, ID)).toEqual({ ver: 2, first: 0x02 })
  })
})

describe('who may write', () => {
  /* Knowing an id used to be the whole authorisation, and this file said so in
   * as many words: "reading and writing both sit behind it and nothing else".
   * So anyone who learned an id could write version+1 of anything and destroy a
   * household's spare copy. A write now carries a key and a signature, the
   * first write pins the key, and nothing else is taken afterwards.
   */

  it('refuses a write signed by a key that is not the one pinned here', async () => {
    const s = start()
    expect((await put(s, 1, 0x01)).status).toBe(200)

    // A stranger who has the id, and their own perfectly good key.
    const stranger = mint()
    const blob = blobOf(0xee)
    const forged = await call(s, {
      op: 'put',
      id: ID,
      version: 2,
      blob,
      pub: stranger.pub,
      sig: stranger.sign(writeMessage(ID, 2, bytesOf(blob))),
    })

    expect(forged.status).toBe(403)
    expect(stored(s), 'a stranger overwrote a household`s copy').toEqual({ ver: 1, first: 0x01 })
  })

  it('refuses a write whose signature does not cover what it is carrying', async () => {
    // The three things the message binds, changed one at a time under a
    // signature that was good for the original.
    const s = start()
    expect((await put(s, 1, 0x01)).status).toBe(200)
    const signer = who(ID)
    const blob = blobOf(0x02)
    const honest = signer.sign(writeMessage(ID, 2, bytesOf(blob)))

    const swapped: [string, Record<string, unknown>][] = [
      ['the blob', { op: 'put', id: ID, version: 2, blob: blobOf(0xee), pub: signer.pub, sig: honest }],
      ['the version', { op: 'put', id: ID, version: 3, blob, pub: signer.pub, sig: honest }],
      ['the id', { op: 'put', id: OTHER, version: 1, blob, pub: signer.pub, sig: honest }],
    ]
    for (const [what, body] of swapped) {
      expect((await call(s, body)).status, `${what} was changed and the write was taken`).toBe(403)
    }
    expect(stored(s)).toEqual({ ver: 1, first: 0x01 })
    expect(stored(s, OTHER)).toBeNull()
  })

  it('refuses a key or a signature that is not one at all', async () => {
    const s = start()
    const signer = who(ID)
    const blob = blobOf(0x01)
    const sig = signer.sign(writeMessage(ID, 1, bytesOf(blob)))

    const rubbish: [string, Record<string, unknown>][] = [
      ['no key', { op: 'put', id: ID, version: 1, blob, sig }],
      ['no signature', { op: 'put', id: ID, version: 1, blob, pub: signer.pub }],
      ['a short key', { op: 'put', id: ID, version: 1, blob, pub: 'AAAA', sig }],
      ['a short signature', { op: 'put', id: ID, version: 1, blob, pub: signer.pub, sig: 'AAAA' }],
      // 32 bytes that are not a point on the curve. The library throws rather
      // than returning false, and a service that let that out would answer 500
      // to anyone who felt like it.
      ['a key that is not a point', { op: 'put', id: ID, version: 1, blob, pub: 'f'.repeat(43), sig }],
      ['a key with a plus in it', { op: 'put', id: ID, version: 1, blob, pub: 'A'.repeat(42) + '+', sig }],
    ]
    for (const [what, body] of rubbish) {
      const answer = await call(s, body)
      expect([400, 403], `${what} answered ${answer.status}`).toContain(answer.status)
    }
    expect(stored(s)).toBeNull()
  })

  it('pins the key on the first write and keeps it through everything after', async () => {
    const s = start()
    expect((await put(s, 1, 0x01)).status).toBe(200)
    expect((await put(s, 2, 0x02)).status).toBe(200)
    // Including through a clear, which is the one write that leaves no
    // ciphertext and so is the one somewhere a pin could plausibly be dropped.
    expect((await call(s, signed(ID, 3, ''))).status).toBe(200)

    const stranger = mint()
    const blob = blobOf(0xee)
    const after = await call(s, {
      op: 'put',
      id: ID,
      version: 4,
      blob,
      pub: stranger.pub,
      sig: stranger.sign(writeMessage(ID, 4, bytesOf(blob))),
    })

    expect(after.status, 'clearing a copy dropped the pin and reopened the id').toBe(403)
    expect(s.rows()[0]!.ver).toBe(3)
  })

  it('still hands the copy back to anyone with the id, which is the point', async () => {
    // Reading is deliberately not behind the key. A fresh install has a passkey
    // and nothing else — no device, no vault, no stored key — and the whole
    // feature is that it can still read.
    const s = start()
    await put(s, 1, 0x7f)

    const got = await call(s, { op: 'get', id: ID })

    expect(got.status).toBe(200)
    expect(got.json['version']).toBe(1)
  })
})

describe('what it refuses to hold', () => {
  it('takes 512 bytes, or none, and nothing in between', async () => {
    const s = start()
    for (const length of [1, 8, ESCROW_BLOB_BYTES - 1, ESCROW_BLOB_BYTES + 1]) {
      const blob = btoa('\0'.repeat(length))
      expect((await call(s, signed(ID, 1, blob))).status, `${length}`).toBe(400)
    }
    expect(stored(s)).toBeNull()
  })

  it('takes an id that is 32 bytes of base64url and nothing else', async () => {
    const s = start()
    for (const id of ['', 'short', 'A'.repeat(42), 'A'.repeat(44), 'A'.repeat(42) + '+']) {
      expect((await call(s, signed(id, 1, blobOf(1)))).status, id).toBe(400)
    }
    expect(s.rows()).toEqual([])
  })

  it('takes one spelling of an id, not the four that decode to it', async () => {
    // 43 base64 characters carry two bits more than an id has, so 'B' repeated
    // 43 times and three other strings all decode to the same 32 bytes. A
    // record is keyed by the bytes and a signature is over the string, so
    // taking more than one spelling would give a household several names.
    const s = start()
    const canonical = Buffer.alloc(32, 0xbb).toString('base64url')
    const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_'
    const aliases = [...alphabet]
      .map((last) => canonical.slice(0, 42) + last)
      .filter(
        (other) =>
          other !== canonical && Buffer.from(other, 'base64url').equals(Buffer.from(canonical, 'base64url'))
      )

    expect(aliases.length, 'the fixture found no other spelling, so it proves nothing').toBe(3)
    for (const id of aliases) {
      expect((await call(s, signed(id, 1, blobOf(1)))).status, id).toBe(400)
    }
    expect((await call(s, signed(canonical, 1, blobOf(1)))).status).toBe(200)
  })

  it('takes a version that is a positive whole number and nothing else', async () => {
    const s = start()
    for (const version of [0, -1, 1.5, '1', null, undefined]) {
      const signer = who(ID)
      expect(
        (
          await call(s, {
            op: 'put',
            id: ID,
            version,
            blob: blobOf(1),
            pub: signer.pub,
            sig: signer.sign(writeMessage(ID, 1, bytesOf(blobOf(1)))),
          })
        ).status
      ).toBe(400)
    }
    expect(stored(s)).toBeNull()
  })

  it('answers only POST /e', async () => {
    const s = start()
    for (const method of ['GET', 'PUT', 'DELETE', 'HEAD']) {
      expect((await s.fetch(`${s.origin}/e`, { method })).status, method).toBe(405)
    }
    expect((await s.fetch(`${s.origin}/e/${ID}`, { method: 'POST' })).status).toBe(404)
    expect((await s.fetch(`${s.origin}/`, { method: 'POST' })).status).toBe(404)
    expect((await s.fetch(`${s.origin}/e?id=${ID}`, { method: 'POST' })).status).toBe(404)
    expect((await s.fetch(`${s.origin}/e?v=1`, { method: 'POST' })).status).toBe(404)
  })

  it('drops a body too large to be a legal request', async () => {
    const s = start()
    const huge = await raw(s, JSON.stringify({ op: 'put', id: ID, version: 1, blob: 'x'.repeat(8192) }))
    expect(huge.status).toBe(400)
  })

  it('takes one request length and nothing else, so no client can skip the padding', async () => {
    const s = start()
    const legal = pad({ op: 'get', id: ID }, ESCROW_REQUEST_BYTES)

    expect(new TextEncoder().encode(legal).length).toBe(ESCROW_REQUEST_BYTES)
    expect((await raw(s, legal.slice(0, -3) + '"}')).status, 'one byte short').toBe(400)
    expect((await raw(s, legal.slice(0, -2) + 'A"}')).status, 'one byte long').toBe(400)
    expect((await raw(s, JSON.stringify({ op: 'get', id: ID }))).status, 'unpadded').toBe(400)
    const wide = pad({ op: 'get', id: ID }, ESCROW_REQUEST_BYTES).replace('A', 'å')
    expect(wide.length, 'the fixture is 1024 characters').toBe(ESCROW_REQUEST_BYTES)
    expect((await raw(s, wide)).status, 'a multi-byte character').toBe(400)
  })
})

describe('one size, whichever operation it was', () => {
  it('answers a put, a read, a miss and a refusal with the same number of bytes', async () => {
    const s = start()

    const put1 = await put(s, 1, 0x01)
    const hit = await call(s, { op: 'get', id: ID })
    const miss = await call(s, { op: 'get', id: OTHER })
    const conflict = await put(s, 1, 0x02)
    const stranger = mint()
    const blob = blobOf(0x03)
    const refused = await call(s, {
      op: 'put',
      id: ID,
      version: 2,
      blob,
      pub: stranger.pub,
      sig: stranger.sign(writeMessage(ID, 2, bytesOf(blob))),
    })

    expect([put1.status, hit.status, miss.status, conflict.status, refused.status]).toEqual([
      200, 200, 404, 409, 403,
    ])
    for (const [what, answer] of [
      ['a put', put1],
      ['a read', hit],
      ['a miss', miss],
      ['a lost race', conflict],
      ['a refused write', refused],
    ] as const) {
      expect(answer.bytes, `${what} answered a different length`).toBe(ESCROW_ANSWER_BYTES)
    }
  })

  it('has room for the largest thing either side can legally say', async () => {
    // `pad` computes how much to add, so a payload longer than the target would
    // ask for a negative number of characters and throw — at runtime, on a
    // household's save. The key and the signature made a put 139 bytes longer
    // than it was, which is why this is here and not a formality.
    const biggestBlob = btoa('\0'.repeat(ESCROW_BLOB_BYTES))
    const biggestRequest = {
      op: 'put',
      id: ID,
      version: 0xffffffff,
      blob: biggestBlob,
      pub: 'A'.repeat(43),
      sig: 'A'.repeat(86),
    }
    const biggestAnswer = { version: 0xffffffff, blob: biggestBlob }

    expect(JSON.stringify(biggestRequest).length).toBeLessThan(ESCROW_REQUEST_BYTES)
    expect(JSON.stringify(biggestAnswer).length).toBeLessThan(ESCROW_ANSWER_BYTES)
    expect(pad(biggestRequest, ESCROW_REQUEST_BYTES).length).toBe(ESCROW_REQUEST_BYTES)
    expect(pad(biggestAnswer, ESCROW_ANSWER_BYTES).length).toBe(ESCROW_ANSWER_BYTES)
  })

  it('does not pad what it refuses before the length gate', async () => {
    const s = start()

    const wrongPath = await s.fetch(`${s.origin}/e/${ID}`, { method: 'POST' })
    const wrongMethod = await s.fetch(`${s.origin}/e`, { method: 'GET' })

    expect((await wrongPath.text()).length).toBeLessThan(ESCROW_ANSWER_BYTES)
    expect((await wrongMethod.text()).length).toBeLessThan(ESCROW_ANSWER_BYTES)
    expect((await raw(s, '{}')).bytes).toBeLessThan(ESCROW_ANSWER_BYTES)
  })
})

describe('what it gives back', () => {
  it('hands the ciphertext back with the version it was written under', async () => {
    const s = start()
    await put(s, 1, 0x7f)

    const got = await call(s, { op: 'get', id: ID })

    expect(got.status).toBe(200)
    expect(got.json['version']).toBe(1)
    expect(atob(got.json['blob'] as string).length).toBe(ESCROW_BLOB_BYTES)
  })

  it('says nothing at all about an id it has never seen', async () => {
    const s = start()
    await put(s, 1, 0x01)

    const miss = await call(s, { op: 'get', id: OTHER })

    expect(miss.status).toBe(404)
    expect(Object.keys(miss.json)).toEqual(['pad'])
  })

  it('has no verb that removes a record', async () => {
    const s = start()
    await put(s, 1, 0x01)

    for (const op of ['delete', 'remove', 'drop', 'purge']) {
      expect((await call(s, { op, id: ID })).status, op).toBe(400)
    }
    expect(stored(s)).toEqual({ ver: 1, first: 0x01 })
  })

  it('names one origin and never a wildcard', async () => {
    const s = start()
    const response = await s.fetch(`${s.origin}/e`, { method: 'OPTIONS' })

    expect(response.headers.get('access-control-allow-origin')).toBe('https://app.ftw.energy')
    expect(response.headers.get('access-control-allow-origin')).not.toBe('*')
    expect(response.headers.get('cache-control')).toBe('no-store')
  })

  it('marks every answer no-store, including the ones with no body', async () => {
    const s = start()
    const miss = await s.fetch(`${s.origin}/e`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ op: 'get', id: ID }),
    })
    expect(miss.headers.get('cache-control')).toBe('no-store')
  })
})

describe('nothing beside it', () => {
  it('keeps layout.md and the numbers the code uses in step', () => {
    // Two spellings of a storage format drift, and the one an outsider reads is
    // never the one that ran. This is what schema.sql used to do for the table.
    const file = readFileSync(new URL('../layout.md', import.meta.url), 'utf8')
    const numbered = (n: number) => String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ' ')

    for (const [what, value] of [
      ['one record', RECORD_BYTES],
      ['one image', IMAGE_BYTES],
      ['one bucket', BUCKET_BYTES],
      ['ways', WAYS],
    ] as const) {
      expect(file, `layout.md does not carry the real ${what}`).toContain(numbered(value))
    }
    // And the fields, so a fifth one cannot be added without saying so here.
    // Read out of the table itself rather than out of the whole file, because
    // the prose below it has to be free to name the things that are not there.
    const table = file
      .slice(file.indexOf('## The numbers'), file.indexOf('## The five rules'))
      .split('\n')
      .filter((line) => line.startsWith('|'))
      .join('\n')
    for (const field of ['id', 'head', 'write key', 'blob', 'digest']) {
      expect(table, `layout.md has no row for the ${field}`).toContain(`| ${field}`)
    }
    for (const forbidden of ['created', 'updated', 'seen', 'time', 'stamp', 'address', 'agent']) {
      expect(table.toLowerCase(), `the layout has a field for ${forbidden}`).not.toContain(forbidden)
    }
  })

  it('is not deployed on a store that keeps its own history', async () => {
    // A check on the deployment and not on the code. A managed store that keeps
    // point-in-time history writes the timestamp for you, out of reach of any
    // schema, and hands it to whoever holds the account. D1's Time Travel is
    // always on and reaches back thirty days; every R2 object carries an
    // `uploaded` date; Durable Objects keep the same thirty days.
    //
    // Binding keys rather than product names, because README.md has to be free
    // to explain which stores were rejected and why. Test files are skipped for
    // the same reason: a check that fires on its own source teaches people to
    // delete it.
    const root = new URL('../', import.meta.url).pathname
    const files: string[] = []
    const walk = (dir: string) => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const full = join(dir, entry.name)
        if (entry.isDirectory()) walk(full)
        else if (!entry.name.endsWith('.test.ts')) files.push(full)
      }
    }
    walk(root)

    for (const binding of ['d1_databases', 'durable_objects', 'r2_buckets', 'kv_namespaces']) {
      for (const file of files) {
        expect(readFileSync(file, 'utf8'), `${file} binds ${binding}`).not.toContain(binding)
      }
    }
    expect(files.filter((f) => /wrangler\.(jsonc?|toml)$/.test(f))).toEqual([])
  })

  it('offers no way to ask what else is in there', async () => {
    // Not "declines to answer". There is no op that reads more than the one id
    // it was given, and the store the handler is handed has no verb for it.
    const s = start()
    await put(s, 1, 0x01)
    await put(s, 1, 0x11, OTHER)

    for (const op of ['list', 'all', 'scan', 'count', 'keys', '']) {
      expect((await call(s, { op, id: ID })).status, op).toBe(400)
    }
    const got = await call(s, { op: 'get', id: ID })
    expect(JSON.stringify(got.json)).not.toContain(OTHER)
  })
})
