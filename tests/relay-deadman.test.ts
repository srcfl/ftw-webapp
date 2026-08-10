/* The dead man's switch, through the real relay.
 *
 * A real RelayServer, a real WebSocket playing the box's uplink, the HTTP
 * door for the row, and the one timer driving the countdown. What is under
 * test is the seam the unit tests cannot see: that a claim spoken on the
 * socket holds the switch the HTTP row armed, that the routing path for
 * room traffic never notices any of it, and that what fires is the sealed
 * bytes and nothing else.
 */

import { describe, it, expect, afterEach } from 'vitest'
import WebSocket from 'ws'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { RelayServer } from '../relay/src/server.ts'
import { currentEpoch } from '../relay/src/epoch.ts'

const ID = 'c'.repeat(32)
const CT = Buffer.from('the sealed goodbye').toString('base64')

let relay: RelayServer | null = null

afterEach(async () => {
  await relay?.stop()
  relay = null
})

function httpUrl(): string {
  return relay!.url.replace('ws://', 'http://')
}

async function boxSocket(): Promise<WebSocket> {
  const handle = 'd'.repeat(32)
  const ws = new WebSocket(`${relay!.url}/r/${currentEpoch(Date.now())}/${handle}/box`)
  await new Promise<void>((resolve, reject) => {
    ws.once('open', () => resolve())
    ws.once('error', reject)
  })
  return ws
}

describe('the switch through the real relay', () => {
  it('arms over HTTP, holds on a spoken claim, fires the sealed bytes after the drop', async () => {
    const fired: { endpoint: string; body: Buffer; headers: Record<string, string> }[] = []
    let now = Date.now()
    relay = await RelayServer.start({
      heartbeatMs: 50,
      now: () => now,
      deadmanPath: join(mkdtempSync(join(tmpdir(), 'relay-dm-')), 'rows.json'),
      deadmanPost: async (endpoint, body, headers) => {
        fired.push({ endpoint, body: Buffer.from(body), headers })
        return { status: 201 }
      },
    })

    const put = await fetch(`${httpUrl()}/deadman`, {
      method: 'POST',
      body: JSON.stringify({
        id: ID,
        endpoint: 'https://push.example/send/x',
        ct: CT,
        deadline_s: 60,
        auth: 'vapid t=x, k=y',
      }),
    })
    expect(put.status).toBe(204)

    const ws = await boxSocket()
    ws.send(`deadman ${ID}`)
    await new Promise((r) => setTimeout(r, 100))
    expect(relay.inspect().deadman).toEqual({ rows: 1, claimed: 1, armed: 0 })

    // Claimed and connected: hours may pass.
    now += 3_600_000
    await new Promise((r) => setTimeout(r, 120))
    expect(fired).toHaveLength(0)

    // The box goes away. The countdown runs on the relay's one timer.
    ws.terminate()
    await new Promise((r) => setTimeout(r, 100))
    now += 61_000
    await new Promise((r) => setTimeout(r, 150))

    expect(fired).toHaveLength(1)
    expect(fired[0]!.body.toString()).toBe('the sealed goodbye')
    expect(fired[0]!.headers['Content-Encoding']).toBe('aes128gcm')
    expect(fired[0]!.headers['Authorization']).toBe('vapid t=x, k=y')
  })

  it('refuses a malformed row and withdraws on DELETE', async () => {
    relay = await RelayServer.start({ heartbeatMs: 50_000 })

    const bad = await fetch(`${httpUrl()}/deadman`, {
      method: 'POST',
      body: JSON.stringify({ id: 'nope', endpoint: 'https://x', ct: CT, deadline_s: 60 }),
    })
    expect(bad.status).toBe(400)

    const ok = await fetch(`${httpUrl()}/deadman`, {
      method: 'POST',
      body: JSON.stringify({ id: ID, endpoint: 'https://push.example/x', ct: CT, deadline_s: 60 }),
    })
    expect(ok.status).toBe(204)
    expect(relay.inspect().deadman.rows).toBe(1)

    const gone = await fetch(`${httpUrl()}/deadman/${ID}`, { method: 'DELETE' })
    expect(gone.status).toBe(204)
    expect(relay.inspect().deadman.rows).toBe(0)
  })

  it('keeps killing every other text message, both roles', async () => {
    relay = await RelayServer.start({ heartbeatMs: 50_000 })

    const ws = await boxSocket()
    const closed = new Promise<number>((resolve) => ws.once('close', (code) => resolve(code)))
    ws.send('deadman not-a-valid-id')
    expect(await closed).toBe(4400)

    const handle = 'e'.repeat(32)
    const app = new WebSocket(`${relay.url}/r/${currentEpoch(Date.now())}/${handle}/app`)
    await new Promise<void>((resolve) => app.once('open', () => resolve()))
    const appClosed = new Promise<number>((resolve) => app.once('close', (code) => resolve(code)))
    // The claim word is the uplink's alone: an app speaking it is an app
    // trying to hold someone's switch, and it meets the old rule.
    app.send(`deadman ${ID}`)
    expect(await appClosed).toBe(4400)
  })
})
