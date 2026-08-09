/* The charger's sheet, over a real wire.
 *
 * A Session, a SimBox with its car on the cable, and the panel opened the
 * way a thumb opens it: the hero's own event. The clock is held inside the
 * simulated evening so the house is charging while the panel reads it.
 */

import { describe, it, expect, vi, afterEach } from 'vitest'
import { render } from '@testing-library/svelte'
import Now from './Now.svelte'
import EvPanel from './EvPanel.svelte'
import { SiteStore } from '$lib/state/site.svelte'
import { LoopbackCarrier } from '$lib/carrier/loopback'
import { SimBox } from '$lib/sim/box'
import { ROLE_VIEWER } from '$lib/protocol/messages'
import { localInputToUtcMinutes, localClock } from '$lib/format/ev'

// The ceremony, played by a hand. The sim's configure tier refuses without
// a step-up exactly as the box does; what is under test is that one save
// runs it once and the refusal prose reaches the screen when it fails.
vi.mock('$lib/identity/stepup', () => ({
  stepUp: vi.fn(async () => 'done'),
  stepUpHelp: () => 'Your passkey did not answer. Nothing was changed.',
}))

const CHARGING_EVENING = Date.UTC(2026, 6, 15, 18, 30, 0)

async function streaming(): Promise<SiteStore> {
  const site = new SiteStore('test')
  site.connect(new LoopbackCarrier(new SimBox({ now: () => Date.now() }), { latencyMs: 5 }))
  for (let i = 0; i < 100 && site.session.phase !== 'streaming'; i++) {
    await vi.advanceTimersByTimeAsync(10)
  }
  expect(site.session.phase).toBe('streaming')
  return site
}

describe('the charger behind its bubble', () => {
  afterEach(() => {
    document.body.replaceChildren()
    vi.useRealTimers()
    vi.restoreAllMocks()
  })

  it('opens on the hero event and reads the box', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(CHARGING_EVENING)

    const site = await streaming()
    render(Now, { props: { site } })
    await vi.advanceTimersByTimeAsync(50)

    const hero = document.querySelector('ftw-energy-flow')!
    expect(hero).not.toBeNull()
    hero.dispatchEvent(
      new CustomEvent('ftw-planet-click', { detail: { role: 'ev', id: 'ev' }, bubbles: true })
    )
    await vi.advanceTimersByTimeAsync(500)

    const sheet = document.querySelector('[role="dialog"]')
    expect(sheet, 'the tap opened nothing').not.toBeNull()
    expect(sheet!.textContent).toMatch(/Charging at 7\.\d kW/)
    expect(sheet!.textContent).toContain('kWh this session')
    expect(sheet!.textContent).toContain('Ready by')
    expect(sheet!.textContent).toMatch(/Charging ahead/)
    // The wire's sign and UTC conventions must not leak through.
    expect(sheet!.textContent).not.toMatch(/-\d/)
  })

  it('ignores taps on every other planet', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(CHARGING_EVENING)

    const site = await streaming()
    render(Now, { props: { site } })
    await vi.advanceTimersByTimeAsync(50)

    document
      .querySelector('ftw-energy-flow')!
      .dispatchEvent(new CustomEvent('ftw-planet-click', { detail: { role: 'battery' } }))
    await vi.advanceTimersByTimeAsync(100)

    expect(document.querySelector('[role="dialog"]')).toBeNull()
  })

  it('closes on Escape and on the backdrop', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(CHARGING_EVENING)

    const site = await streaming()
    render(Now, { props: { site } })
    await vi.advanceTimersByTimeAsync(50)

    const open = () => {
      document
        .querySelector('ftw-energy-flow')!
        .dispatchEvent(new CustomEvent('ftw-planet-click', { detail: { role: 'ev' } }))
    }

    open()
    await vi.advanceTimersByTimeAsync(100)
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))
    await vi.advanceTimersByTimeAsync(50)
    expect(document.querySelector('[role="dialog"]')).toBeNull()

    open()
    await vi.advanceTimersByTimeAsync(100)
    ;(document.querySelector('.backdrop') as HTMLElement).click()
    await vi.advanceTimersByTimeAsync(50)
    expect(document.querySelector('[role="dialog"]')).toBeNull()
  })

  it('keeps asking while open, so the panel ages honestly', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(CHARGING_EVENING)

    const site = await streaming()
    const asked = vi.spyOn(site, 'api')
    render(EvPanel, { props: { site, onclose: () => {} } })

    for (let i = 0; i < 50 && asked.mock.calls.length === 0; i++) {
      await vi.advanceTimersByTimeAsync(20)
    }
    await vi.advanceTimersByTimeAsync(500)
    const afterMount = asked.mock.calls.length
    expect(afterMount).toBeGreaterThan(0)

    // Two minutes on an unbroken wire: the minute epoch in the ask name
    // must have sent at least one fresh ask.
    await vi.advanceTimersByTimeAsync(120_000)
    expect(
      asked.mock.calls.length,
      'the panel never asked again on a wire that never dropped'
    ).toBeGreaterThan(afterMount)
  })

  it('saves a schedule in one PUT and one ceremony, and repaints from the box', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(CHARGING_EVENING)

    const box = new SimBox({ now: () => Date.now() })
    const site = new SiteStore('test')
    site.connect(new LoopbackCarrier(box, { latencyMs: 5 }))
    for (let i = 0; i < 100 && site.session.phase !== 'streaming'; i++) {
      await vi.advanceTimersByTimeAsync(10)
    }

    const { stepUp } = await import('$lib/identity/stepup')
    vi.mocked(stepUp).mockClear()

    render(EvPanel, { props: { site, onclose: () => {} } })
    await vi.advanceTimersByTimeAsync(500)

    const change = [...document.querySelectorAll('button')].find(
      (b) => b.textContent?.trim() === 'Change'
    )!
    expect(change, 'no way in to the editor for an owner').toBeDefined()
    change.click()
    await vi.advanceTimersByTimeAsync(50)

    const time = document.querySelector('input[type="time"]') as HTMLInputElement
    time.value = '08:00'
    time.dispatchEvent(new Event('input', { bubbles: true }))

    // Weekdays, the way a thumb makes them: the every-day schedule shows
    // all seven chips on, and turning Saturday and Sunday off is the whole
    // gesture. (The draft holds all seven bits for exactly this reason —
    // toggling a day off a raw zero mask would have meant "only that day".)
    for (const day of ['Sat', 'Sun']) {
      ;[...document.querySelectorAll<HTMLButtonElement>('button.chip')]
        .find((b) => b.textContent?.trim() === day)!
        .click()
      await vi.advanceTimersByTimeAsync(10)
    }

    const put = vi.spyOn(box.api, 'serve')
    ;[...document.querySelectorAll('button')]
      .find((b) => b.textContent?.trim() === 'Save schedule')!
      .click()
    await vi.advanceTimersByTimeAsync(1_000)

    // One ceremony for the whole draft, not one per field.
    expect(vi.mocked(stepUp).mock.calls.length).toBe(1)

    const saved = put.mock.calls.find(
      (c) => c[0].method === 'PUT' && c[0].path.endsWith('/schedule') && c[0].stepUp
    )
    expect(saved, 'no stepped-up PUT reached the box').toBeDefined()
    const bodyOnWire = JSON.parse(new TextDecoder().decode(saved![0].body!))
    expect(bodyOnWire.time_of_day_min_utc).toBe(localInputToUtcMinutes('08:00'))
    expect(bodyOnWire.days).toBe(0b0011111)
    expect(bodyOnWire.recurring).toBe(true)

    // The panel reread the box rather than trusting its own draft.
    expect(document.body.textContent).toContain(`Ready by ${localClock(bodyOnWire.time_of_day_min_utc)}`)
    expect(document.body.textContent).toContain('weekdays')
  })

  it('shows a viewer the schedule but never the pen', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(CHARGING_EVENING)

    const box = new SimBox({ now: () => Date.now(), role: ROLE_VIEWER })
    const site = new SiteStore('test')
    site.connect(new LoopbackCarrier(box, { latencyMs: 5 }))
    for (let i = 0; i < 100 && site.session.phase !== 'streaming'; i++) {
      await vi.advanceTimersByTimeAsync(10)
    }

    render(EvPanel, { props: { site, onclose: () => {} } })
    await vi.advanceTimersByTimeAsync(500)

    expect(document.body.textContent).toContain('Ready by')
    expect([...document.querySelectorAll('button')].map((b) => b.textContent?.trim())).not.toContain(
      'Change'
    )
  })

  it('says what happened when the ceremony fails, and changes nothing', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(CHARGING_EVENING)

    const box = new SimBox({ now: () => Date.now() })
    const site = new SiteStore('test')
    site.connect(new LoopbackCarrier(box, { latencyMs: 5 }))
    for (let i = 0; i < 100 && site.session.phase !== 'streaming'; i++) {
      await vi.advanceTimersByTimeAsync(10)
    }

    const stepup = await import('$lib/identity/stepup')
    vi.mocked(stepup.stepUp).mockResolvedValueOnce('unavailable')

    render(EvPanel, { props: { site, onclose: () => {} } })
    await vi.advanceTimersByTimeAsync(500)
    const before = document.body.textContent

    ;[...document.querySelectorAll('button')]
      .find((b) => b.textContent?.trim() === 'Change')!
      .click()
    await vi.advanceTimersByTimeAsync(50)
    ;[...document.querySelectorAll('button')]
      .find((b) => b.textContent?.trim() === 'Save schedule')!
      .click()
    await vi.advanceTimersByTimeAsync(1_000)

    expect(document.body.textContent).toContain('Nothing was changed')
    // Cancel out and the schedule reads exactly as before the attempt.
    ;[...document.querySelectorAll('button')]
      .find((b) => b.textContent?.trim() === 'Cancel')!
      .click()
    await vi.advanceTimersByTimeAsync(200)
    expect(document.body.textContent).toContain(
      before!.match(/Ready by [^·]+/)![0].trim()
    )
  })

  it('removes a schedule and says the absence honestly', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(CHARGING_EVENING)

    const box = new SimBox({ now: () => Date.now() })
    const site = new SiteStore('test')
    site.connect(new LoopbackCarrier(box, { latencyMs: 5 }))
    for (let i = 0; i < 100 && site.session.phase !== 'streaming'; i++) {
      await vi.advanceTimersByTimeAsync(10)
    }

    render(EvPanel, { props: { site, onclose: () => {} } })
    await vi.advanceTimersByTimeAsync(500)
    expect(document.body.textContent).toContain('Ready by')
    ;[...document.querySelectorAll('button')]
      .find((b) => b.textContent?.trim() === 'Change')!
      .click()
    await vi.advanceTimersByTimeAsync(50)
    ;[...document.querySelectorAll('button')]
      .find((b) => b.textContent?.trim() === 'Remove')!
      .click()
    await vi.advanceTimersByTimeAsync(1_000)

    // No sentence claims a schedule; the offer to set one takes its place.
    expect(document.body.textContent).not.toContain('Ready by')
    expect(document.body.textContent).toContain('Set a charging schedule')
  })

  it('keeps its facts through a drop and asks again on its own when the wire returns', async () => {
    // The wire's own state is the freshness band's sentence, above the
    // sheet — the panel neither repeats it nor clears what it read. What
    // the panel owes is the heal: fresh asks the moment the box is back.
    vi.useFakeTimers()
    vi.setSystemTime(CHARGING_EVENING)

    const box = new SimBox({ now: () => Date.now() })
    const carrier = new LoopbackCarrier(box, { latencyMs: 5 })
    const site = new SiteStore('test')
    site.connect(carrier)
    for (let i = 0; i < 100 && site.session.phase !== 'streaming'; i++) {
      await vi.advanceTimersByTimeAsync(10)
    }

    const asked = vi.spyOn(site, 'api')
    render(EvPanel, { props: { site, onclose: () => {} } })
    await vi.advanceTimersByTimeAsync(500)
    expect(document.body.textContent).toMatch(/Charging at/)

    carrier.drop('wire died')
    await vi.advanceTimersByTimeAsync(5_000)
    expect(document.body.textContent, 'the charger vanished instead of aging').toMatch(
      /Charging at/
    )
    const whileDown = asked.mock.calls.length

    carrier.restore()
    await vi.advanceTimersByTimeAsync(5_000)
    expect(site.session.phase).toBe('streaming')
    expect(
      asked.mock.calls.length,
      'nothing asked again once the box was back'
    ).toBeGreaterThan(whileDown)
  })
})
