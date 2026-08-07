// @vitest-environment node

/* The service as it actually runs, and what it writes down while it runs.
 *
 * Everywhere else the handler is called directly, which is the right shape for
 * asking what it will and will not do. It cannot answer the question this file
 * is for. "An opaque id and nothing beside it" is a claim about the whole
 * operation, and the usual way a service like this stops keeping it is not a
 * fifth field — it is a line of log with an id in it, in the least guarded file
 * on the host.
 *
 * So this starts the real server in a real process over a real socket, runs a
 * household's whole life through it, and fails if a single byte came out.
 */

import { describe, it, expect, afterEach } from 'vitest'
import { spawn, type ChildProcess } from 'node:child_process'
import { createServer } from 'node:net'
import { generateKeyPairSync, sign as signWith } from 'node:crypto'
import { chmodSync, mkdtempSync, readdirSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ESCROW_BLOB_BYTES, ESCROW_REQUEST_BYTES, pad } from './escrow.ts'
import { bytesFor, writeMessage } from './store.ts'

const ID = 'A'.repeat(43)

let child: ChildProcess | null = null
let dir = ''

afterEach(() => {
  child?.kill('SIGKILL')
  child = null
  if (dir) {
    try {
      chmodSync(dir, 0o755)
    } catch {
      // Already gone, or never changed.
    }
    rmSync(dir, { recursive: true, force: true })
  }
  dir = ''
})

/** A port nothing is on, asked for rather than guessed. */
function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = createServer()
    probe.on('error', reject)
    probe.listen(0, '127.0.0.1', () => {
      const address = probe.address()
      const port = typeof address === 'object' && address ? address.port : 0
      probe.close(() => resolve(port))
    })
  })
}

interface Running {
  origin: string
  /** The directory the file is in, for the test that takes the disk away. */
  dir: string
  path: string
  /** Every byte the process has written to stdout and stderr. */
  written(): string
}

async function start(households = 64): Promise<Running> {
  dir = mkdtempSync(join(tmpdir(), 'ftw-escrow-main-'))
  const port = await freePort()
  const path = join(dir, 'escrow.slots')

  child = spawn(process.execPath, [new URL('./main.ts', import.meta.url).pathname], {
    env: {
      ...process.env,
      ESCROW_DB: path,
      PORT: String(port),
      ESCROW_ORIGIN: 'https://app.ftw.energy',
      ESCROW_HOUSEHOLDS: String(households),
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  })

  let written = ''
  child.stdout?.on('data', (chunk: Buffer) => (written += chunk.toString()))
  child.stderr?.on('data', (chunk: Buffer) => (written += chunk.toString()))

  const origin = `http://127.0.0.1:${port}`
  const scratch = dir
  for (let attempt = 0; attempt < 100; attempt++) {
    try {
      if ((await fetch(`${origin}/healthz`)).ok) {
        return { origin, dir: scratch, path, written: () => written }
      }
    } catch {
      // Not listening yet.
    }
    await new Promise((resolve) => setTimeout(resolve, 50))
  }
  throw new Error(`the escrow never came up. It wrote: ${written || '(nothing)'}`)
}

const { publicKey, privateKey } = generateKeyPairSync('ed25519')
const PUB = Buffer.from((publicKey.export({ format: 'jwk' }) as { x: string }).x, 'base64url').toString(
  'base64url'
)

/** Padded to the one length the service takes, the way the app sends it. */
const call = (origin: string, body: Record<string, unknown>) =>
  fetch(`${origin}/e`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: pad(body, ESCROW_REQUEST_BYTES),
  })

function bytes(fill: number, length = ESCROW_BLOB_BYTES): Uint8Array {
  return new Uint8Array(length).fill(fill)
}

function blob(fill: number, length = ESCROW_BLOB_BYTES): string {
  let binary = ''
  for (const byte of bytes(fill, length)) binary += String.fromCharCode(byte)
  return btoa(binary)
}

/** A signed put, the way the app makes one. */
function save(version: number, fill: number, length = ESCROW_BLOB_BYTES, id = ID) {
  return {
    op: 'put',
    id,
    version,
    blob: blob(fill, length),
    pub: PUB,
    sig: signWith(null, writeMessage(id, version, bytes(fill, length)), privateKey).toString('base64url'),
  }
}

describe('the service as it runs', () => {
  it('serves a household its whole life and writes down not one line', async () => {
    const { origin, written } = await start()

    // Everything a household ever does, and everything a stranger might.
    expect((await call(origin, save(1, 1))).status).toBe(200)
    expect((await call(origin, { op: 'get', id: ID })).status).toBe(200)
    expect((await call(origin, save(1, 2))).status).toBe(409)
    expect((await call(origin, save(2, 0, 0))).status).toBe(200)
    expect((await call(origin, { op: 'get', id: 'B'.repeat(43) })).status).toBe(400)
    // The refusals, which are where a service is most tempted to explain itself.
    expect((await call(origin, { op: 'nonsense', id: ID })).status).toBe(400)
    expect((await call(origin, { op: 'get', id: 'short' })).status).toBe(400)
    expect((await fetch(`${origin}/e`, { method: 'GET' })).status).toBe(405)
    expect((await fetch(`${origin}/e/${ID}`, { method: 'POST' })).status).toBe(404)
    expect((await fetch(`${origin}/e`, { method: 'POST', body: 'x'.repeat(65536) })).status).toBe(400)
    // Including the one that is a stranger with the id and a key of their own,
    // which is the refusal a service would most like to be helpful about.
    const stranger = generateKeyPairSync('ed25519')
    expect(
      (
        await call(origin, {
          op: 'put',
          id: ID,
          version: 3,
          blob: blob(9),
          pub: Buffer.from((stranger.publicKey.export({ format: 'jwk' }) as { x: string }).x, 'base64url').toString(
            'base64url'
          ),
          sig: signWith(null, writeMessage(ID, 3, bytes(9)), stranger.privateKey).toString('base64url'),
        })
      ).status
    ).toBe(403)

    // Give anything asynchronous a moment to be written before looking.
    await new Promise((resolve) => setTimeout(resolve, 100))

    expect(written(), 'the escrow wrote something down').toBe('')
  })

  it('makes its file once, at the size it was asked for, and nothing beside it', async () => {
    // The file is preallocated, so its length is its capacity and nothing else.
    // Nothing else in the directory at all: a slot file needs no journal to
    // commit, no second copy of itself to compact and no lock.
    const { origin, dir: scratch, path } = await start(64)

    expect(statSync(path).size).toBe(bytesFor(64))
    expect((await call(origin, save(1, 1))).status).toBe(200)
    expect((await call(origin, save(2, 2))).status).toBe(200)

    expect(readdirSync(scratch)).toEqual(['escrow.slots'])
    expect(statSync(path).size, 'the file grew when a household wrote').toBe(bytesFor(64))
  })

  it('writes nothing down when the directory turns read-only under it either', async () => {
    // "Not for a request that failed" is the sentence at the top of main.ts, and
    // this used to be the way to make a real failure: SQLite needed to create a
    // journal beside the database to commit, so taking the directory's write
    // permission away failed a write for real.
    //
    // It no longer fails one, and that is the finding rather than a hole in the
    // test. There is no journal, no temporary copy and no new file of any kind
    // — every write goes to an already-open descriptor, and POSIX checks
    // permission when a file is opened rather than on every write. So a save
    // still lands, and the whole class of failure that came from needing to
    // create something beside the data is gone with the thing that needed it.
    const { origin, dir: scratch, written } = await start()

    expect((await call(origin, save(1, 1))).status).toBe(200)
    chmodSync(scratch, 0o555)

    expect((await call(origin, save(2, 2))).status, 'a save needed the directory').toBe(200)
    expect((await call(origin, { op: 'get', id: ID })).status).toBe(200)
    expect((await fetch(`${origin}/healthz`)).status).toBe(200)

    await new Promise((resolve) => setTimeout(resolve, 100))

    expect(written(), 'the escrow explained itself').toBe('')
  })

  it('says it is alive without being asked about any household', async () => {
    // A service that writes no log needs some other way to say the disk is
    // still there, and the health check is it. It touches the file, so
    // "listening" and "still has its file" are not the same answer — and it
    // carries no id, so the one path a household's request uses stays the only
    // path a household appears on.
    const { origin, written } = await start()

    const answer = await fetch(`${origin}/healthz`)

    expect(answer.status).toBe(200)
    expect(await answer.text()).toBe('ok')
    expect(written()).toBe('')
  })
})
