import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import 'fake-indexeddb/auto'
import { installMockAuthenticator } from '../../../tests/support/passkey'
import { cloudHarness, HOME } from '../../../tests/support/cloud-harness'
import { CloudTunnelCarrier } from '$lib/carrier/cloud'
import { pairWithBox } from '$lib/identity/pairing'
import { encodeBase64url } from '$lib/identity/base64url'
import { Session } from '$lib/protocol/session'
import { connectToSite, loadSite } from './connect'
import { db } from '$lib/store/db'
import { openVaultStore, resetIdentity } from '$lib/identity/vault'

const cleanup: (() => void)[] = []
const settle = async () => { for (let i = 0; i < 30; i++) await new Promise(r => setTimeout(r, 2)) }
beforeEach(async () => {
  await resetIdentity(openVaultStore())
  const database = await db()
  for (const name of ['meta', 'keys', 'sites', 'snapshot'] as const) await database.clear(name)
  const auth = installMockAuthenticator()
  cleanup.push(() => auth.uninstall())
})
afterEach(() => { cleanup.splice(0).reverse().forEach(close => close()) })

function setup() {
  const h = cloudHarness()
  cleanup.push(() => h.close())
  const link = (v3: boolean) => `https://app.ftw.energy/p#${v3 ? 'v3' : 'v2'}.${encodeBase64url(h.boxKey.publicKey)}.${encodeBase64url(h.code)}..${encodeBase64url(new Uint8Array(32).fill(4))}${v3 ? '.' + encodeBase64url(new TextEncoder().encode(HOME)) : ''}`
  return { ...h, link,
    cloud: (opts: ConstructorParameters<typeof CloudTunnelCarrier>[0]) => new CloudTunnelCarrier({ ...opts,
      serviceKeys: [h.service.publicKey], WebSocketImpl: h.WebSocketImpl }),
  }
}

describe('the shipped connect and pairing path', () => {
  it('keeps QR v3 home and pairs through Cloud without constructing a relay', async () => {
    const h = setup()
    const paired = await pairWithBox(h.link(true), { holdCopy: false })
    expect((await loadSite(paired.site.siteId))!.cloudHome).toBe(HOME)
    const carrier = await connectToSite(paired.site.siteId, { makeCloud: h.cloud })
    const session = new Session({ build: 'new-home' })
    cleanup.push(() => session.close())
    session.connect(carrier)
    await settle()
    expect(h.errors).toEqual([])
    expect(session.state.phase).toBe('streaming')
    expect(session.state.carrier).toBe('tunnel')
    expect((await loadSite(paired.site.siteId))!.cloudKey).toHaveLength(65)
  })

  it('asks an old installation to pair again before opening any socket', async () => {
    const h = setup()
    const paired = await pairWithBox(h.link(true), { holdCopy: false })
    const database = await db()
    const row = (await loadSite(paired.site.siteId))!
    delete row.cloudHome
    await database.put('sites', row)
    await expect(connectToSite(paired.site.siteId, { makeCloud: h.cloud })).rejects.toMatchObject({
      code: 'stale_pairing', help: expect.stringMatching(/pair this home again/i),
    })
    expect(h.sockets).toHaveLength(0)
  })

  it('refuses an old QR before asking for a passkey', async () => {
    const h = setup()
    await expect(pairWithBox(h.link(false), { holdCopy: false })).rejects.toMatchObject({ code: 'E_QR_HOME' })
    expect(await (await db()).getAll('sites')).toHaveLength(0)
    expect(h.sockets).toHaveLength(0)
  })
})
