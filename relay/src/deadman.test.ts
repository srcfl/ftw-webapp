/* The switch, held to its own claims.
 *
 * Every test here is a sentence from README.md's claim table made
 * executable: what a row may contain, when a switch may fire, how often,
 * and what the file on disk is allowed to say.
 */

import { describe, it, expect } from 'vitest'
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Deadman, rowError, REFIRE_FLOOR_MS, MAX_CT_BYTES } from './deadman.ts'

const ID = 'a'.repeat(32)
const ROW = {
  id: ID,
  endpoint: 'https://push.example/send/abc',
  ct: Buffer.from('sealed at home').toString('base64'),
  deadline_s: 600,
  auth: 'vapid t=jwt, k=key',
}

function rig(startMs = 1_000_000) {
  let now = startMs
  const fired: { endpoint: string; body: Uint8Array; headers: Record<string, string> }[] = []
  const dm = new Deadman({
    path: '',
    now: () => now,
    post: async (endpoint, body, headers) => {
      fired.push({ endpoint, body, headers })
      return { status: 201 }
    },
  })
  return { dm, fired, advance: (ms: number) => (now += ms) }
}

describe('what a row may say', () => {
  it('accepts exactly the contract and refuses everything near it', () => {
    expect(rowError(ROW)).toBeNull()
    expect(rowError({ ...ROW, auth: undefined })).toBeNull()
    expect(rowError({ ...ROW, id: 'short' })).toMatch(/id/)
    expect(rowError({ ...ROW, id: ID.toUpperCase() })).toMatch(/id/)
    expect(rowError({ ...ROW, endpoint: 'http://push.example/x' })).toMatch(/https/)
    expect(rowError({ ...ROW, ct: '' })).toMatch(/ct/)
    expect(rowError({ ...ROW, deadline_s: 59 })).toMatch(/deadline/)
    expect(rowError({ ...ROW, deadline_s: 86_401 })).toMatch(/deadline/)
    expect(rowError({ ...ROW, deadline_s: 600.5 })).toMatch(/deadline/)
    expect(rowError({ ...ROW, auth: 'x'.repeat(600) })).toMatch(/auth/)
    expect(rowError('not an object')).toMatch(/object/)
  })

  it('refuses a ciphertext that could not be a push message', () => {
    const big = Buffer.alloc(MAX_CT_BYTES + 1).toString('base64')
    expect(rowError({ ...ROW, ct: big })).toBe('ct too large')
  })
})

describe('when a switch may fire', () => {
  it('holds while claimed, counts down after release, fires once with the sealed bytes', () => {
    const { dm, fired, advance } = rig()
    dm.put({ ...ROW })
    dm.claim(ID)

    // Claimed: no amount of waiting fires it.
    advance(3_600_000)
    dm.beat()
    expect(fired).toHaveLength(0)

    dm.release(ID)
    advance(599_000)
    dm.beat()
    expect(fired, 'fired before its deadline').toHaveLength(0)

    advance(2_000)
    dm.beat()
    expect(fired).toHaveLength(1)
    // Byte-identical to what the box sealed, headers per the contract,
    // the pre-signed authorisation verbatim.
    expect(Buffer.from(fired[0]!.body).toString()).toBe('sealed at home')
    expect(fired[0]!.headers['Content-Encoding']).toBe('aes128gcm')
    expect(fired[0]!.headers['TTL']).toBe('86400')
    expect(fired[0]!.headers['Authorization']).toBe(ROW.auth)

    // Once. The countdown does not restart on its own.
    advance(3_600_000)
    dm.beat()
    expect(fired).toHaveLength(1)
  })

  it('a reconnect cancels the countdown', () => {
    const { dm, fired, advance } = rig()
    dm.put({ ...ROW })
    dm.claim(ID)
    dm.release(ID)
    advance(300_000)
    dm.claim(ID)
    advance(3_600_000)
    dm.beat()
    expect(fired).toHaveLength(0)
  })

  it('a flapping box is one message, not a night of them', () => {
    const { dm, fired, advance } = rig()
    dm.put({ ...ROW })

    // Three full outages inside the half-hour floor.
    for (let i = 0; i < 3; i++) {
      dm.claim(ID)
      dm.release(ID)
      advance(601_000)
      dm.beat()
    }
    expect(fired).toHaveLength(1)

    // Past the floor, a real second outage speaks again.
    advance(REFIRE_FLOOR_MS)
    dm.claim(ID)
    dm.release(ID)
    advance(601_000)
    dm.beat()
    expect(fired).toHaveLength(2)
  })

  it('an unclaimed unknown id can never fire — there is nothing to fire', () => {
    const { dm, fired, advance } = rig()
    dm.claim('b'.repeat(32))
    dm.release('b'.repeat(32))
    advance(86_400_000)
    dm.beat()
    expect(fired).toHaveLength(0)
  })

  it('a withdrawn row is gone even mid-countdown', () => {
    const { dm, fired, advance } = rig()
    dm.put({ ...ROW })
    dm.claim(ID)
    dm.release(ID)
    dm.remove(ID)
    advance(3_600_000)
    dm.beat()
    expect(fired).toHaveLength(0)
  })

  it('drops the row when the push service says the subscription is gone', async () => {
    let now = 1_000_000
    const dm = new Deadman({
      path: '',
      now: () => now,
      post: async () => ({ status: 410 }),
    })
    dm.put({ ...ROW })
    dm.claim(ID)
    dm.release(ID)
    now += 601_000
    dm.beat()
    await new Promise((r) => setTimeout(r, 0))
    expect(dm.inspect().rows).toBe(0)
  })
})

describe('what the file on disk is allowed to say', () => {
  it('persists the contract fields and nothing derived from traffic', () => {
    const path = join(mkdtempSync(join(tmpdir(), 'deadman-')), 'rows.json')
    const dm = new Deadman({ path, now: () => 1_000_000 })
    dm.put({ ...ROW })

    const rows = JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>[]
    expect(rows).toHaveLength(1)
    // The whole allowance. A sixth traffic-derived field here is the drift
    // the README's claim table exists to prevent.
    expect(Object.keys(rows[0]!).sort()).toEqual(['auth', 'ct', 'deadlineS', 'endpoint', 'id'])
  })

  it('re-arms surviving rows with a full fresh deadline after a restart', () => {
    const path = join(mkdtempSync(join(tmpdir(), 'deadman-')), 'rows.json')
    let now = 1_000_000
    const first = new Deadman({ path, now: () => now })
    first.put({ ...ROW })

    const fired: string[] = []
    const second = new Deadman({
      path,
      now: () => now,
      post: async (endpoint) => {
        fired.push(endpoint)
        return { status: 201 }
      },
    })
    // A healthy box has the whole deadline to come back...
    now += 599_000
    second.beat()
    expect(fired).toHaveLength(0)
    // ...and a dead one still gets its message out.
    now += 2_000
    second.beat()
    expect(fired).toHaveLength(1)
  })
})
