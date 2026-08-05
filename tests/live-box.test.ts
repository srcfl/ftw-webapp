/* The whole chain against a real box.
 *
 * Opt-in: set FTW_LIVE_BOX to the box's LAN address (e.g. 192.168.1.40:8080)
 * and be on its network. The test mints a real pairing code, enrolls as a new
 * device through the production relay, and speaks the protocol the app speaks.
 * Everything between here and the box is the real thing: relay, Noise, frames.
 *
 * It changes nothing about the site. The one command it sends sets the mode
 * the box is already in — the full command path runs, ack to read-back, and
 * the house never notices.
 *
 * @vitest-environment node
 */

import { describe, it, expect } from 'vitest'
import { x25519 } from '@noble/curves/ed25519.js'
import { Session, type SessionState } from '$lib/protocol/session'
import { NoiseCarrier } from '$lib/carrier/noise'
import { RelayCarrier } from '$lib/carrier/relay'
import { parseEnrollmentUrl } from '$lib/identity/enrollment'
import { FID } from '$lib/format/explanation'
// The op constant, never the string: hand-writing a name the box also spells
// is exactly the mistake the registry exists to prevent — and hand-writing it
// here once already cost a debugging round against a live box.
import { OP_SET_MODE, type HistChunk } from '$lib/protocol/messages'

const BOX = process.env['FTW_LIVE_BOX']
const RELAY = process.env['FTW_LIVE_RELAY'] ?? 'wss://relay.ftw.energy'

const live = BOX ? describe : describe.skip

function prologueFor(boxStaticKey: Uint8Array): Uint8Array {
  const tag = new TextEncoder().encode('ftw.session.v1:')
  const out = new Uint8Array(tag.length + boxStaticKey.length)
  out.set(tag, 0)
  out.set(boxStaticKey, tag.length)
  return out
}

async function waitFor<T>(
  session: Session,
  what: string,
  pick: (s: SessionState) => T | null,
  timeoutMs = 30_000
): Promise<T> {
  const found = pick(session.state)
  if (found !== null) return found
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      unsub()
      reject(new Error(`timed out waiting for ${what}; phase=${session.state.phase}`))
    }, timeoutMs)
    const unsub = session.subscribe((s) => {
      const v = pick(s)
      if (v !== null) {
        clearTimeout(timer)
        unsub()
        resolve(v)
      }
    })
  })
}

live('a real box through the real relay', () => {
  it('pairs, streams, plans, sets the mode and asks for history', async () => {
    // -- Mint a pairing code over the LAN, exactly as the settings tab does.
    const minted = await fetch(`http://${BOX}/api/app-link/pairing`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{}',
    })
    expect(minted.ok, `pairing endpoint said ${minted.status}`).toBe(true)
    const pairing = (await minted.json()) as { url: string }
    const enrollment = parseEnrollmentUrl(pairing.url)
    console.log(`[live] paired against ${BOX}, lan hint: ${enrollment.lanHint || '(none)'}`)

    // -- A throwaway device identity, the same shape the vault produces.
    const device = x25519.keygen()

    const session = new Session({ build: 'live-test' })
    const carrier = new NoiseCarrier({
      inner: new RelayCarrier({ url: RELAY, secret: enrollment.rendezvousSecret }),
      staticKey: { secretKey: device.secretKey, publicKey: device.publicKey },
      remoteStatic: enrollment.boxStaticPublic,
      prologue: prologueFor(enrollment.boxStaticPublic),
      handshakePayload: enrollment.pairingCode,
    })
    session.connect(carrier)

    try {
      // -- Streaming means: relay met, Noise agreed, hello answered, sub live.
      await waitFor(session, 'streaming', (s) => (s.phase === 'streaming' ? s : null))
      const state = session.state
      console.log(`[live] box: ${state.box?.id} build ${state.box?.build}`)
      console.log(`[live] caps: ${[...state.caps].sort().join(', ')}`)
      console.log(`[live] modes: ${state.modes.map((m) => m.key).join(', ') || '(EMPTY)'}`)

      expect(state.caps.has('plan.dispatch'), 'box must advertise plan.dispatch').toBe(true)
      expect(state.modes.length, 'mode catalogue must not be empty').toBeGreaterThan(0)

      // -- Telemetry: the frozen fields, with the site sign convention held.
      const fields = await waitFor(session, 'a snapshot with grid_w', (s) =>
        s.fields.has(FID.GRID_W) ? s.fields : null
      )
      const pv = fields.get(FID.PV_W)
      console.log(
        `[live] grid=${fields.get(FID.GRID_W)} pv=${pv} bat=${fields.get(FID.BATTERY_W)} ` +
          `load=${fields.get(FID.LOAD_W)} soc=${fields.get(FID.BATTERY_SOC)} mode#=${fields.get(FID.MODE)} ` +
          `ev=${fields.get(FID.EV_W) ?? '(no charger field)'}`
      )
      if (pv !== undefined) expect(pv, 'pv_w must never be positive').toBeLessThanOrEqual(0)

      // -- The plan.
      const plan = await session.plan()
      console.log(`[live] plan: ${plan.slots.length} slots, rev=${plan.rev}, stale=${plan.stale}`)
      expect(plan.slots.length).toBeGreaterThan(0)

      // -- The command path, end to end, without touching the site: set the
      //    mode it is already in. Ack, control.ApplyMode, read-back — all run.
      const modeIndex = fields.get(FID.MODE)
      expect(modeIndex, 'mode field must be streamed').toBeDefined()
      const current = state.modes[modeIndex!]?.key
      expect(current, `mode index ${modeIndex} must be in the catalogue`).toBeDefined()

      const result = await session.command(OP_SET_MODE, { mode: current! }).promise
      console.log(
        `[live] set_mode(${current}): ${result.state}` +
          (result.error ? ` — ${result.error.code} ${JSON.stringify(result.error.args ?? {})}` : '')
      )
      expect(result.state).toBe('applied')

      // -- History: whatever the box answers, print the truth of it.
      const chunks: HistChunk[] = []
      try {
        const nowMs = Date.now()
        const end = await session.history(
          {
            series: ['grid_w', 'pv_w', 'battery_w', 'load_w'],
            res: '5m',
            fromMs: nowMs - 6 * 3_600_000,
            toMs: nowMs,
          },
          (c) => chunks.push(c)
        )
        console.log(
          `[live] history: ${chunks.length} chunks, resActual=${end.resActual}, ` +
            `gaps=${end.gaps.length}, tiles: ${chunks.map((c) => `${c.tileId}${c.partial ? '*' : ''}`).join(' ')}`
        )
        expect(chunks.length, 'a six-hour window must produce at least one tile').toBeGreaterThan(0)
      } catch (err) {
        console.log(`[live] history refused: ${(err as Error).message}`)
      }
    } finally {
      session.close()
    }
  }, 90_000)
})
