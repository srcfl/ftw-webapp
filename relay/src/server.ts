/* The blind relay.
 *
 * It joins one box uplink to a handful of browser streams under a rendezvous
 * handle and moves bytes between them. That is the whole job, and the file is
 * short on purpose: an operator's promise that a service cannot read your data
 * is worth what an outsider can check in an afternoon.
 *
 * What it never does, and where you can see that it never does:
 *
 *   It does not decrypt. It has no keys and no code that would take one.
 *   It does not parse payloads. Binary messages are forwarded as received;
 *     the only property read off them is `.length`, for a memory bound.
 *   It does not derive handles. That needs the secret the box and the app
 *     swapped optically, which never comes near here. See relay/README.md.
 *   It does not pad or trim. Bytes out are byte-identical to bytes in, so
 *     lane 0's fixed frame size survives the trip.
 *   It does not compress. permessage-deflate is refused below, because a
 *     compressed frame's size depends on its content, which would undo the
 *     padding that keeps the household's load pattern off the wire.
 *   It does not store. Rooms live in memory and are deleted when the last
 *     socket leaves, so the relay cannot answer "which boxes exist" — not as
 *     policy, but because the answer is not anywhere.
 *   It does not write down who was here. The log carries counts only.
 *
 * Its clock is the one thing peers do trust it for: it announces the epoch,
 * everyone derives that epoch's handle, and rotation costs a reconnect.
 */

import { WebSocketServer, type WebSocket, type RawData } from 'ws'
import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
  type Server as HttpServer,
} from 'node:http'
import { currentEpoch } from './epoch.ts'
import { Deadman, rowError } from './deadman.ts'
import { AttemptCounter, TokenBucket } from './limits.ts'
import {
  CLOSE_BAD_JOIN,
  CLOSE_EPOCH,
  CLOSE_ROTATED,
  CLOSE_BUSY,
  CTRL_READY,
  CTRL_GONE,
  HANDLE_CHARS,
} from './protocol.ts'

export interface RelayOptions {
  port?: number
  host?: string
  /** Browser streams per handle. The uplink is separate and always singular. */
  maxStreamsPerHandle?: number
  /** Whole-process ceiling, so one flood cannot exhaust memory. */
  maxSockets?: number
  /** Memory bound, not a protocol claim — the relay has no idea what a lane is. */
  maxFrameBytes?: number
  /** Also the reap interval and the rotation check. One timer, fixed cadence. */
  heartbeatMs?: number
  /** Aggregate counts only. Never a handle, never a byte of payload. */
  log?: (line: string) => void
  now?: () => number
  /**
   * Outbound bytes allowed to queue for one peer before it is dropped.
   *
   * A socket the kernel has stopped draining — a phone that went through a
   * tunnel, a deliberately silent reader — otherwise accumulates every frame
   * the box sends, in the relay's heap, until the process dies. The peer's own
   * carrier reconnects, so dropping it costs a reconnection and nothing else.
   */
  maxBufferedBytes?: number
  /** Attempts allowed per address per window. */
  attemptLimit?: number
  attemptWindowMs?: number
  /** Concurrent sockets allowed from one address. */
  maxSocketsPerAddress?: number
  /**
   * Read X-Forwarded-For for rate limiting.
   *
   * Only true when something trusted terminates TLS in front, because
   * otherwise the header is a value the client chooses.
   */
  trustProxy?: boolean
  /** How long an epoch rotation is spread over. Five minutes by default. */
  rotateSpreadMs?: number
  /**
   * Where the dead man's switch rows live. Empty disables the switch and
   * with it the relay's only persisted state — see relay/README.md's claim
   * table before judging that trade.
   */
  deadmanPath?: string
  /** Test seam: how a fired switch posts. Production uses fetch. */
  deadmanPost?: (
    endpoint: string,
    body: Uint8Array,
    headers: Record<string, string>
  ) => Promise<{ status: number }>
}

export interface RoomInspection {
  handle: string
  hasUplink: boolean
  streams: number
}

export interface RelayInspection {
  epoch: number
  sockets: number
  rooms: RoomInspection[]
  framesRouted: number
  bytesRouted: number
  heartbeats: number
  /** Counts only. The rows themselves never appear on any surface. */
  deadman: { rows: number; claimed: number; armed: number }
}

type Role = 'box' | 'app'

interface Peer {
  socket: WebSocket
  role: Role
  frames: TokenBucket
  bytes: TokenBucket
  alive: boolean
  /** Whether this peer has been told the other side is present. */
  linked: boolean
  /** Kept only to decrement the per-address count on close. */
  address?: string
  /** Dead-man ids this socket spoke for. Released together on close. */
  claims?: Set<string>
}

interface Room {
  uplink: Peer | null
  streams: Set<Peer>
  /**
   * The epoch this room's handle belongs to.
   *
   * Rotation may only evict a room from an *earlier* epoch. Without this the
   * sweep walks every room in the map, including ones that joined seconds ago
   * on the current epoch with a perfectly good handle, and kicks them the
   * moment their offset passes — again on the next tick, and the next, for the
   * whole five-minute window. Which is both an outage and the correlation
   * signal rotation exists to deny: a room that vanishes and reappears on the
   * same handle is a room an observer can follow.
   */
  epoch: number
}

const DEFAULTS = {
  maxStreamsPerHandle: 4,
  maxSockets: 4096,
  maxFrameBytes: 65536,
  heartbeatMs: 15_000,
  /** Enough for a bulk history burst; far under what a flood needs. */
  frameCapacity: 240,
  framesPerSecond: 60,
  byteCapacity: 4 << 20,
  bytesPerSecond: 512 << 10,
  attemptLimit: 30,
  attemptWindowMs: 60_000,
  /** Two bulk bursts' worth. Past this the reader is not reading. */
  maxBufferedBytes: 8 << 20,
  /** Concurrent sockets from one address. A household needs a handful. */
  maxSocketsPerAddress: 16,
  trustProxy: false,
  rotateSpreadMs: 300_000,
} as const

/**
 * Where in the rotation window this room's turn falls.
 *
 * Derived from the handle so it needs no state and no timer, and so two rooms
 * do not have to coordinate to end up in different places. The handle is
 * already uniformly distributed, so its first bytes are as good a spread as
 * anything.
 */
export function rotationOffsetMs(handle: string, spreadMs: number): number {
  const bucket = parseInt(handle.slice(0, 4), 16)
  return Math.floor((bucket / 0x10000) * spreadMs)
}

/**
 * The client's address, for rate limiting only.
 *
 * Never stored — hashed into a counter that is thrown away every window. But
 * behind a TLS terminator `socket.remoteAddress` is the proxy for every client
 * in the world, so the whole fleet shares one limit and ordinary reconnection
 * load takes the service down. Reading the forwarded header is the only way
 * the limiter works at all in the deployment its own README describes.
 *
 * Off unless `trustProxy` is set: a forwarded header from an untrusted peer is
 * a value the client chooses, which would let anyone spread themselves across
 * the whole counter array.
 */
export function clientAddress(req: IncomingMessage, trustProxy: boolean): string {
  if (!trustProxy) return req.socket.remoteAddress ?? ''

  // The LAST entry, not the first. Every hop appends, so the tail is what the
  // nearest trusted proxy wrote and the head is whatever the client sent —
  // which a client that sends its own X-Forwarded-For chooses freely, spreading
  // itself across the whole counter array. Our Caddy replaces the header
  // outright, so today there is exactly one entry either way; reading the tail
  // is what keeps that a configuration detail rather than a load-bearing one.
  const forwarded = req.headers['x-forwarded-for']
  const chain = Array.isArray(forwarded) ? forwarded.join(',') : forwarded
  const client = chain?.split(',').at(-1)?.trim()
  return client && client.length > 0 ? client : (req.socket.remoteAddress ?? '')
}

export class RelayServer {
  #wss: WebSocketServer
  #http: HttpServer
  #rooms = new Map<string, Room>()
  #attempts: AttemptCounter
  #timer: ReturnType<typeof setInterval>
  #opts: Required<Omit<RelayOptions, 'port' | 'host' | 'deadmanPath' | 'deadmanPost'>>
  #epoch: number
  #rotateStartedAtMs: number | null = null
  #sockets = 0
  /** Concurrent sockets per address, so one client cannot fill the relay. */
  #perAddress = new Map<string, number>()
  #framesRouted = 0
  #bytesRouted = 0
  #heartbeats = 0
  #deadman: Deadman

  private constructor(wss: WebSocketServer, opts: RelayOptions, http: HttpServer) {
    this.#wss = wss
    this.#http = http
    this.#opts = {
      maxStreamsPerHandle: opts.maxStreamsPerHandle ?? DEFAULTS.maxStreamsPerHandle,
      maxSockets: opts.maxSockets ?? DEFAULTS.maxSockets,
      maxFrameBytes: opts.maxFrameBytes ?? DEFAULTS.maxFrameBytes,
      heartbeatMs: opts.heartbeatMs ?? DEFAULTS.heartbeatMs,
      log: opts.log ?? (() => {}),
      now: opts.now ?? (() => Date.now()),
      attemptLimit: opts.attemptLimit ?? DEFAULTS.attemptLimit,
      attemptWindowMs: opts.attemptWindowMs ?? DEFAULTS.attemptWindowMs,
      trustProxy: opts.trustProxy ?? DEFAULTS.trustProxy,
      rotateSpreadMs: opts.rotateSpreadMs ?? DEFAULTS.rotateSpreadMs,
      maxBufferedBytes: opts.maxBufferedBytes ?? DEFAULTS.maxBufferedBytes,
      maxSocketsPerAddress: opts.maxSocketsPerAddress ?? DEFAULTS.maxSocketsPerAddress,
    }

    const now = this.#opts.now()
    this.#epoch = currentEpoch(now)
    this.#attempts = new AttemptCounter(
      { limit: this.#opts.attemptLimit, windowMs: this.#opts.attemptWindowMs },
      now
    )
    this.#deadman = new Deadman({
      path: opts.deadmanPath ?? '',
      now: this.#opts.now,
      log: this.#opts.log,
      ...(opts.deadmanPost ? { post: opts.deadmanPost } : {}),
    })

    this.#wss.on('connection', (socket, req) => this.#onConnection(socket, req))

    // One timer drives the heartbeat, the reaping and the rotation check, so
    // the relay's own emissions have a cadence that traffic cannot influence.
    this.#timer = setInterval(() => this.#beat(), this.#opts.heartbeatMs)
    this.#timer.unref?.()
  }

  static start(opts: RelayOptions = {}): Promise<RelayServer> {
    // An HTTP server of our own, so /healthz can be answered without
    // upgrading. Without it every request gets 426 and a supervisor cannot
    // tell "listening" from "alive" — which is the difference between a
    // restart that fixes something and one that loops.
    //
    // The answer is deliberately empty. Room counts or handles here would
    // hand an observer the household identifier the whole design exists to
    // withhold, and a health check is exactly the endpoint nobody guards.
    // Bound after the instance exists; the callback below outlives this
    // function, so the reference heals itself the moment start() resolves.
    let deadmanRoutes: ((req: IncomingMessage, res: ServerResponse) => boolean) | null = null

    const http = createServer((req, res) => {
      if (req.method === 'GET' && (req.url === '/healthz' || req.url === '/healthz/')) {
        res.writeHead(200, { 'content-type': 'text/plain', 'cache-control': 'no-store' })
        res.end('ok\n')
        return
      }
      if (deadmanRoutes?.(req, res)) return
      res.writeHead(426, { 'content-type': 'text/plain' })
      res.end('upgrade required\n')
    })

    const wss = new WebSocketServer({
      server: http,
      // A compressed frame's length depends on its content. Turning this on
      // would leak through padding that exists precisely to stop that.
      perMessageDeflate: false,
      maxPayload: opts.maxFrameBytes ?? DEFAULTS.maxFrameBytes,
    })

    return new Promise((resolve, reject) => {
      http.once('error', reject)
      http.listen(opts.port ?? 0, opts.host ?? '127.0.0.1', () => {
        http.off('error', reject)

        // Something has to stay attached. An 'error' with no listener is an
        // unhandled 'error' event, which takes the process down — so a
        // transient fault after startup would kill a relay that could have
        // carried on. Logged and survived instead; the supervisor restarts it
        // if it turns out to be fatal.
        const log = opts.log ?? ((line: string) => console.log(line))
        wss.on('error', (err) => log(`relay: websocket error after start: ${String(err)}`))
        http.on('error', (err) => log(`relay: http error after start: ${String(err)}`))

        const relay = new RelayServer(wss, opts, http)
        deadmanRoutes = (req, res) => relay.#serveDeadman(req, res)
        resolve(relay)
      })
    })
  }

  /** Base URL peers connect to. Paths are appended by the carrier. */
  get url(): string {
    const address = this.#http.address()
    if (typeof address === 'string' || address === null) {
      throw new Error('relay is not listening on a port')
    }
    const host = address.family === 'IPv6' ? `[${address.address}]` : address.address
    return `ws://${host}:${address.port}`
  }

  get epoch(): number {
    return this.#epoch
  }

  /**
   * Everything the relay holds, in one object.
   *
   * This is the audit surface: if a fact about a household were retained
   * anywhere, it would have to show up here. tests/relay-blindness.test.ts
   * fails on anything recognisable in it.
   */
  inspect(): RelayInspection {
    return {
      epoch: this.#epoch,
      sockets: this.#sockets,
      rooms: [...this.#rooms].map(([handle, room]) => ({
        handle,
        hasUplink: room.uplink !== null,
        streams: room.streams.size,
      })),
      framesRouted: this.#framesRouted,
      bytesRouted: this.#bytesRouted,
      heartbeats: this.#heartbeats,
      deadman: this.#deadman.inspect(),
    }
  }

  stop(): Promise<void> {
    clearInterval(this.#timer)
    for (const socket of this.#wss.clients) socket.terminate()
    this.#rooms.clear()
    // Both, and the HTTP server last: it owns the listening socket now, so
    // closing only the WebSocket server would leave the port held.
    return new Promise((resolve) => {
      this.#wss.close(() => this.#http.close(() => resolve()))
    })
  }

  #onConnection(socket: WebSocket, req: IncomingMessage): void {
    const now = this.#opts.now()

    // First, before any validation can return.
    //
    // Every rejection below closes the socket, and a socket that errors with
    // no 'error' listener attached makes Node throw the event as an uncaught
    // exception — which kills the process. So a peer that sends a malformed
    // frame and is rejected takes the whole relay down with it, and it takes
    // no credential and no valid handle to do. Attaching here means the
    // listener exists before any path that can reject.
    socket.on('error', () => socket.terminate())

    if (this.#sockets >= this.#opts.maxSockets) {
      socket.close(CLOSE_BUSY, 'full')
      return
    }
    if (!this.#attempts.allow(clientAddress(req, this.#opts.trustProxy), now)) {
      socket.close(CLOSE_BUSY, 'slow down')
      return
    }

    const join = parseJoin(req.url ?? '')
    if (!join) {
      socket.close(CLOSE_BAD_JOIN, 'join')
      return
    }
    // Exact, not tolerant.
    //
    // A window here looks kinder and is not: both peers derive the handle from
    // the epoch, so a client left on the wrong one derives a handle its box
    // never registers and waits forever in an empty room. Saying "wrong epoch"
    // is what gets the two of them to the same string. The client clamps how
    // far it will be moved, so this cannot be used to steer it.
    if (join.epoch !== this.#epoch) {
      // The peer guessed from its own clock. Hand back the right number so it
      // can derive this epoch's handle and come straight back.
      socket.close(CLOSE_EPOCH, String(this.#epoch))
      return
    }

    const address = clientAddress(req, this.#opts.trustProxy)
    if ((this.#perAddress.get(address) ?? 0) >= this.#opts.maxSocketsPerAddress) {
      // The attempt limiter bounds how fast one address may connect; this
      // bounds how many it may hold open at once. Without it a single client
      // reaches maxSockets on its own and every household is refused.
      socket.close(CLOSE_BUSY, 'full')
      return
    }

    const room =
      this.#rooms.get(join.handle) ?? { uplink: null, streams: new Set<Peer>(), epoch: join.epoch }

    if (join.role === 'box' && room.uplink) {
      // The incumbent uplink keeps the room. A box whose socket died silently
      // behind a NAT is reaped by the heartbeat within two beats and can
      // rejoin then; letting a newcomer evict it would make that a way to cut
      // a household off.
      socket.close(CLOSE_BUSY, 'uplink')
      return
    }
    if (join.role === 'app' && room.streams.size >= this.#opts.maxStreamsPerHandle) {
      socket.close(CLOSE_BUSY, 'streams')
      return
    }

    const peer: Peer = {
      socket,
      role: join.role,
      frames: new TokenBucket(DEFAULTS.frameCapacity, DEFAULTS.framesPerSecond, now),
      bytes: new TokenBucket(DEFAULTS.byteCapacity, DEFAULTS.bytesPerSecond, now),
      alive: true,
      linked: false,
    }

    if (join.role === 'box') room.uplink = peer
    else room.streams.add(peer)
    this.#rooms.set(join.handle, room)
    this.#sockets += 1
    this.#perAddress.set(address, (this.#perAddress.get(address) ?? 0) + 1)
    peer.address = address

    socket.on('pong', () => {
      peer.alive = true
    })
    socket.on('message', (data, isBinary) => this.#onMessage(peer, room, data, isBinary))
    socket.on('close', () => this.#onClose(join.handle, room, peer))

    this.#sync(room)
  }

  #onMessage(peer: Peer, room: Room, data: RawData, isBinary: boolean): void {
    if (!isBinary) {
      // Peers have almost nothing to say to the relay. The one exception is
      // the uplink's dead-man claim — one word and an opaque id — which
      // never enters the routing path: it is consumed here, whole, and no
      // byte of it reaches any other peer. Everything else stays refused,
      // which is what keeps the routing path free of interpretation.
      if (peer.role === 'box') {
        const text = data.toString()
        if (/^deadman [0-9a-f]{32}$/.test(text)) {
          const id = text.slice('deadman '.length)
          ;(peer.claims ??= new Set()).add(id)
          this.#deadman.claim(id)
          return
        }
      }
      peer.socket.close(CLOSE_BAD_JOIN, 'binary only')
      return
    }

    const frame = data as Buffer
    if (frame.length > this.#opts.maxFrameBytes) {
      peer.socket.close(CLOSE_BAD_JOIN, 'oversize')
      return
    }

    const now = this.#opts.now()
    if (!peer.frames.take(1, now) || !peer.bytes.take(frame.length, now)) {
      // Dropping quietly would leave a hole in an ordered stream, which the
      // session above would have to recover from anyway. Closing is honest and
      // the carrier reconnects on its own.
      peer.socket.close(CLOSE_BUSY, 'rate')
      return
    }

    this.#framesRouted += 1
    this.#bytesRouted += frame.length

    // The routing table in full. Streams never reach each other; the uplink
    // reaches all of them, because it cannot be told apart which stream a
    // ciphertext belongs to without reading it, and reading it is the one
    // thing this service must not do.
    const cap = this.#opts.maxBufferedBytes
    if (peer.role === 'box') {
      for (const stream of room.streams) send(stream, frame, cap)
    } else if (room.uplink) {
      send(room.uplink, frame, cap)
    }
  }

  #onClose(handle: string, room: Room, peer: Peer): void {
    this.#sockets -= 1
    if (peer.claims) {
      // The countdown starts at the moment nobody is holding the switch.
      for (const id of peer.claims) this.#deadman.release(id)
      delete peer.claims
    }
    if (peer.address !== undefined) {
      const left = (this.#perAddress.get(peer.address) ?? 1) - 1
      if (left > 0) this.#perAddress.set(peer.address, left)
      else this.#perAddress.delete(peer.address)
    }
    if (room.uplink === peer) room.uplink = null
    else room.streams.delete(peer)

    if (!room.uplink && room.streams.size === 0) {
      // The room and its handle go with the last socket. This is what makes
      // "which boxes exist" unanswerable rather than merely unanswered.
      this.#rooms.delete(handle)
      return
    }
    this.#sync(room)
  }

  /** Tell each side whether the other is there. The only words the relay says. */
  #sync(room: Room): void {
    const notify = (peer: Peer, present: boolean) => {
      if (peer.linked === present || peer.socket.readyState !== 1) return
      peer.linked = present
      peer.socket.send(present ? CTRL_READY : CTRL_GONE)
    }

    if (room.uplink) notify(room.uplink, room.streams.size > 0)
    for (const stream of room.streams) notify(stream, room.uplink !== null)
  }

  #beat(): void {
    this.#deadman.beat()
    for (const room of this.#rooms.values()) {
      for (const peer of peers(room)) {
        if (!peer.alive) {
          // Missed the previous beat. This is what lets a box reconnect after
          // a NAT dropped its socket without either end noticing.
          peer.socket.terminate()
          continue
        }
        peer.alive = false
        peer.socket.ping()
        this.#heartbeats += 1
      }
    }

    // Rotation is spread, not simultaneous.
    //
    // Both peers derive the handle from the epoch, so when it advances they
    // genuinely both have to reconnect — a room cannot straddle the boundary,
    // because handle(secret, N) and handle(secret, N-1) are unrelated strings
    // and the relay has no way to know they belong together. That is the
    // design working.
    //
    // What was wrong was doing it to everyone at once. Every peer came back
    // inside the client's three-second jitter, and a limiter that sees one
    // address behind a TLS terminator rejected all but the first few — for a
    // window, then longer as backoff compounded. A self-inflicted outage every
    // hour, on the hour.
    //
    // It leaked, too: a relay watching every handle vanish together and a
    // fresh set appear seconds later can line the two up by timing alone,
    // which is the correlation rotation exists to prevent.
    //
    // So each room gets a deterministic offset from its own handle, spread
    // across the rotation window. No timer per room, no thundering herd, and
    // nothing for an observer to pair up.
    const nowMs = this.#opts.now()
    const epoch = currentEpoch(nowMs)
    if (epoch !== this.#epoch) {
      this.#epoch = epoch
      this.#rotateStartedAtMs = nowMs
    }

    if (this.#rotateStartedAtMs !== null) {
      const elapsed = nowMs - this.#rotateStartedAtMs
      for (const [handle, room] of this.#rooms) {
        // Only rooms still on the old handle. A room that joined during the
        // window already derived this epoch's handle and has nothing to
        // rotate to; evicting it would kick a healthy peer, and kick it again
        // every tick until the window closed — while handing an observer the
        // vanish-and-return pattern that identifies a household.
        if (room.epoch === this.#epoch) continue
        if (elapsed < rotationOffsetMs(handle, this.#opts.rotateSpreadMs)) continue
        for (const peer of peers(room)) peer.socket.close(CLOSE_ROTATED, String(this.#epoch))
        this.#rooms.delete(handle)
      }
      if (elapsed >= this.#opts.rotateSpreadMs) this.#rotateStartedAtMs = null
    }

    this.#opts.log(
      `epoch=${this.#epoch} rooms=${this.#rooms.size} sockets=${this.#sockets} ` +
        `frames=${this.#framesRouted} bytes=${this.#bytesRouted}`
    )
  }

  /**
   * The dead man rows' own door: POST upserts, DELETE withdraws.
   *
   * Plain HTTP beside /healthz rather than words on the socket, so the
   * routing path stays uninterpreted and the row — the one thing here with
   * a body — never shares a channel with room traffic. The id is the
   * bearer capability: 128 bits the box derived from a secret this service
   * never sees, so guessing one is guessing the secret's HMAC.
   */
  #serveDeadman(req: IncomingMessage, res: ServerResponse): boolean {
    const url = req.url ?? ''
    if (req.method === 'POST' && (url === '/deadman' || url === '/deadman/')) {
      collectBody(req, 16_384)
        .then((body) => {
          let parsed: unknown
          try {
            parsed = JSON.parse(body.toString('utf8'))
          } catch {
            res.writeHead(400, { 'content-type': 'application/json' })
            res.end('{"error":"a JSON object"}')
            return
          }
          const fault = rowError(parsed)
          if (fault) {
            res.writeHead(fault === 'ct too large' ? 413 : 400, {
              'content-type': 'application/json',
            })
            res.end(JSON.stringify({ error: fault }))
            return
          }
          this.#deadman.put(parsed as Record<string, unknown>)
          res.writeHead(204)
          res.end()
        })
        .catch(() => {
          res.writeHead(413, { 'content-type': 'application/json' })
          res.end('{"error":"too large"}')
        })
      return true
    }

    const withdraw = url.match(/^\/deadman\/([0-9a-f]{32})$/)
    if (req.method === 'DELETE' && withdraw) {
      this.#deadman.remove(withdraw[1]!)
      res.writeHead(204)
      res.end()
      return true
    }

    return false
  }
}

/** Read a request body, bounded. Rejects past the cap instead of buffering. */
function collectBody(req: IncomingMessage, maxBytes: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    let size = 0
    req.on('data', (chunk: Buffer) => {
      size += chunk.length
      if (size > maxBytes) {
        req.destroy()
        reject(new Error('too large'))
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => resolve(Buffer.concat(chunks)))
    req.on('error', reject)
  })
}

function peers(room: Room): Peer[] {
  return room.uplink ? [room.uplink, ...room.streams] : [...room.streams]
}

function send(peer: Peer, frame: Buffer, maxBufferedBytes: number): void {
  if (peer.socket.readyState !== 1) return
  if (peer.socket.bufferedAmount > maxBufferedBytes) {
    // The peer has stopped reading. Queueing more only grows the relay's heap
    // on behalf of a socket that is not coming back on its own; its carrier
    // reconnects, so this costs a reconnection and saves the process.
    peer.socket.close(CLOSE_BUSY, 'slow reader')
    return
  }
  peer.socket.send(frame, { binary: true })
}

interface Join {
  epoch: number
  handle: string
  role: Role
}

/** `/r/<epoch>/<handle>/<role>` and nothing else. */
export function parseJoin(url: string): Join | null {
  const path = url.split('?')[0] ?? ''
  const parts = path.split('/').filter((p) => p.length > 0)
  if (parts.length !== 4 || parts[0] !== 'r') return null

  const epoch = Number(parts[1])
  if (!Number.isSafeInteger(epoch) || epoch < 0) return null

  const handle = parts[2]!
  if (handle.length !== HANDLE_CHARS || !/^[0-9a-f]+$/.test(handle)) return null

  const role = parts[3]
  if (role !== 'box' && role !== 'app') return null

  return { epoch, handle, role }
}
