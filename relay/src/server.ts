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
import type { IncomingMessage } from 'node:http'
import { currentEpoch } from './epoch.ts'
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
}

interface Room {
  uplink: Peer | null
  streams: Set<Peer>
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
} as const

export class RelayServer {
  #wss: WebSocketServer
  #rooms = new Map<string, Room>()
  #attempts: AttemptCounter
  #timer: ReturnType<typeof setInterval>
  #opts: Required<Omit<RelayOptions, 'port' | 'host'>>
  #epoch: number
  #sockets = 0
  #framesRouted = 0
  #bytesRouted = 0
  #heartbeats = 0

  private constructor(wss: WebSocketServer, opts: RelayOptions) {
    this.#wss = wss
    this.#opts = {
      maxStreamsPerHandle: opts.maxStreamsPerHandle ?? DEFAULTS.maxStreamsPerHandle,
      maxSockets: opts.maxSockets ?? DEFAULTS.maxSockets,
      maxFrameBytes: opts.maxFrameBytes ?? DEFAULTS.maxFrameBytes,
      heartbeatMs: opts.heartbeatMs ?? DEFAULTS.heartbeatMs,
      log: opts.log ?? (() => {}),
      now: opts.now ?? (() => Date.now()),
    }

    const now = this.#opts.now()
    this.#epoch = currentEpoch(now)
    this.#attempts = new AttemptCounter(
      { limit: DEFAULTS.attemptLimit, windowMs: DEFAULTS.attemptWindowMs },
      now
    )

    this.#wss.on('connection', (socket, req) => this.#onConnection(socket, req))

    // One timer drives the heartbeat, the reaping and the rotation check, so
    // the relay's own emissions have a cadence that traffic cannot influence.
    this.#timer = setInterval(() => this.#beat(), this.#opts.heartbeatMs)
    this.#timer.unref?.()
  }

  static start(opts: RelayOptions = {}): Promise<RelayServer> {
    const wss = new WebSocketServer({
      port: opts.port ?? 0,
      host: opts.host ?? '127.0.0.1',
      // A compressed frame's length depends on its content. Turning this on
      // would leak through padding that exists precisely to stop that.
      perMessageDeflate: false,
      maxPayload: opts.maxFrameBytes ?? DEFAULTS.maxFrameBytes,
    })

    return new Promise((resolve, reject) => {
      wss.once('error', reject)
      wss.once('listening', () => {
        wss.off('error', reject)
        resolve(new RelayServer(wss, opts))
      })
    })
  }

  /** Base URL peers connect to. Paths are appended by the carrier. */
  get url(): string {
    const address = this.#wss.address()
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
    }
  }

  stop(): Promise<void> {
    clearInterval(this.#timer)
    for (const socket of this.#wss.clients) socket.terminate()
    this.#rooms.clear()
    return new Promise((resolve) => this.#wss.close(() => resolve()))
  }

  #onConnection(socket: WebSocket, req: IncomingMessage): void {
    const now = this.#opts.now()

    if (this.#sockets >= this.#opts.maxSockets) {
      socket.close(CLOSE_BUSY, 'full')
      return
    }
    if (!this.#attempts.allow(req.socket.remoteAddress ?? '', now)) {
      socket.close(CLOSE_BUSY, 'slow down')
      return
    }

    const join = parseJoin(req.url ?? '')
    if (!join) {
      socket.close(CLOSE_BAD_JOIN, 'join')
      return
    }
    if (join.epoch !== this.#epoch) {
      // The peer guessed from its own clock. Hand back the right number so it
      // can derive this epoch's handle and come straight back.
      socket.close(CLOSE_EPOCH, String(this.#epoch))
      return
    }

    const room = this.#rooms.get(join.handle) ?? { uplink: null, streams: new Set<Peer>() }

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

    socket.on('pong', () => {
      peer.alive = true
    })
    socket.on('message', (data, isBinary) => this.#onMessage(peer, room, data, isBinary))
    socket.on('close', () => this.#onClose(join.handle, room, peer))
    socket.on('error', () => socket.terminate())

    this.#sync(room)
  }

  #onMessage(peer: Peer, room: Room, data: RawData, isBinary: boolean): void {
    if (!isBinary) {
      // Peers have nothing to say to the relay. Refusing text keeps the
      // routing path free of anything the relay would have to interpret.
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
    if (peer.role === 'box') {
      for (const stream of room.streams) send(stream, frame)
    } else if (room.uplink) {
      send(room.uplink, frame)
    }
  }

  #onClose(handle: string, room: Room, peer: Peer): void {
    this.#sockets -= 1
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

    const epoch = currentEpoch(this.#opts.now())
    if (epoch !== this.#epoch) {
      this.#epoch = epoch
      for (const room of this.#rooms.values()) {
        for (const peer of peers(room)) peer.socket.close(CLOSE_ROTATED, String(epoch))
      }
      this.#rooms.clear()
    }

    this.#opts.log(
      `epoch=${this.#epoch} rooms=${this.#rooms.size} sockets=${this.#sockets} ` +
        `frames=${this.#framesRouted} bytes=${this.#bytesRouted}`
    )
  }
}

function peers(room: Room): Peer[] {
  return room.uplink ? [room.uplink, ...room.streams] : [...room.streams]
}

function send(peer: Peer, frame: Buffer): void {
  if (peer.socket.readyState !== 1) return
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
