/* Run the escrow.
 *
 *   ESCROW_DB=/srv/escrow/data/escrow.slots node escrow/src/main.ts
 *
 * Four environment variables and no configuration file: where the file is,
 * which port to answer on, the one origin a browser may call it from, and how
 * many households the file is made for the first time it is made. Everything
 * else is a constant beside the code it governs.
 *
 * ONCE IT IS SERVING IT WRITES NOTHING, AND THAT IS THE POINT OF THIS FILE.
 *
 * Not one line to stdout, not one to stderr, not for a request and not for a
 * request that failed. The three columns are the only thing this service is
 * allowed to remember, and a log line is the usual way that stops being true —
 * an id beside a time in the least guarded file on the host would be the
 * household activity record the schema goes to such lengths to refuse. A test
 * starts this server for real, runs a whole write-read-clear through it and
 * fails if a single byte came out. A second one takes the write permission off
 * the directory so a commit really fails, and holds it to the same silence
 * through the 500 below — because "not for a request that failed" is the half
 * of the sentence that is easy to write and easy not to mean.
 *
 * The exception, named rather than left for someone to find: a process that
 * cannot start at all — no port, no disk — dies with Node's own stack trace on
 * stderr. That is right, it carries nothing about any household, and it is why
 * the sentence above says "once it is serving".
 *
 * So the way to tell it is alive is the health check below and not a log. It
 * touches the database rather than only the socket, because "listening" and
 * "the disk is still there" are different questions and a silent service must
 * answer the second one somewhere.
 */

import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { statSync } from 'node:fs'
import { DEFAULT_ORIGIN, ESCROW_REQUEST_BYTES, handle } from './escrow.ts'
import { DEFAULT_HOUSEHOLDS, openSlotStore } from './store.ts'

const path = process.env['ESCROW_DB'] ?? '/srv/escrow/data/escrow.slots'
const port = Number(process.env['PORT'] ?? 8788)
/** Overridden in development only. One origin, never a list. */
const origin = process.env['ESCROW_ORIGIN'] ?? DEFAULT_ORIGIN
/**
 * Read once, when the file is made, and ignored for the rest of its life.
 *
 * The capacity is the file's length and cannot be changed by asking: growing it
 * is grow.ts, with the service stopped. Setting this on a host whose file
 * already exists does nothing at all, which is the behaviour that stops it
 * being mistaken for a live setting.
 */
const households = Number(process.env['ESCROW_HOUSEHOLDS'] ?? DEFAULT_HOUSEHOLDS)

/**
 * One process, and that is a requirement rather than a deployment detail.
 *
 * The rollback guard used to rest on SQLite's atomicity for one statement. It
 * rests now on the store doing its whole read-decide-write synchronously, which
 * settles two devices racing inside one process and settles nothing at all
 * between two. deploy/compose.yml runs one container and deploy/README.md says
 * why it must never be scaled to two.
 */
const store = openSlotStore(path, { households })

const server = createServer((req, res) => {
  void serve(req, res).catch(() => {
    // Nothing is written down and nothing is told apart. A failure here is a
    // failure of the disk, and the health check is what reports it.
    res.writeHead(500, { 'cache-control': 'no-store' }).end()
  })
})

async function serve(req: IncomingMessage, res: ServerResponse): Promise<void> {
  // Liveness, and it is not part of the wire. `handle` answers one path for
  // every household; this sits in front of it so that stays true.
  //
  // Two questions, because a service that writes no logs has to answer both
  // here or not at all: is the disk still there, and is the copy a write
  // replaces still being wiped. The second is a privacy property rather than an
  // availability one — a store that has stopped wiping serves every household
  // perfectly while its file keeps a copy somebody has taken away — and this is
  // the only place it can be seen. It says `ok` or nothing, never which
  // household or when.
  if (req.url === '/healthz') {
    statSync(path)
    const status = store.tidy() ? 200 : 500
    res
      .writeHead(status, { 'content-type': 'text/plain', 'cache-control': 'no-store' })
      .end(status === 200 ? 'ok' : 'untidy')
    return
  }

  const body = await read(req)
  if (body === null) {
    // The same 400 every other illegal request gets, and then the socket goes.
    // Answering rather than resetting keeps one refusal for everything, so a
    // client learns nothing from which way it was turned away.
    res
      .writeHead(400, { 'cache-control': 'no-store', connection: 'close' })
      .end(() => req.destroy())
    return
  }

  const answer = await handle(
    new Request(`http://escrow.invalid${req.url ?? '/'}`, {
      method: req.method ?? 'GET',
      headers: headersOf(req),
      ...(body.length > 0 ? { body } : {}),
    }),
    store,
    origin
  )

  res.writeHead(answer.status, Object.fromEntries(answer.headers))
  res.end(Buffer.from(await answer.arrayBuffer()))
}

/** The body, or null once it is past the one length the handler accepts. */
function read(req: IncomingMessage): Promise<Buffer | null> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = []
    let size = 0
    req.on('data', (chunk: Buffer) => {
      size += chunk.length
      if (size > ESCROW_REQUEST_BYTES) {
        // Stop reading, but stay open long enough to answer. The caller closes.
        req.pause()
        resolve(null)
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => resolve(Buffer.concat(chunks)))
    req.on('error', () => resolve(null))
  })
}

/**
 * The two headers the handler reads, and no others.
 *
 * Copying the request's headers wholesale would be one line shorter and would
 * hand `handle` a cookie, an authorisation header and a user agent it has no
 * use for. This service is built so that identifying things do not arrive; not
 * forwarding them is the same habit one layer down.
 */
function headersOf(req: IncomingMessage): Headers {
  const headers = new Headers()
  for (const name of ['content-length', 'content-type']) {
    const value = req.headers[name]
    if (typeof value === 'string') headers.set(name, value)
  }
  return headers
}

// Everything in the container, which is published on loopback only — see
// deploy/compose.yml. Caddy is the one thing that may reach it.
server.listen(port, '0.0.0.0')

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    server.close(() => {
      store.close()
      process.exit(0)
    })
  })
}
