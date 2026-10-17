/** @vitest-environment node */
// Run Core's TestLiveBoxForTheiPhone with its relay unreachable and a local
// ftwcloudd. FTW_LIVE_CLOUD_DIR holds pair.url, ca.pem and noise.pub.
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import WebSocket from 'ws'
import 'fake-indexeddb/auto'
import { installMockAuthenticator } from './support/passkey'
import { pairWithBox } from '$lib/identity/pairing'
import { connectToSite } from '$lib/state/connect'
import { CloudTunnelCarrier } from '$lib/carrier/cloud'
import { decodeBase64url } from '$lib/identity/base64url'
import { openVaultStore, resetIdentity } from '$lib/identity/vault'
import { Session } from '$lib/protocol/session'
import { OP_SET_MODE } from '$lib/protocol/messages'

const DIR = process.env['FTW_LIVE_CLOUD_DIR']
const live = DIR ? describe : describe.skip
live('the web client through real ftwcloudd and Core, with the relay unreachable', () => {
  it('pairs, streams, confirms 30 commands and resumes five times', async () => {
    const read = (name: string) => readFileSync(`${DIR}/${name}`, 'utf8').trim()
    const ca = read('ca.pem')
    class Socket extends WebSocket {
      constructor(url: string) { super(url, { ca, origin: 'https://app.ftw.energy' }) }
    }
    const auth = installMockAuthenticator()
    await resetIdentity(openVaultStore())
    const session = new Session({ build: 'cloud-e2e' })
    try {
      const { site } = await pairWithBox(read('pair.url'), { holdCopy: false })
      const start = performance.now()
      const carrier = await connectToSite(site.siteId, { makeCloud: opts => new CloudTunnelCarrier({ ...opts,
        url: process.env['FTW_LIVE_CLOUD_URL'] ?? 'wss://127.0.0.1:18843/v1/app',
        serviceKeys: [decodeBase64url(read('noise.pub'))], WebSocketImpl: Socket as unknown as typeof globalThis.WebSocket,
      }) })
      session.connect(carrier)
      await streaming(session)
      const firstMs = performance.now() - start
      const taps: number[] = []
      for (let i = 0; i < 30; i++) {
        const then = performance.now()
        const result = await session.command(OP_SET_MODE, { mode: 'self_consumption' }).promise
        expect(result.state).toBe('applied')
        taps.push(performance.now() - then)
      }
      for (let i = 0; i < 5; i++) { carrier.wake?.(); await streaming(session) }
      expect(session.state.carrier).toBe('tunnel')
      expect(site.cloudHome).toBeDefined()
      taps.sort((a, b) => a - b)
      console.log(JSON.stringify({ firstMs: Math.round(firstMs), commands: taps.length,
        resultMedianMs: Math.round(taps[15]!), resultP95Ms: Math.round(taps[28]!), resumes: 5 }))
    } finally { session.close(); auth.uninstall() }
  }, 60_000)
})

async function streaming(session: Session): Promise<void> {
  const end = Date.now() + 15_000
  while (session.state.phase !== 'streaming') {
    if (Date.now() > end) throw new Error(`no stream: ${session.state.phase}`)
    await new Promise(resolve => setTimeout(resolve, 10))
  }
}
