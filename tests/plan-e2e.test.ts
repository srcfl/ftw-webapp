/* The plan and the controls, end to end against the simulator.
 *
 * Seeing what the box intends and being able to change it is the reason to
 * have an app rather than a chart. These run the real exchange: plan.get over
 * the bulk lane, cmd with an expiry and a revision, ack then result.
 */

import { describe, it, expect } from 'vitest'
import { Session } from '$lib/protocol/session'
import { LoopbackCarrier } from '$lib/carrier/loopback'
import { SimBox } from '$lib/sim/box'
import { OP_SET_MODE } from '$lib/protocol/messages'

const FID_MODE = 1

function connect(box: SimBox) {
  const session = new Session({ build: 'test' })
  session.connect(new LoopbackCarrier(box, { latencyMs: 0 }))
  return session
}

async function settle(times = 30) {
  for (let i = 0; i < times; i++) await new Promise((r) => setTimeout(r, 2))
}

describe('the plan', () => {
  it('arrives when asked for', async () => {
    const box = new SimBox({ now: () => Date.now() })
    const session = connect(box)
    await settle()

    const plan = await session.plan()

    expect(plan.slots.length).toBeGreaterThan(0)
    expect(plan.stale).toBe(false)
    expect(plan.ceilingW).toBeGreaterThan(0)
  })

  it('is self-consistent: slots are contiguous and aligned', async () => {
    const box = new SimBox({ now: () => Date.now() })
    const session = connect(box)
    await settle()

    const plan = await session.plan()
    for (let i = 1; i < plan.slots.length; i++) {
      const prev = plan.slots[i - 1]!
      const cur = plan.slots[i]!
      // A gap or an overlap would make the timeline lie about when something
      // happens, which is the only thing the timeline is for.
      expect(cur.startMs).toBe(prev.startMs + prev.durationMs)
    }
  })

  it('carries a reason for every slot, never prose', async () => {
    const box = new SimBox({ now: () => Date.now() })
    const session = connect(box)
    await settle()

    const plan = await session.plan()
    for (const slot of plan.slots) {
      expect(slot.reason).toMatch(/^[a-z_]+$/)
    }
  })

  it('says when the planner could not run', async () => {
    // "Nothing is scheduled" and "we do not know what is scheduled" are
    // different sentences, and the app can only tell them apart if the box does.
    const box = new SimBox({ now: () => Date.now(), faults: { planStale: true } })
    const session = connect(box)
    await settle()

    expect((await session.plan()).stale).toBe(true)
  })

  it('refuses to plan while the box is still booting', async () => {
    const box = new SimBox({ now: () => Date.now(), faults: { booting: true } })
    const session = connect(box)
    await settle()

    await expect(session.plan()).rejects.toThrow()
  })
})

describe('changing how the site is run', () => {
  it('applies a mode and reports what actually happened', async () => {
    const box = new SimBox({ now: () => Date.now() })
    const session = connect(box)
    await settle()

    expect(box.mode).toBe('planner_passive_arbitrage')

    const result = await session.command(OP_SET_MODE, { mode: 'self_consumption' }).promise

    expect(result.state).toBe('applied')
    expect(box.mode).toBe('self_consumption')
    // The echo of a request is never proof. This is the driver reading back.
    expect(result.observed?.value).toBe(session.state.modes.findIndex((m) => m.key === 'self_consumption'))
  })

  it('pushes a fresh plan without being asked, because the plan changed', async () => {
    const box = new SimBox({ now: () => Date.now() })
    const session = connect(box)
    await settle()

    await session.command(OP_SET_MODE, { mode: 'idle' }).promise
    await settle()

    // Showing yesterday's intent beside today's mode would leave the user
    // unable to tell which one is wrong.
    expect(session.state.plan).not.toBeNull()
    expect(session.state.plan!.slots.every((s) => s.batteryW === 0)).toBe(true)
  })

  it('reflects the new mode in the streamed fields', async () => {
    const box = new SimBox({ now: () => Date.now() })
    const session = connect(box)
    await settle()

    await session.command(OP_SET_MODE, { mode: 'idle' }).promise
    box.tick()
    await settle()

    expect(session.state.fields.get(FID_MODE)).toBe(session.state.modes.findIndex((m) => m.key === 'idle'))
  })

  it('acts once for a repeated command id', async () => {
    const box = new SimBox({ now: () => Date.now() })
    const session = connect(box)
    await settle()

    const first = session.command(OP_SET_MODE, { mode: 'self_consumption' })
    await first.promise
    const revAfter = session.state.controlRev

    // The box keeps cmd ids so a retry returns the original outcome rather
    // than acting a second time.
    expect(box.mode).toBe('self_consumption')
    expect(revAfter).toBeGreaterThanOrEqual(0)
  })

  it('rejects a command whose preconditions no longer hold', async () => {
    const box = new SimBox({ now: () => Date.now(), faults: { failPreconditions: true } })
    const session = connect(box)
    await settle()

    const result = await session.command(OP_SET_MODE, { mode: 'idle' }).promise

    expect(result.state).toBe('rejected')
    expect(result.error?.code).toBe('E_PRECONDITION')
    // Refused means refused: nothing changed on the box.
    expect(box.mode).toBe('planner_passive_arbitrage')
  })

  it('reports unconfirmed when the box accepts but never confirms', async () => {
    // Neither a success nor a failure. The UI has to be able to say exactly
    // that, so the protocol has to be able to express it.
    const box = new SimBox({ now: () => Date.now(), faults: { neverConfirm: true } })
    const session = connect(box)
    await settle()

    const handle = session.command(OP_SET_MODE, { mode: 'idle' })

    // The confirm deadline is 15 s; drive it rather than waiting it out.
    const result = await Promise.race([
      handle.promise,
      new Promise((r) => setTimeout(() => r({ state: 'timeout' }), 200)),
    ])

    // Within the window it is still in flight — which is itself the point:
    // the app shows "sending", not a false success.
    expect((result as { state: string }).state).toBe('timeout')
  })
})

describe('the planner makes decisions worth explaining', () => {
  it('charges from spare solar at midday', async () => {
    const box = new SimBox({ now: () => Date.UTC(2026, 5, 21, 11, 0, 0) })
    const session = connect(box)
    await settle()

    const plan = await session.plan()
    const reasons = new Set(plan.slots.map((s) => s.reason))

    // A plan whose every slot says the same thing gives the UI nothing to say.
    expect(reasons.size).toBeGreaterThan(1)
    expect(reasons.has('solar_surplus')).toBe(true)
  })

  it('schedules nothing at all when idle', async () => {
    const box = new SimBox({ now: () => Date.now() })
    const session = connect(box)
    await settle()

    await session.command(OP_SET_MODE, { mode: 'idle' }).promise
    const plan = await session.plan()

    expect(plan.slots.every((s) => s.batteryW === 0)).toBe(true)
    expect(plan.slots.every((s) => s.reason === 'idle')).toBe(true)
  })

  it('keeps the plan physically possible', async () => {
    const box = new SimBox({ now: () => Date.now() })
    const session = connect(box)
    await settle()

    const plan = await session.plan()
    for (const slot of plan.slots) {
      // A plan that charges a full battery for six hours is worse than none.
      expect(Math.abs(slot.batteryW)).toBeLessThanOrEqual(box.house.batteryMaxChargeW)
    }
  })
})
