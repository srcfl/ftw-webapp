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
import { PROTO_FLOOR, OP_SET_MODE } from '$lib/protocol/messages'

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

  it('starts the stream from hello without a second client exchange', async () => {
    const box = new SimBox({ now: () => Date.now() })
    const carrier = new LoopbackCarrier(box, { latencyMs: 0 })
    const sent = vi.spyOn(carrier, 'send')
    const session = new Session({ build: BUILD })
    session.connect(carrier)

    await settle()

    const frames = sent.mock.calls.map((call) => decodeFrame(call[0] as Uint8Array))
    expect(frames.map((frame) => frame.envelope.t)).toEqual(['hello'])
    expect((frames[0]!.envelope.b as { sub?: { hz?: number } }).sub?.hz).toBe(1)
    expect(session.state.phase).toBe('streaming')
  })

  it('marks the phases that make up fresh-data latency', async () => {
    const marked = vi.spyOn(performance, 'mark')
    const session = connect(new SimBox({ now: () => Date.now() }))

    await settle()

    const phases = marked.mock.calls
      .map(([name]) => String(name))
      .filter((name) => ['ftw:connect-start', 'ftw:hello-ok', 'ftw:snapshot'].includes(name))
    expect(phases).toEqual(['ftw:connect-start', 'ftw:hello-ok', 'ftw:snapshot'])
    expect(session.state.phase).toBe('streaming')
  })

  it('falls back to the separate subscription for an older box', async () => {
    const box = new SimBox({ now: () => Date.now(), inlineSubscribe: false })
    const carrier = new LoopbackCarrier(box, { latencyMs: 0 })
    const sent = vi.spyOn(carrier, 'send')
    const session = new Session({ build: BUILD })
    session.connect(carrier)

    await settle()

    expect(sent.mock.calls.map((call) => decodeFrame(call[0] as Uint8Array).envelope.t)).toEqual([
      'hello',
      'sub',
    ])
    expect(session.state.phase).toBe('streaming')
  })

  it('changes telemetry cadence only when visibility changes', async () => {
    const box = new SimBox({ now: () => Date.now() })
    const carrier = new LoopbackCarrier(box, { latencyMs: 0 })
    const sent = vi.spyOn(carrier, 'send')
    const session = new Session({ build: BUILD })
    session.connect(carrier)
    await settle()
    sent.mockClear()

    session.setTelemetryHz(0.2)
    session.setTelemetryHz(0.2)
    await settle()

    expect(sent).toHaveBeenCalledTimes(1)
    expect(decodeFrame(sent.mock.calls[0]![0] as Uint8Array).envelope).toMatchObject({
      t: 'sub',
      b: { bucket: 512, hz: 0.2 },
    })
    expect(box.telemetryHz).toBe(0.2)

    session.setTelemetryHz(1)
    await settle()
    expect(sent).toHaveBeenCalledTimes(2)
    expect(box.telemetryHz).toBe(1)
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
    // Fields the delta did not mention survive. Field 1 is the dispatch mode,
    // an index into the catalogue the box sent at handshake.
    expect(session.state.fields.get(1)).toBe(
      session.state.modes.findIndex((m) => m.key === 'planner_passive_arbitrage')
    )
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
    carrier.drop('network gone')
    await settle()

    // The values are still true, only older. Blanking them would throw away
    // the one thing the app can honestly show.
    expect(session.state.fields).toEqual(readings)
    expect(session.state.carrier).toBe('none')
  })

  it('comes back on its own from a box that was still starting', async () => {
    // The drop this is about is the commonest one there is: the box restarts
    // after an update. The wire returns in seconds, the box answers hello with
    // mode 'booting' while it tidies its database, and refuses a subscription.
    //
    // Nothing else in the app would ever ask again. The carrier is up, so no
    // status change is coming; a box that finishes starting does not announce
    // it. Before this the phase parked on 'booting' and stayed there — the
    // starting screen for as long as the app was open, every view frozen on
    // what it held before the drop, and only a reload out of it.
    const box = new SimBox({ now: () => Date.now(), inlineSubscribe: false })
    const carrier = new LoopbackCarrier(box, { latencyMs: 0 })
    const session = new Session({ build: BUILD })

    // What the app puts on the wire. A subscription is the thing a box that
    // has restarted has lost and the app has to send again, so counting them
    // is what says the app healed rather than the simulator being generous.
    const sent = vi.spyOn(carrier, 'send')
    const count = (t: string) =>
      sent.mock.calls.filter((c) => decodeFrame(c[0] as Uint8Array).envelope.t === t).length

    session.connect(carrier)
    await settle()
    expect(session.state.phase).toBe('streaming')
    expect(count('sub')).toBe(1)

    box.faults.booting = true
    carrier.drop('box restarting after an update')
    await settle()
    carrier.restore()
    await settle()

    // The reconnect handshake happened and got 'booting' back.
    expect(session.state.phase).toBe('booting')
    expect(session.state.boot?.phase).toBe('vacuum')
    expect(count('hello')).toBe(2)
    expect(count('sub')).toBe(1)

    // The VACUUM finishes. Nothing on the wire says so.
    box.faults.booting = false
    await vi.advanceTimersByTimeAsync(30_000)

    expect(session.state.phase).toBe('streaming')
    expect(count('sub'), 'never subscribed again to a box that was ready').toBe(2)
    expect(session.state.fields.get(2)).toBeTypeOf('number')

    // And asked at a pace a box mid-VACUUM can carry. Thirty seconds of
    // starting is half a minute of a Pi with its disk busy.
    expect(count('hello'), 'the retry is a poll').toBeLessThan(12)
  })
})

/* Every request, not just the first map anyone remembered to write.
 *
 * A request left pending across a drop settles minutes later on its own
 * deadline, against a view that has moved on — and a late failure that lands
 * after a good answer takes the good answer down with it. The clock is never
 * advanced in these: settling has to happen because the carrier went, not
 * because a timer eventually fired.
 *
 * The wire is cut here, not the session, and it is cut the way a wire is
 * actually cut in the field: `drop()` reports a retryable close and keeps the
 * carrier's handlers, so the same carrier can come back — which is what
 * RelayCarrier does inside itself, and what nothing above it ever learns
 * about. An earlier round drove session.close() instead, a path the app takes
 * only when it is shutting the whole thing down, and passed for months while
 * every real drop left its requests hanging. `close()` on the carrier is no
 * better: it clears the handlers, so a session that tore itself down on a
 * drop would look identical to one that recovered. The last test in here is
 * the one that can tell those apart.
 */
describe('a carrier that goes away settles everything waiting on it', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(FIXED_NOW)
  })
  afterEach(() => vi.useRealTimers())

  /** A session and the wire under it, so the wire can be cut on its own. */
  function connectOverWire(box: SimBox) {
    const carrier = new LoopbackCarrier(box, { latencyMs: 0 })
    const session = new Session({ build: BUILD })
    session.connect(carrier)
    return { session, carrier }
  }

  /** Records how a promise settled without ever waiting on it. */
  function watch<T>(promise: Promise<T>): () => string {
    let outcome = 'still waiting'
    void promise.then(
      () => (outcome = 'answered'),
      (err: Error) => (outcome = err.message)
    )
    return () => outcome
  }

  it('rejects a price window at once rather than eight seconds later', async () => {
    const box = new SimBox({ now: () => Date.now() })
    const { session, carrier } = connectOverWire(box)
    await settle()

    const outcome = watch(session.prices({ fromMs: FIXED_NOW, toMs: FIXED_NOW + 3_600_000 }))
    carrier.drop('wire died')
    await vi.advanceTimersByTimeAsync(0)

    // The phase moving is not enough on its own: a chart waiting on this
    // promise draws nothing until it settles, whatever the phase says.
    expect(session.state.phase).toBe('failed')
    expect(outcome()).toBe('carrier closed')
  })

  it('rejects a plan at once rather than eight seconds later', async () => {
    const box = new SimBox({ now: () => Date.now() })
    const { session, carrier } = connectOverWire(box)
    await settle()

    const outcome = watch(session.plan())
    carrier.drop('wire died')
    await vi.advanceTimersByTimeAsync(0)

    expect(outcome()).toBe('carrier closed')
  })

  it('rejects a history window at once rather than twenty seconds later', async () => {
    const box = new SimBox({ now: () => Date.now() })
    const { session, carrier } = connectOverWire(box)
    await settle()

    const outcome = watch(
      session.history(
        { fromMs: FIXED_NOW - 3_600_000, toMs: FIXED_NOW, res: '5m', series: ['grid_w'] },
        () => {}
      )
    )
    carrier.drop('wire died')
    await vi.advanceTimersByTimeAsync(0)

    expect(outcome()).toBe('carrier closed')
  })

  it('stops an unacknowledged command waiting, because it is never replayed', async () => {
    const box = new SimBox({ now: () => Date.now() })
    const { session, carrier } = connectOverWire(box)
    await settle()

    const outcome = watch(session.command(OP_SET_MODE, { mode: 'idle' }).promise)
    carrier.drop('wire died')
    await vi.advanceTimersByTimeAsync(0)

    // The intent never reached the box, and a queued command is never sent
    // later — so the view has to stop waiting on it now, not in five seconds.
    expect(outcome()).toBe('E_NO_ACK')
  })

  it('calls an acknowledged command unconfirmed rather than claiming it never arrived', async () => {
    // Acks, then the hardware never reports back — the case the confirm
    // deadline exists for.
    const box = new SimBox({ now: () => Date.now(), faults: { neverConfirm: true } })
    const { session, carrier } = connectOverWire(box)
    await settle()

    const handle = session.command(OP_SET_MODE, { mode: 'idle' })
    let state = 'still waiting'
    void handle.promise.then(
      (r) => (state = r.state),
      (err: Error) => (state = err.message)
    )
    // Let the ack come back, but cut the wire well before the confirm deadline.
    await vi.advanceTimersByTimeAsync(50)
    carrier.drop('wire died')
    await vi.advanceTimersByTimeAsync(0)

    // The box took it. Saying "that didn't reach your box" here would be the
    // one thing this protocol exists to prevent: a confident answer that is
    // not true.
    expect(state).toBe('unconfirmed')
  })

  it('is talking to the box again when the wire comes back', async () => {
    // The other half of a drop, and the half none of the tests above can see:
    // the carrier stays attached and returns. Settling the requests must not
    // cost the session its handlers — a session that detached here would look
    // exactly like this one until the wire came back, and then stay dead for
    // as long as the app was open, with no reconnect button to rescue it.
    const box = new SimBox({ now: () => Date.now() })
    const { session, carrier } = connectOverWire(box)
    await settle()
    expect(session.state.phase).toBe('streaming')

    const cut = watch(session.plan())
    carrier.drop('wire died')
    await vi.advanceTimersByTimeAsync(0)
    expect(cut()).toBe('carrier closed')
    expect(session.state.phase).toBe('failed')

    carrier.restore()
    await settle()

    // Re-handshaked over the same carrier, and the box is answering again.
    expect(session.state.phase).toBe('streaming')
    expect(session.state.carrier).toBe('relay')

    const after = watch(session.plan())
    await settle()
    expect(after()).toBe('answered')
  })

  it('does the same when the app closes the session itself', async () => {
    // The other way in — a teardown rather than a drop. Both ends of the
    // split reach the same settling, and this is what says the tear-down end
    // is still wired to it.
    const box = new SimBox({ now: () => Date.now() })
    const { session } = connectOverWire(box)
    await settle()

    const outcome = watch(session.prices({ fromMs: FIXED_NOW, toMs: FIXED_NOW + 3_600_000 }))
    session.close()
    await vi.advanceTimersByTimeAsync(0)

    expect(outcome()).toBe('carrier closed')
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

    // Negative because PV is never positive in FTW's convention: a big
    // negative number is a lot of generation.
    expect(noonPv).toBeLessThan(-1000)
    // -0 at night, because the sign is applied to a zero magnitude. Same
    // number, and Object.is is the only thing that can tell them apart.
    expect(Math.abs(nightPv)).toBe(0)
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
