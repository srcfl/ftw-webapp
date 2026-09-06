/* Restart, from the tap to the box's own process.

 * Real Session, real SimBox, real loopback carrier. The passkey ceremony is
 * stubbed at the module the app calls, so the round trip that discovers the
 * step-up still happens over the wire. A restart is configure: owner, with
 * a ceremony, and a confirm before the process is asked to come back.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render } from '@testing-library/svelte'
import Restart from './Restart.svelte'
import { SiteStore } from '$lib/state/site.svelte'
import { LoopbackCarrier } from '$lib/carrier/loopback'
import { SimBox } from '$lib/sim/box'
import { ROLE_VIEWER } from '$lib/protocol/messages'

vi.mock('$lib/identity/stepup', () => ({
  stepUp: vi.fn(async () => 'done'),
  stepUpHelp: () => 'needs a ceremony',
}))

const NOON = new Date(2026, 6, 15, 12, 0, 0).getTime()

function open(role?: string) {
  const box = new SimBox({ now: () => Date.now(), ...(role ? { role } : {}) })
  const site = new SiteStore('test')
  site.connect(new LoopbackCarrier(box, { latencyMs: 0 }))
  return { box, site }
}

function text(): string {
  return (document.body.textContent ?? '').replace(/\s+/g, ' ')
}

function buttonSaying(pattern: RegExp): HTMLButtonElement | undefined {
  return [...document.querySelectorAll('button')].find((b) =>
    pattern.test(b.textContent ?? '')
  ) as HTMLButtonElement | undefined
}

describe('restart, from the phone', () => {
  beforeEach(async () => {
    const { stepUp } = await import('$lib/identity/stepup')
    vi.mocked(stepUp).mockResolvedValue('done')
  })

  afterEach(() => {
    document.body.replaceChildren()
    vi.useRealTimers()
    vi.restoreAllMocks()
  })

  it('asks first, then the box is told once, with one ceremony', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(NOON)
    const { box, site } = open()
    const stepup = await import('$lib/identity/stepup')

    render(Restart, { props: { site } })
    await vi.advanceTimersByTimeAsync(500)

    expect(box.api.restarts, 'drew a control that fired on sight').toBe(0)
    buttonSaying(/Restart this box/)!.click()
    await vi.advanceTimersByTimeAsync(10)

    expect(box.api.restarts, 'the confirm itself restarted the box').toBe(0)
    expect(text()).toMatch(/Devices keep running on their own/)

    vi.mocked(stepup.stepUp).mockClear()
    buttonSaying(/Restart now/)!.click()
    await vi.advanceTimersByTimeAsync(500)

    expect(box.api.restarts).toBe(1)
    expect(vi.mocked(stepup.stepUp), 'a restart cost more than one ceremony').toHaveBeenCalledOnce()
    expect(text()).toMatch(/coming back on its own/)
  })

  it('cancels without asking the box', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(NOON)
    const { box, site } = open()

    render(Restart, { props: { site } })
    await vi.advanceTimersByTimeAsync(500)
    buttonSaying(/Restart this box/)!.click()
    await vi.advanceTimersByTimeAsync(10)
    buttonSaying(/Cancel/)!.click()
    await vi.advanceTimersByTimeAsync(10)

    expect(box.api.restarts).toBe(0)
    expect(buttonSaying(/Restart this box/)).toBeDefined()
  })

  it('shows a viewer nothing, not a button their box would refuse', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(NOON)
    const { site } = open(ROLE_VIEWER)

    render(Restart, { props: { site } })
    await vi.advanceTimersByTimeAsync(500)

    expect(text()).not.toMatch(/Restart/i)
    expect(document.querySelectorAll('button')).toHaveLength(0)
  })

  it('draws nothing until the box has said something', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(NOON)
    const site = new SiteStore('test')

    render(Restart, { props: { site } })
    await vi.advanceTimersByTimeAsync(200)

    expect(document.querySelectorAll('button')).toHaveLength(0)
    expect(text()).not.toMatch(/Restart/i)
  })
})
