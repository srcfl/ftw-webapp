import { describe, it, expect, afterEach, vi } from 'vitest'
import { CloudTunnelCarrier } from './cloud'
import { NoiseCarrier } from './noise'
import { Session } from '$lib/protocol/session'
import { OP_SET_MODE } from '$lib/protocol/messages'
import { cloudHarness, HOME } from '../../../tests/support/cloud-harness'

const cleanup: (() => void)[] = []
afterEach(() => { cleanup.splice(0).forEach(close => close()); vi.useRealTimers(); vi.unstubAllGlobals(); vi.restoreAllMocks() })
const settle = async () => { for (let i = 0; i < 25; i++) await new Promise(r => setTimeout(r, 1)) }

function chain() {
  const h = cloudHarness()
  const inner = new CloudTunnelCarrier({ home: HOME, staticKey: h.device, pairingCode: h.code,
    WebSocketImpl: h.WebSocketImpl, serviceKeys: [h.service.publicKey], random: () => 0.5 })
  const carrier = new NoiseCarrier({ inner, staticKey: h.device, remoteStatic: h.boxKey.publicKey,
    prologue: new Uint8Array([...new TextEncoder().encode('ftw.session.v1:'), ...h.boxKey.publicKey]), handshakePayload: h.code })
  const session = new Session({ build: 'cloud-test' })
  session.connect(carrier)
  cleanup.push(() => { session.close(); h.close() })
  return { ...h, inner, carrier, session }
}

describe('the box session through FTW Cloud, without a relay', () => {
  it('pairs, streams and answers a command with the readable copy off', async () => {
    const h = chain()
    await settle()
    expect(h.errors).toEqual([])
    expect(h.session.state.phase).toBe('streaming')
    expect(h.session.state.carrier).toBe('tunnel')
    expect(h.sockets).toHaveLength(1)
    expect(h.sockets[0]!.url).toBe(`wss://cloud.ftw.energy/v1/app?home=${HOME}`)
    expect(h.now[0]!['pair']).toBeInstanceOf(Uint8Array)
    expect(h.now[0]!['tun']).toBeDefined()
    const command = h.session.command(OP_SET_MODE, { mode: 'idle' })
    const result = await command.promise
    expect(result.state).toBe('applied')
    const fields = new Map(h.session.state.fields)
    h.sockets[0]!.reading()
    await settle()
    expect(h.session.state.fields).toEqual(fields)
    expect(h.errors).toEqual([])
  })

  it('keeps API reads and history on the same box session', async () => {
    const h = chain(); await settle()
    const response = await h.session.api({ method: 'GET', path: '/api/status' })
    expect(response.status).toBe(200)
    let chunks = 0
    await h.session.history({ series: ['grid_w'], res: '5m', fromMs: Date.now() - 3_600_000, toMs: Date.now() }, () => { chunks++ })
    expect(chunks).toBeGreaterThan(0)
    expect(h.sockets).toHaveLength(1)
    expect(h.errors).toEqual([])
  })

  it('tries the second pinned service key without losing the box handshake', async () => {
    const h = cloudHarness()
    const inner = new CloudTunnelCarrier({ home: HOME, staticKey: h.device, pairingCode: h.code,
      WebSocketImpl: h.WebSocketImpl, serviceKeys: [new Uint8Array(32).fill(5), h.service.publicKey] })
    const carrier = new NoiseCarrier({ inner, staticKey: h.device, remoteStatic: h.boxKey.publicKey,
      prologue: new Uint8Array([...new TextEncoder().encode('ftw.session.v1:'), ...h.boxKey.publicKey]), handshakePayload: h.code })
    const session = new Session({ build: 'rotation' })
    cleanup.push(() => { session.close(); h.close() })
    session.connect(carrier)
    await settle()
    expect(h.errors).toEqual([])
    expect(h.sockets).toHaveLength(2)
    expect(session.state.phase).toBe('streaming')
    expect(h.now[0]!['tun']).toBeDefined()
  })

  it('uses a new tunnel id after wake and ignores a late end from the old session', async () => {
    const h = chain(); await settle()
    const sid = h.sockets[0]!.sid
    h.carrier.wake(); await settle()
    expect(h.sockets).toHaveLength(2)
    expect(h.sockets[0]!.closed).toBe(true)
    expect(h.sockets[1]!.sid).not.toBe(sid)
    h.sockets[1]!.tunnel({ sid, d: new Uint8Array() })
    await settle()
    expect(h.session.state.phase).toBe('streaming')
    expect(h.errors).toEqual([])
  })

  it('backs off a refused device and never dials a relay', async () => {
    const h = chain(); h.refuse(4403); await settle()
    expect(h.inner.status.phase).toBe('closed')
    expect(h.sockets).toHaveLength(1)
    expect(h.errors).toEqual([])
  })

  it('does not take a replaced device session back in a retry loop', async () => {
    const h = chain(); await settle()
    h.sockets[0]!.end(4408)
    vi.useFakeTimers(); await vi.advanceTimersByTimeAsync(300_000)
    expect(h.sockets).toHaveLength(1)
    expect(h.inner.status).toMatchObject({ phase: 'closed', retryable: false })
  })

  it('bounds repeated tunnel endings and never replays an old box frame', async () => {
    const h = chain(); await settle()
    const socket = h.sockets[0]!
    const before = h.forwarded.length
    vi.useFakeTimers()
    socket.tunnel({ sid: socket.sid, d: new Uint8Array() })
    await vi.advanceTimersByTimeAsync(0)
    expect(h.inner.status.phase).toBe('closed')
    expect(h.forwarded).toHaveLength(before)
  })

  it('shares the device slot across tabs through Web Locks', async () => {
    let tail = Promise.resolve()
    const locks = { request: (_name: string, options: { signal: AbortSignal }, run: () => Promise<void>) => {
      const next = tail.then(async () => {
        if (options.signal.aborted) throw new DOMException('cancelled', 'AbortError')
        await run()
      })
      tail = next.catch(() => {})
      return next
    } }
    vi.stubGlobal('navigator', { locks })
    const first = chain()
    const second = chain()
    await settle()
    expect(first.session.state.phase).toBe('streaming')
    expect(second.sockets).toHaveLength(0)
    first.session.close()
    await settle()
    expect(second.session.state.phase).toBe('streaming')
    expect(second.sockets).toHaveLength(1)
  })

  it('closes in the background and reconnects without replaying a command', async () => {
    const h = chain(); await settle()
    h.silent(true)
    const pending = h.session.command(OP_SET_MODE, { mode: 'idle' }).promise.catch(error => error)
    const visibility = vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('hidden')
    document.dispatchEvent(new Event('visibilitychange'))
    expect(h.sockets[0]!.closed).toBe(true)
    expect(await pending).toBeInstanceOf(Error)
    h.silent(false)
    visibility.mockReturnValue('visible')
    document.dispatchEvent(new Event('visibilitychange'))
    await settle()
    expect(h.sockets).toHaveLength(2)
    expect(h.session.state.phase).toBe('streaming')
    expect(h.errors).toEqual([])
  })
})
