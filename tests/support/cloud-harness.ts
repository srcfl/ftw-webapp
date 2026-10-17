import { keyPairFromSecret, HandshakeState, type KeyPair } from '$lib/crypto/noise'
import { NoiseTransport } from '$lib/crypto/transport'
import { cloudBody, cloudPrologue, unsigned, cloudFrame, readCloudFrame, readTunnel, type TunnelMessage } from '$lib/protocol/cloud'
import { SimBox } from '$lib/sim/box'
import { NoiseBox } from '$lib/sim/noise-box'

export const HOME = 'fjzyr67buzpyncqmjliwgezvde'
export const key = (n: number): KeyPair => keyPairFromSecret(new Uint8Array(32).fill(n))

/** A Cloud protocol peer and a separate box, with both real Noise layers. */
export function cloudHarness() {
  const service = key(1)
  const boxKey = key(2)
  const device = key(3)
  const code = new Uint8Array(16).fill(9)
  const sim = new SimBox({ now: () => Date.now(), cloud: { home: HOME,
    pk: new Uint8Array([4, ...new Uint8Array(64).fill(7)]), boot: new Uint8Array(16), sources: {}, loadpoints: {} } })
  let paired = false
  const box = new NoiseBox({ box: sim, staticKey: boxKey,
    prologue: new Uint8Array([...new TextEncoder().encode('ftw.session.v1:'), ...boxKey.publicKey]),
    acceptPairing: p => {
      if (paired && !p.length) return true
      paired = p.length === code.length && p.every((x, i) => x === code[i])
      return paired
    },
  })
  const errors: unknown[] = []
  const sockets: Socket[] = []
  const now: Record<string, unknown>[] = []
  const forwarded: TunnelMessage[] = []
  const cloudReadings: Uint8Array[] = []
  let refuse = 0
  let silent = false

  class Socket {
    binaryType = 'arraybuffer'
    bufferedAmount = 0
    onopen: ((event: Event) => void) | null = null
    onmessage: ((event: MessageEvent) => void) | null = null
    onclose: ((event: CloseEvent) => void) | null = null
    onerror: ((event: Event) => void) | null = null
    closed = false
    hs = HandshakeState.responder({ staticKey: service, prologue: cloudPrologue(HOME) })
    transport: NoiseTransport | null = null
    input = Promise.resolve()
    sid = 0
    unsub: () => void
    constructor(readonly url: string) {
      sockets.push(this)
      this.unsub = box.onFrame(d => {
        if (this.transport && !this.closed) this.tunnel({ sid: this.sid, d })
      })
      queueMicrotask(() => this.onopen?.(new Event('open')))
    }
    send(data: Uint8Array): void {
      if (this.closed) return
      this.input = this.input.then(async () => {
        if (silent || this.closed) return
        if (!this.transport) {
          if (refuse) { this.end(refuse); return }
          const envelope = cloudBody(await this.hs.readMessage(data))
          const body = cloudBody(envelope['b'] as Uint8Array)
          now.push(body)
          const reply = await this.hs.writeMessage(unsigned('snapshot', { envelopes: [], online: true, lastSeenMs: 0, more: 0 }))
          this.transport = new NoiseTransport(this.hs.split())
          this.deliver(reply)
          if (body['tun']) this.forward(body['tun'] as TunnelMessage)
        } else {
          const envelope = readCloudFrame(this.transport.decrypt(data))
          if (envelope.t === 'tun') this.forward(readTunnel(envelope.b))
        }
      }).catch(error => {
        if (error?.code === 'E_NOISE_AUTH') this.end(4403)
        else errors.push(error)
      })
    }
    forward(tun: TunnelMessage): void {
      forwarded.push(tun)
      if (!tun.d.length) { box.reset(); return }
      if (tun.sid !== this.sid) box.reset()
      this.sid = tun.sid
      box.receive(tun.d)
    }
    tunnel(tun: TunnelMessage): void { this.deliver(this.transport!.encrypt(cloudFrame(unsigned('tun', tun)))) }
    reading(): void {
      // A service can lie about a readable copy. It must never enter the
      // end-to-end Session, even if it says the house is live.
      const msg = this.transport!.encrypt(cloudFrame(unsigned('live', { fields: { '2': 999999 } })))
      cloudReadings.push(msg)
      this.deliver(msg)
    }
    deliver(data: Uint8Array): void {
      queueMicrotask(() => { if (!this.closed) this.onmessage?.(new MessageEvent('message', { data: data.slice().buffer })) })
    }
    end(code = 1006, reason = ''): void {
      this.closed = true
      this.unsub()
      this.onclose?.(new CloseEvent('close', { code, reason }))
    }
    close(): void { this.closed = true; this.unsub() }
  }

  return { service, boxKey, device, code, sim, box, sockets, now, forwarded, errors,
    WebSocketImpl: Socket as unknown as typeof WebSocket,
    refuse(code: number) { refuse = code }, silent(on: boolean) { silent = on },
    close() { sockets.forEach(s => s.close()); box.destroy() },
  }
}
