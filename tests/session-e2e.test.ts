/* End-to-end through the real wire.
 *
 * The client talks to the simulator over encoded frames — no stubs, no
 * shortcuts. A test passing here means the protocol works, not that a mock
 * agreed with itself.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { Session } from '$lib/protocol/session'
import { LoopbackCarrier } from '$lib/carrier/loopback'
import { SimBox } from '$lib/sim/box'
import { decodeFrame } from '$lib/protocol/frame'
import { PROTO_FLOOR } from '$lib/protocol/messages'

const BUILD = 'test'

/** Fixed so the energy shape — and therefore every assertion — is stable. */
const FIXED_NOW = Date.UTC(2026, 6, 15, 12, 0, 0)

function connect(box: SimBox, latencyMs = 0) {
  const session = new Session({ build: BUILD })
  session.connect(new LoopbackCarrier(box, { latencyMs }))
  return session
}

/** Let queued timers run. Loopback defers everything through setTimeout. */
async function settle(times = 6) {
  for (let i = 0; i < times; i++) {
    await vi.advanceTimersByTimeAsync(200)
  }
}

describe('session end to end', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(FIXED_NOW)
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('handshakes, subscribes and receives a snapshot', async () => {
    const box = new SimBox({ now: () => Date.now() })
    const session = connect(box)

    await settle()

    expect(session.state.phase).toBe('streaming')
    expect(session.state.box?.id).toBe('sim-0001')
    expect(session.state.carrier).toBe('relay')
    expect(session.state.caps.has('der.battery')).toBe(true)

    // Frozen field ids 1-9. See contract/registry.yaml.
    expect(session.state.fields.has(2)).toBe(true) // grid_w
    expect(session.state.fields.has(5)).toBe(true) // battery_soc
    expect(session.state.dict['2']?.name).toBe('grid_w')
  })

  it('applies deltas onto the snapshot rather than replacing it', async () => {
    const box = new SimBox({ now: () => Date.now() })
    const session = connect(box)
    await settle()

    const fieldCount = session.state.fields.size
    // Solar, which genuinely moves across an hour. Grid power is a poor probe
    // here: it sits at zero whenever the battery covers the house exactly.
    const pvBefore = session.state.fields.get(3)

    vi.setSystemTime(FIXED_NOW + 3_600_000)
    box.tick()
    await settle()

    expect(session.state.fields.size).toBe(fieldCount)
    expect(session.state.fields.get(3)).not.toBe(pvBefore)
    // Fields the delta did not mention survive.
    expect(session.state.fields.get(1)).toBe(1)
  })

  it('keeps the cadence when nothing changes, without inventing a reading', async () => {
    // The clock is pinned rather than advanced, so every sample is identical
    // and the box has genuinely nothing to report. Silence would itself be a
    // signal to the relay operator, so it must still send a frame.
    const box = new SimBox({ now: () => FIXED_NOW })
    const frames: string[] = []
    box.onFrame((bytes) => {
      frames.push(decodeFrame(bytes).envelope.t)
    })

    const session = connect(box)
    await settle()

    const fieldsBefore = new Map(session.state.fields)
    frames.length = 0

    box.tick()
    box.tick()
    await settle()

    expect(frames).toEqual(['tick', 'tick'])
    expect(session.state.fields).toEqual(fieldsBefore)
  })
})

describe('freshness is two facts, not one', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(FIXED_NOW)
  })
  afterEach(() => vi.useRealTimers())

  it('reports a live carrier while a source is stale', async () => {
    const box = new SimBox({
      now: () => Date.now(),
      faults: { sourceStates: { 'inverter.sungrow': 'stale' } },
    })
    const session = connect(box)
    await settle()

    // This is the case a single enum cannot express: frames are arriving
    // fine, and the inverter is not.
    expect(session.state.carrier).toBe('relay')
    expect(session.state.phase).toBe('streaming')
    expect(session.worstSourceState(['inverter.sungrow'])).toBe('stale')
    expect(session.worstSourceState(['meter.p1'])).toBe('live')
    expect(session.ageOf('inverter.sungrow')).toBeGreaterThan(0)
  })

  it('propagates a device going quiet mid-session', async () => {
    // Caught in the browser, not in review: source states were only ever sent
    // in the snapshot, so a device dying after connect never reached the
    // client. The band stayed green while the meter was gone — which is the
    // exact failure the whole freshness model exists to prevent.
    const box = new SimBox({ now: () => Date.now() })
    const session = connect(box)
    await settle()

    expect(session.worstSourceState(['meter.p1'])).toBe('live')
    expect(session.state.dispatchBlockedBy).toEqual([])

    box.faults = { ...box.faults, sourceStates: { 'meter.p1': 'down' } }
    box.tick()
    await settle()

    expect(session.worstSourceState(['meter.p1'])).toBe('down')
    expect(session.state.dispatchBlockedBy).toEqual(['meter.p1'])
  })

  it('recovers when the device comes back', async () => {
    const box = new SimBox({
      now: () => Date.now(),
      faults: { sourceStates: { 'meter.p1': 'down' } },
    })
    const session = connect(box)
    await settle()
    expect(session.worstSourceState(['meter.p1'])).toBe('down')

    box.faults = { ...box.faults, sourceStates: {} }
    box.tick()
    await settle()

    expect(session.worstSourceState(['meter.p1'])).toBe('live')
    expect(session.state.dispatchBlockedBy).toEqual([])
  })

  it("surfaces the box's own reason for not dispatching", async () => {
    const box = new SimBox({
      now: () => Date.now(),
      faults: { sourceStates: { 'meter.p1': 'down' } },
    })
    const session = connect(box)
    await settle()

    // Stale meter data stops dispatch. The app can say why instead of
    // looking broken.
    expect(session.state.dispatchBlockedBy).toEqual(['meter.p1'])
  })
})

describe('degradation instead of failure', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(FIXED_NOW)
  })
  afterEach(() => vi.useRealTimers())

  it('reports boot progress rather than hanging', async () => {
    const box = new SimBox({ now: () => Date.now(), faults: { booting: true } })
    const session = connect(box)
    await settle()

    expect(session.state.phase).toBe('booting')
    expect(session.state.boot?.phase).toBe('vacuum')
    expect(session.state.boot?.etaMs).toBe(90_000)
  })

  it('falls back to floor mode when the app is too old, and says so', async () => {
    const box = new SimBox({ now: () => Date.now(), faults: { maxProto: PROTO_FLOOR } })
    const session = connect(box)
    await settle()

    expect(session.state.proto).toBe(PROTO_FLOOR)
    expect(session.state.needsUpdate).toBe(true)
    // Degraded, not dead: the core view still has data.
    expect(session.state.phase).toBe('streaming')
    expect(session.state.fields.get(2)).toBeTypeOf('number')
  })

  it('keeps the last readings when the carrier drops', async () => {
    const box = new SimBox({ now: () => Date.now() })
    const carrier = new LoopbackCarrier(box, { latencyMs: 0 })
    const session = new Session({ build: BUILD })
    session.connect(carrier)
    await settle()

    const readings = new Map(session.state.fields)
    carrier.close('network gone')
    await settle()

    // The values are still true, only older. Blanking them would throw away
    // the one thing the app can honestly show.
    expect(session.state.fields).toEqual(readings)
    expect(session.state.carrier).toBe('none')
  })
})

describe('revocation is immediate and fail-closed', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(FIXED_NOW)
  })
  afterEach(() => vi.useRealTimers())

  it('terminates the session mid-stream when access is withdrawn', async () => {
    const box = new SimBox({ now: () => Date.now() })
    const session = connect(box)
    await settle()
    expect(session.state.phase).toBe('streaming')

    box.revoke()
    await settle()

    expect(session.state.phase).toBe('terminated')
    expect(session.state.terminated?.reason).toBe('revoked')
    expect(session.state.carrier).toBe('none')
  })

  it('stops the box streaming to a revoked client', async () => {
    const box = new SimBox({ now: () => Date.now() })
    connect(box)
    await settle()

    box.revoke()
    await settle()

    expect(box.subscribed).toBe(false)
  })
})

describe('the simulated house behaves like a house', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  it('produces solar at noon and none at night', async () => {
    vi.setSystemTime(Date.UTC(2026, 6, 15, 12, 0, 0))
    const noonSession = connect(new SimBox({ now: () => Date.now() }))
    await settle()
    const noonPv = noonSession.state.fields.get(3)!

    vi.setSystemTime(Date.UTC(2026, 6, 15, 1, 0, 0))
    const nightSession = connect(new SimBox({ now: () => Date.now() }))
    await settle()
    const nightPv = nightSession.state.fields.get(3)!

    expect(noonPv).toBeGreaterThan(1000)
    expect(nightPv).toBe(0)
  })

  it('is deterministic for a given seed and instant', async () => {
    vi.setSystemTime(FIXED_NOW)
    const a = connect(new SimBox({ now: () => Date.now() }))
    await settle()
    const b = connect(new SimBox({ now: () => Date.now() }))
    await settle()

    expect(a.state.fields.get(3)).toBe(b.state.fields.get(3))
    expect(a.state.fields.get(6)).toBe(b.state.fields.get(6))
  })
})
