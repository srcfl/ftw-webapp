import { CarrierBase, type Carrier, type CarrierStatus } from './carrier'
import { HandshakeState, type StaticKey, type KeyPair } from '$lib/crypto/noise'
import { NoiseTransport } from '$lib/crypto/transport'
import { decodeBase64url } from '$lib/identity/base64url'
import {
  CLOUD_URL, CLOUD_KEYS, TUN_DATA_MAX, cloudPrologue, pairingHash,
  unsigned, cloudFrame, readCloudFrame, readCloudSnapshot, readTunnel,
} from '$lib/protocol/cloud'

export interface CloudOptions {
  home: string
  staticKey: StaticKey | KeyPair
  pairingCode?: Uint8Array
  /** Injected by tests and local development, never read from a QR or server. */
  url?: string
  serviceKeys?: Uint8Array[]
  WebSocketImpl?: typeof WebSocket
  random?: () => number
}

/** One Cloud socket carries the device's unchanged Noise session with its box. */
export class CloudTunnelCarrier extends CarrierBase implements Carrier {
  readonly kind = 'tunnel' as const
  readonly rttMs = null
  #status: CarrierStatus = { phase: 'connecting' }
  #opts: CloudOptions
  #keys: Uint8Array[]
  #WS: typeof WebSocket
  #random: () => number
  #ws: WebSocket | null = null
  #socketOpen = false
  #transport: NoiseTransport | null = null
  #handshake: HandshakeState | null = null
  #generation = 0
  #keyIndex = 0
  #sid = 0
  #first: Uint8Array | null = null
  #riding: { sid: number; d: Uint8Array } | null = null
  #deadline: ReturnType<typeof setTimeout> | undefined
  #retry: ReturnType<typeof setTimeout> | undefined
  #attempt = 0
  #refusals = 0
  #closed = false
  #frames = 0
  #carryingAt = 0
  #lockRequest: AbortController | null = null
  #release: (() => void) | null = null

  constructor(opts: CloudOptions) {
    super()
    cloudPrologue(opts.home)
    this.#opts = opts
    this.#keys = opts.serviceKeys ?? CLOUD_KEYS.map(decodeBase64url)
    if (!this.#keys.length || this.#keys.some(k => k.length !== 32)) throw new Error('missing Cloud key')
    this.#WS = opts.WebSocketImpl ?? globalThis.WebSocket
    this.#random = opts.random ?? Math.random
    globalThis.addEventListener?.('online', this.wake)
    globalThis.document?.addEventListener('visibilitychange', this.#visibility)
    this.#acquire()
  }

  get status(): CarrierStatus { return this.#status }

  beginSession(): void {
    if (this.#sid && this.#transport) this.#sendTun(new Uint8Array())
    this.#sid = crypto.getRandomValues(new Uint32Array(1))[0]! || 1
    this.#first = null
    this.#frames = 0
    this.#carryingAt = 0
  }

  send(frame: Uint8Array): void {
    if (this.#closed || this.#status.phase !== 'open' || frame.length > TUN_DATA_MAX) return
    if (this.#transport) this.#sendTun(frame)
    else if (this.#first === null) {
      this.#first = frame.slice()
      if (this.#socketOpen) void this.#message1(this.#generation)
    }
  }

  wake = (): void => {
    if (this.#closed || globalThis.document?.visibilityState === 'hidden') return
    if (this.#status.phase === 'open' && !this.#transport) return
    this.#attempt = this.#refusals = this.#keyIndex = 0
    clearTimeout(this.#retry)
    if (this.#release || !globalThis.navigator?.locks) this.#dial()
    else this.#acquire()
  }

  close(reason = 'closed by client'): void {
    if (this.#closed) return
    if (this.#sid && this.#transport) this.#sendTun(new Uint8Array())
    this.#closed = true
    clearTimeout(this.#retry)
    this.#drop()
    this.#unlock()
    globalThis.removeEventListener?.('online', this.wake)
    globalThis.document?.removeEventListener('visibilitychange', this.#visibility)
    this.#setStatus({ phase: 'closed', reason, retryable: false })
    this.clearHandlers()
  }

  #visibility = (): void => {
    if (globalThis.document?.visibilityState !== 'hidden') { this.wake(); return }
    if (this.#sid && this.#transport) this.#sendTun(new Uint8Array())
    clearTimeout(this.#retry)
    this.#drop()
    this.#unlock()
    this.#setStatus({ phase: 'closed', reason: 'app in background', retryable: true })
  }

  #acquire(): void {
    if (this.#closed || this.#lockRequest || globalThis.document?.visibilityState === 'hidden') return
    const locks = globalThis.navigator?.locks
    if (!locks) { this.#dial(); return }
    const request = new AbortController()
    this.#lockRequest = request
    // The roster allows one Cloud session per device. A second tab waits
    // rather than making both tabs take that session back in a retry loop.
    void locks.request(`ftw-cloud:${this.#opts.home}`, { signal: request.signal }, async () => {
      if (this.#closed || request.signal.aborted) return
      await new Promise<void>(resolve => {
        this.#release = resolve
        this.#dial()
      })
      this.#release = null
    }).catch((err: unknown) => {
      if (!(err instanceof DOMException && err.name === 'AbortError')) {
        this.#setStatus({ phase: 'closed', reason: 'could not open this home', retryable: false })
      }
    }).finally(() => { if (this.#lockRequest === request) this.#lockRequest = null })
  }

  #unlock(): void {
    this.#lockRequest?.abort()
    this.#lockRequest = null
    this.#release?.()
    this.#release = null
  }

  #dial(preserveFirst = false): void {
    if (this.#closed) return
    const riding = preserveFirst ? this.#riding : null
    const first = preserveFirst ? this.#first : null
    this.#drop()
    this.#riding = riding
    this.#first = first
    if (!preserveFirst) {
      this.#setStatus({ phase: 'connecting' })
      // Open for the box's message 1 to wait for the outer handshake.
      this.#setStatus({ phase: 'open', sinceMs: Date.now() })
    }
    const mine = this.#generation
    const url = new URL(this.#opts.url ?? CLOUD_URL)
    url.searchParams.set('home', this.#opts.home)
    let ws: WebSocket
    try { ws = new this.#WS(url.toString()) }
    catch { this.#ended(1006, ''); return }
    this.#ws = ws
    ws.binaryType = 'arraybuffer'
    let received = Promise.resolve()
    let queuedBytes = 0
    let queuedMessages = 0
    ws.onopen = () => {
      if (mine !== this.#generation) return
      this.#socketOpen = true
      void this.#message1(mine)
    }
    ws.onmessage = event => {
      if (mine !== this.#generation) return
      if (!(event.data instanceof ArrayBuffer) || event.data.byteLength > 65565) { this.#fail(); return }
      const bytes = new Uint8Array(event.data)
      // Bound work waiting behind an async handshake to 4 MiB / 256 frames.
      if (queuedBytes + bytes.length > 4 * 1024 * 1024 || queuedMessages >= 256) { this.#fail(); return }
      queuedBytes += bytes.length
      queuedMessages++
      received = received.then(async () => {
        try { if (mine === this.#generation) await this.#receive(bytes, mine) }
        finally { queuedBytes -= bytes.length; queuedMessages-- }
      }).catch(() => { if (mine === this.#generation) this.#fail() })
    }
    ws.onerror = () => { if (mine === this.#generation) this.#ended(1006, '') }
    ws.onclose = event => { if (mine === this.#generation) this.#ended(event.code, event.reason) }
    this.#deadline = setTimeout(() => { if (mine === this.#generation) this.#fail() }, 10_000)
  }

  async #message1(mine: number): Promise<void> {
    if (this.#handshake || this.#transport || (!this.#first && !this.#riding)) return
    try {
      const hs = HandshakeState.initiator({ staticKey: this.#opts.staticKey,
        remoteStatic: this.#keys[this.#keyIndex]!, prologue: cloudPrologue(this.#opts.home) })
      this.#handshake = hs
      if (!this.#riding && this.#first) {
        this.#riding = { sid: this.#sid, d: this.#first }
        this.#first = null
      }
      const now = unsigned('now', { hz: 0,
        ...(this.#opts.pairingCode ? { pair: pairingHash(this.#opts.home, this.#opts.pairingCode) } : {}),
        ...(this.#riding ? { tun: this.#riding } : {}) })
      const msg = await hs.writeMessage(now)
      if (mine === this.#generation) this.#ws?.send(msg as Uint8Array<ArrayBuffer>)
    } catch { if (mine === this.#generation) this.#fail() }
  }

  async #receive(bytes: Uint8Array, mine: number): Promise<void> {
    if (!this.#transport) {
      if (!this.#handshake) throw new Error('Cloud handshake missing')
      const hs = this.#handshake
      const payload = await hs.readMessage(bytes)
      if (mine !== this.#generation) return
      readCloudSnapshot(payload)
      this.#transport = new NoiseTransport(hs.split())
      this.#handshake = null
      this.#riding = null
      clearTimeout(this.#deadline)
      this.#attempt = this.#refusals = 0
      if (this.#first) {
        const first = this.#first
        this.#first = null
        this.#sendTun(first)
      }
      return
    }
    const envelope = readCloudFrame(this.#transport.decrypt(bytes))
    if (envelope.t !== 'tun') return
    if (envelope.sig.length !== 0) throw new Error('signed tunnel envelope')
    const tun = readTunnel(envelope.b)
    if (tun.sid !== this.#sid) return
    if (!tun.d.length) {
      if (this.#carryingAt && Date.now() - this.#carryingAt >= 30_000) this.#attempt = 0
      this.#first = this.#riding = null
      this.#setStatus({ phase: 'closed', reason: 'the box ended the session', retryable: true })
      this.#schedule(this.#backoff(), () => this.#setStatus({ phase: 'open', sinceMs: Date.now() }))
      return
    }
    if (++this.#frames === 2) this.#carryingAt = Date.now()
    this.emitFrame(tun.d)
  }

  #sendTun(d: Uint8Array): void {
    if (!this.#transport || !this.#ws || !this.#sid) return
    if (this.#ws.bufferedAmount > 4 * 1024 * 1024) { this.#fail(); return }
    try {
      this.#ws.send(this.#transport.encrypt(cloudFrame(unsigned('tun', { sid: this.#sid, d }))) as Uint8Array<ArrayBuffer>)
    } catch { this.#fail() }
  }

  #ended(code: number, reason: string): void {
    if (code === 4403 && !this.#transport && this.#keyIndex + 1 < this.#keys.length) {
      this.#keyIndex++
      this.#dial(true)
      return
    }
    this.#drop()
    this.#keyIndex = 0
    this.#setStatus({ phase: 'closed', reason: `Cloud connection closed (${code})`, retryable: code !== 4408 })
    if (code === 4408) return
    if (code === 4403) {
      const ceiling = Math.min(300_000, 15_000 * 2 ** Math.min(this.#refusals++, 5))
      this.#schedule(ceiling / 2 + this.#random() * ceiling / 2)
    } else if (code === 4503) {
      const value = /^\d+$/.test(reason.trim()) ? Number(reason) : 5000
      this.#schedule(this.#random() * Math.min(60_000, Math.max(1000, value)))
    } else this.#schedule(this.#backoff())
  }

  #fail(): void { this.#ended(4400, '') }

  #backoff(): number {
    return this.#random() * Math.min(60_000, 500 * 2 ** Math.min(this.#attempt++, 16))
  }

  #schedule(ms: number, run = () => this.#dial()): void {
    clearTimeout(this.#retry)
    this.#retry = setTimeout(() => { this.#retry = undefined; if (!this.#closed) run() }, ms)
  }

  #drop(): void {
    this.#generation++
    clearTimeout(this.#deadline)
    const ws = this.#ws
    this.#ws = null
    this.#socketOpen = false
    if (ws) { ws.onopen = ws.onmessage = ws.onclose = ws.onerror = null; ws.close() }
    this.#transport?.close()
    this.#transport = null
    this.#handshake = null
    this.#first = this.#riding = null
  }

  #setStatus(status: CarrierStatus): void {
    if (this.#closed && status.phase !== 'closed') return
    this.#status = status
    this.emitStatus(status)
  }
}
