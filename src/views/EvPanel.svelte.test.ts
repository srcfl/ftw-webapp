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
import { ApiError } from '$lib/protocol/session'
import { CAP_API_PASSTHROUGH } from '$lib/protocol/contract'
import {
  ROLE_VIEWER,
  OP_LOADPOINT_HOLD,
  OP_LOADPOINT_BOOST,
  OP_LOADPOINT_SOC_SET,
  OP_LOADPOINT_SURPLUS_ONLY_SET,
} from '$lib/protocol/messages'
import { FID } from '$lib/format/explanation'
import { wireBytes } from '$lib/protocol/frame'
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

  it('does not open the charger for every other planet', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(CHARGING_EVENING)

    const site = await streaming()
    render(Now, { props: { site } })
    await vi.advanceTimersByTimeAsync(50)

    document
      .querySelector('ftw-energy-flow')!
      .dispatchEvent(new CustomEvent('ftw-planet-click', { detail: { role: 'battery' } }))
    await vi.advanceTimersByTimeAsync(100)

    // The battery opens its live line, not the charger's controls.
    const sheet = document.querySelector('[role="dialog"]')
    expect(sheet?.getAttribute('aria-label')).not.toBe('EV charger')
  })

  it('preserves a car-bubble tap before capabilities return and fills the same sheet when connected', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(CHARGING_EVENING)
    const site = await streaming()
    const connected = site.session
    site.session = { ...connected, phase: 'idle', caps: new Set() }
    const api = vi.spyOn(site, 'api')
    render(Now, { props: { site } })
    await vi.advanceTimersByTimeAsync(50)
    document.querySelector('ftw-energy-flow')!.dispatchEvent(
      new CustomEvent('ftw-planet-click', { detail: { role: 'ev' }, bubbles: true })
    )
    await vi.advanceTimersByTimeAsync(50)
    const sheet = document.querySelector('[role="dialog"]')!
    expect(sheet.textContent).toContain('Connecting to your box.')
    expect(api.mock.calls.filter(([req]) => req.path === '/api/loadpoints')).toHaveLength(0)
    site.session = connected
    await vi.advanceTimersByTimeAsync(500)
    expect(document.querySelector('[role="dialog"]')).toBe(sheet)
    expect(sheet.textContent).toMatch(/Charging at 7\.\d kW/)
    expect(sheet.textContent).not.toContain('Connecting to your box.')
  })

  it('explains a known box without charging API support instead of ignoring the tap', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(CHARGING_EVENING)
    const connected = (await streaming()).session
    const site = new SiteStore('older-box')
    site.session = { ...connected, caps: new Set([...connected.caps].filter(cap => cap !== CAP_API_PASSTHROUGH)) }
    const api = vi.spyOn(site, 'api')
    render(Now, { props: { site } })
    await vi.advanceTimersByTimeAsync(50)
    document.querySelector('ftw-energy-flow')!.dispatchEvent(
      new CustomEvent('ftw-planet-click', { detail: { role: 'ev' }, bubbles: true })
    )
    await vi.advanceTimersByTimeAsync(50)
    expect(document.querySelector('[role="dialog"]')?.textContent).toContain('Charging controls are not available from this box yet.')
    expect(document.querySelector('[role="dialog"]')?.textContent).toContain('Open the box’s own page')
    expect(api.mock.calls.filter(([req]) => req.path === '/api/loadpoints')).toHaveLength(0)
  })

  it('recovers from a busy first read after opening the car bubble without claiming setup is missing', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(CHARGING_EVENING)
    const site = await streaming()
    const api = site.api.bind(site)
    let chargerReads = 0
    vi.spyOn(site, 'api').mockImplementation((req) => {
      if (req.path === '/api/loadpoints' && ++chargerReads <= 2) {
        return Promise.reject(new ApiError({ code: 'E_UNAVAILABLE', retryable: true, args: { reason: 'busy' } }))
      }
      return api(req)
    })
    const command = vi.spyOn(site, 'command')
    render(Now, { props: { site } })
    await vi.advanceTimersByTimeAsync(50)
    document.querySelector('ftw-energy-flow')!.dispatchEvent(
      new CustomEvent('ftw-planet-click', { detail: { role: 'ev' }, bubbles: true })
    )
    await vi.advanceTimersByTimeAsync(500)
    const sheet = document.querySelector('[role="dialog"]')!
    expect(sheet.textContent).toContain('Your box is busy')
    expect(sheet.textContent).not.toMatch(/not set up|Connect your first charger/)
    await vi.advanceTimersByTimeAsync(12_000)
    expect(sheet.textContent).toMatch(/Charging at 7\.\d kW/)
    expect(sheet.textContent).not.toContain('Your box is busy')
    expect(command).not.toHaveBeenCalled()
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
      (b) => b.textContent?.trim() === 'Change goal'
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
    document.querySelector('input[type="time"]')!.dispatchEvent(new Event('change', { bubbles: true }))
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
    expect((document.querySelector('input[type="time"]') as HTMLInputElement).value).toBe('08:00')
    expect(document.body.textContent).toContain('Schedule saved')
  })

  it('confirms a saved goal while a long replan hides old windows, then shows the new plan without another write', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(CHARGING_EVENING)
    const box = new SimBox({ now: () => Date.now() })
    const site = new SiteStore('test')
    site.connect(new LoopbackCarrier(box, { latencyMs: 5 }))
    for (let i = 0; i < 100 && site.session.phase !== 'streaming'; i++) await vi.advanceTimersByTimeAsync(10)
    let pending = false
    let outdated = false
    let writes = 0
    const serve = box.api.serve.bind(box.api)
    vi.spyOn(box.api, 'serve').mockImplementation(req => {
      const answer = serve(req)
      if (req.method === 'PUT' && req.path.endsWith('/schedule') && req.stepUp && 'status' in answer && answer.status === 200) {
        pending = true
        writes++
      }
      if ('body' in answer && (req.path === '/api/loadpoints' || req.path === '/api/mpc/plan')) {
        const payload = JSON.parse(new TextDecoder().decode(answer.body))
        if (req.path === '/api/loadpoints') for (const lp of payload.loadpoints) {
          lp.plan_pending = pending; lp.plan_outdated = outdated
          lp.plan_windows = [{ start_ms: CHARGING_EVENING, end_ms: CHARGING_EVENING + 3_600_000, wh: 4600 }]
        }
        else payload.meta = { ...payload.meta, replanning: pending, outdated }
        answer.body = wireBytes(new TextEncoder().encode(JSON.stringify(payload)))
      }
      return answer
    })
    render(EvPanel, { props: { site, onclose: () => {} } })
    await vi.advanceTimersByTimeAsync(500)
    expect(document.body.textContent).toContain('Charging ahead')
    ;[...document.querySelectorAll('button')].find(b => b.textContent?.trim() === 'Change goal')!.click()
    await vi.advanceTimersByTimeAsync(20)
    const target = document.querySelector('[aria-label="Target charge, percent"]') as HTMLInputElement
    target.value = '85'
    target.dispatchEvent(new Event('input', { bubbles: true }))
    target.dispatchEvent(new Event('change', { bubbles: true }))
    await vi.advanceTimersByTimeAsync(1_000)
    expect(document.body.textContent).toContain('Schedule saved.')
    expect(document.body.textContent).toContain('Goal saved. Updating the plan…')
    expect(document.body.textContent).not.toContain('Charging ahead')
    expect(document.body.textContent).toMatch(/Charging at 7\.\d kW/)
    await vi.advanceTimersByTimeAsync(45_000)
    expect(document.body.textContent).toContain('Goal saved. Updating the plan…')
    expect(document.body.textContent).not.toContain('Try again')
    expect(writes).toBe(1)
    pending = false
    outdated = true
    await vi.advanceTimersByTimeAsync(6_000)
    expect(document.body.textContent).toContain('Charging times are unavailable. Your settings are saved.')
    expect(document.body.textContent).not.toContain('Updating the plan')
    expect(document.body.textContent).not.toContain('Charging ahead')
    expect(document.body.textContent).toMatch(/Charging at 7\.\d kW/)
    expect(writes).toBe(1)
    outdated = false
    await vi.advanceTimersByTimeAsync(6_000)
    expect(document.body.textContent).not.toContain('Updating the plan')
    expect(document.body.textContent).not.toContain('Charging times are unavailable.')
    expect(document.body.textContent).toContain('Charging ahead')
    expect(writes).toBe(1)
    pending = true // A later routine replan is not another save by this owner.
    await vi.advanceTimersByTimeAsync(6_000)
    expect(document.body.textContent).toContain('Updating the charging plan…')
    expect(document.body.textContent).not.toContain('Goal saved. Updating the plan…')
    expect(writes).toBe(1)
  })

  it('keeps a successful save confirmed when its status read fails and recovers without rewriting', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(CHARGING_EVENING)
    const site = await streaming()
    render(EvPanel, { props: { site, onclose: () => {} } })
    await vi.advanceTimersByTimeAsync(500)
    let failRead = false
    let writes = 0
    const api = site.api.bind(site)
    vi.spyOn(site, 'api').mockImplementation(async req => {
      if (failRead && req.path === '/api/loadpoints') throw new ApiError({ code: 'E_UNAVAILABLE', retryable: true, args: { reason: 'busy' } })
      const answer = await api(req)
      if (req.method === 'PUT' && answer.status === 200) { failRead = true; writes++ }
      return answer
    })
    ;[...document.querySelectorAll('button')].find(b => b.textContent?.trim() === 'Change goal')!.click()
    await vi.advanceTimersByTimeAsync(20)
    document.querySelector('input[type="time"]')!.dispatchEvent(new Event('change', { bubbles: true }))
    await vi.advanceTimersByTimeAsync(1_000)
    expect(document.body.textContent).toContain('Schedule saved. Current charging status is unavailable.')
    expect(document.body.textContent).not.toContain('Try again')
    expect(writes).toBe(1)
    failRead = false
    await vi.advanceTimersByTimeAsync(6_000)
    expect(document.body.textContent).toContain('Schedule saved.')
    expect(document.body.textContent).not.toContain('Current charging status is unavailable.')
    expect(writes).toBe(1)
  })

  it('serializes schedule edits while an earlier save is slow', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(CHARGING_EVENING)
    const site = await streaming()
    render(EvPanel, { props: { site, onclose: () => {} } })
    await vi.advanceTimersByTimeAsync(500)
    ;[...document.querySelectorAll('button')].find(b => b.textContent?.trim() === 'Change goal')!.click()
    await vi.advanceTimersByTimeAsync(20)
    const original = site.api.bind(site)
    let release!: () => void
    const gate = new Promise<void>(r => { release = r })
    let active = 0, peak = 0
    const sent: number[] = []
    vi.spyOn(site, 'api').mockImplementation(async request => {
      if (request.method !== 'PUT') return original(request)
      const body = JSON.parse(new TextDecoder().decode(request.body ?? undefined))
      if (!request.stepUp) {
        active++; peak = Math.max(peak, active); sent.push(body.soc)
        if (sent.length === 1) await gate
      }
      try { return await original(request) } finally { if (!request.stepUp) active-- }
    })
    const target = document.querySelector<HTMLInputElement>('[aria-label="Target charge, percent"]')!
    target.value = '70'; target.dispatchEvent(new Event('input', { bubbles: true })); target.dispatchEvent(new Event('change', { bubbles: true }))
    await vi.advanceTimersByTimeAsync(500)
    target.value = '90'; target.dispatchEvent(new Event('input', { bubbles: true })); target.dispatchEvent(new Event('change', { bubbles: true }))
    await vi.advanceTimersByTimeAsync(500)
    expect(sent).toEqual([0.7])
    expect(document.body.textContent).toContain('Applying schedule')
    release(); await vi.advanceTimersByTimeAsync(2000)
    expect(sent).toEqual([0.7, 0.9])
    expect(peak).toBe(1)
    expect(target.value).toBe('90')
    expect(document.body.textContent).toContain('Schedule saved')
  })

  it('does not erase a new SOC drag when an earlier readback arrives', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(CHARGING_EVENING)
    const site = await streaming()
    render(EvPanel, { props: { site, onclose: () => {} } })
    await vi.advanceTimersByTimeAsync(500)
    const original = site.api.bind(site)
    let release!: () => void
    const gate = new Promise<void>(r => { release = r })
    vi.spyOn(site, 'api').mockImplementation(async request => {
      if (request.method === 'GET' && request.path === '/api/loadpoints') await gate
      return original(request)
    })
    const soc = document.querySelector<HTMLInputElement>('[aria-label="Car\'s current charge, percent"]')!
    soc.value = '30'; soc.dispatchEvent(new Event('input', { bubbles: true })); soc.dispatchEvent(new Event('change', { bubbles: true }))
    await vi.advanceTimersByTimeAsync(100)
    soc.value = '40'; soc.dispatchEvent(new Event('input', { bubbles: true }))
    release(); await vi.advanceTimersByTimeAsync(1000)
    expect(soc.value).toBe('40')
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
      'Change goal'
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
      .find((b) => b.textContent?.trim() === 'Change goal')!
      .click()
    await vi.advanceTimersByTimeAsync(50)
    document.querySelector('input[type="time"]')!.dispatchEvent(new Event('change', { bubbles: true }))
    await vi.advanceTimersByTimeAsync(1_000)

    expect(document.body.textContent).toContain('Nothing was changed')
    // Cancel out and the schedule reads exactly as before the attempt.
    ;[...document.querySelectorAll('button')]
      .find((b) => b.textContent?.trim() === 'Close goal settings')!
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
      .find((b) => b.textContent?.trim() === 'Change goal')!
      .click()
    await vi.advanceTimersByTimeAsync(50)
    ;[...document.querySelectorAll('button')]
      .find((b) => b.textContent?.trim() === 'Remove')!
      .click()
    await vi.advanceTimersByTimeAsync(1_000)

    // No sentence claims a schedule; the offer to set one takes its place.
    expect(document.body.textContent).not.toContain('Ready by')
    expect(document.body.textContent).toContain('Set a ready time')
    // Accept the shown proposal without moving either control away and back.
    ;[...document.querySelectorAll('button')].find(b => b.textContent?.trim() === 'Set a ready time')!.click()
    await vi.advanceTimersByTimeAsync(50)
    const use = [...document.querySelectorAll('button')].find(b => /^Use \d+ % by 07:00$/.test(b.textContent?.trim() ?? ''))!
    expect(use?.textContent?.trim()).toBe('Use 80 % by 07:00')
    const expectedSoc = Number(use.textContent!.trim().match(/^Use (\d+)/)![1]) / 100
    const put = vi.spyOn(box.api, 'serve')
    use.click()
    await vi.advanceTimersByTimeAsync(1000)
    const writes = put.mock.calls.filter(c => c[0].method === 'PUT' && c[0].path.endsWith('/schedule') && c[0].stepUp)
    expect(writes).toHaveLength(1)
    const selected = JSON.parse(new TextDecoder().decode(writes[0]![0].body!))
    expect(selected.soc).toBe(expectedSoc)
    expect(selected.time_of_day_min_utc).toBe(localInputToUtcMinutes('07:00'))
    expect(document.body.textContent).toContain('Schedule saved')
  })

  it.each([false, true])('confirms Remove during a pending save replan even when its reread fails: %s', async failRead => {
    vi.useFakeTimers()
    vi.setSystemTime(CHARGING_EVENING)
    const site = await streaming()
    const api = site.api.bind(site)
    let deleted = false, pending = true
    const asked = vi.spyOn(site, 'api').mockImplementation(async req => {
      if (deleted && failRead && req.path === '/api/loadpoints') throw new Error('read unavailable')
      const answer = await api(req)
      if (req.method === 'DELETE' && answer.status === 200) deleted = true
      if (req.path === '/api/loadpoints') {
        const payload = JSON.parse(new TextDecoder().decode(answer.body))
        Object.assign(payload.loadpoints[0], { plan_pending: pending, plan_outdated: pending })
        return { ...answer, body: new TextEncoder().encode(JSON.stringify(payload)) }
      }
      return answer
    })
    render(EvPanel, { props: { site, onclose: () => {} } })
    await vi.advanceTimersByTimeAsync(500)
    ;[...document.querySelectorAll('button')].find(b => b.textContent?.trim() === 'Change goal')!.click()
    await vi.advanceTimersByTimeAsync(20)
    const target = document.querySelector<HTMLInputElement>('[aria-label="Target charge, percent"]')!
    target.value = '85'; target.dispatchEvent(new Event('input', { bubbles: true })); target.dispatchEvent(new Event('change', { bubbles: true }))
    await vi.advanceTimersByTimeAsync(1_000)
    expect(document.body.textContent).toContain('Goal saved. Updating the plan…')
    ;[...document.querySelectorAll('button')].find(b => b.textContent?.trim() === 'Remove')!.click()
    await vi.advanceTimersByTimeAsync(0)
    expect.soft(document.body.textContent).toContain('Removing goal…')
    await vi.advanceTimersByTimeAsync(1_000)
    expect.soft(document.body.textContent).toContain(failRead ? 'Goal removed. Current charging status is unavailable.' : 'Goal removed.')
    expect(document.body.textContent).not.toContain('Goal saved')
    expect(document.body.textContent).not.toContain('Ready by')
    expect(document.body.textContent).toContain('Set a ready time')
    expect(document.body.textContent).not.toContain('Try again')
    failRead = false
    await vi.advanceTimersByTimeAsync(6_000)
    expect(document.body.textContent).toContain('Updating the charging plan…')
    expect(document.body.textContent).not.toContain('Goal saved')
    pending = false
    await vi.advanceTimersByTimeAsync(6_000)
    expect(document.body.textContent).toContain('Goal removed.')
    expect(document.body.textContent).not.toContain('Current charging status is unavailable.')
    expect(document.body.textContent).not.toContain('Goal saved')
    expect(asked.mock.calls.filter(([req]) => req.method === 'DELETE' && req.stepUp)).toHaveLength(1)
  })

  it('charges now through the door, and the whole household says so', async () => {
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

    const chargeNow = [...document.querySelectorAll('button')].find(
      (b) => b.textContent?.trim() === 'Charge now'
    )!
    expect(chargeNow, 'no way to charge now for an owner with a plugged car').toBeDefined()
    chargeNow.click()
    await vi.advanceTimersByTimeAsync(1_000)

    // The panel repainted from the box: the hold is on at the charger's own
    // ceiling, the button turned into its opposite, and the sentence says
    // what happens now.
    expect(document.body.textContent).toMatch(/Charging at 11 kW/)
    expect(
      [...document.querySelectorAll('button')].some((b) => b.textContent?.trim() === 'Return to plan')
    ).toBe(true)
    expect(document.body.textContent).toContain('Return to plan restores')

    // And the 1 Hz stream tells the same story — one household, whichever
    // surface asks.
    box.tick()
    await vi.advanceTimersByTimeAsync(100)
    expect(site.session.fields.get(FID.EV_W)).toBe(11000)
  })

  it('stops the hold and hands the charger back to the plan', async () => {
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
    ;[...document.querySelectorAll('button')]
      .find((b) => b.textContent?.trim() === 'Charge now')!
      .click()
    await vi.advanceTimersByTimeAsync(1_000)
    ;[...document.querySelectorAll('button')]
      .find((b) => b.textContent?.trim() === 'Return to plan')!
      .click()
    await vi.advanceTimersByTimeAsync(1_000)

    expect(document.body.textContent).toContain('The plan decides when to charge')
    expect(
      [...document.querySelectorAll('button')].some((b) => b.textContent?.trim() === 'Charge now')
    ).toBe(true)
  })

  it('never draws the button for a viewer', async () => {
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

    expect(
      [...document.querySelectorAll('button')].map((b) => b.textContent?.trim())
    ).not.toContain('Charge now')
  })

  it('reports a refusal in a sentence and repaints from the box', async () => {
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

    box.faults = { ...box.faults, failPreconditions: true }
    ;[...document.querySelectorAll('button')]
      .find((b) => b.textContent?.trim() === 'Charge now')!
      .click()
    await vi.advanceTimersByTimeAsync(1_000)

    expect(document.body.textContent).toContain('Your home changed while that was sending')
    // Nothing moved: the charger still reads as the plan's, not held.
    expect(
      [...document.querySelectorAll('button')].some((b) => b.textContent?.trim() === 'Charge now')
    ).toBe(true)
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
    expect(document.body.textContent).toContain('The last reading is out of date')
    expect(document.querySelector('[aria-label="Car\'s current charge, percent"]')).not.toBeNull()
    const whileDown = asked.mock.calls.length

    carrier.restore()
    await vi.advanceTimersByTimeAsync(5_000)
    expect(site.session.phase).toBe('streaming')
    expect(
      asked.mock.calls.length,
      'nothing asked again once the box was back'
    ).toBeGreaterThan(whileDown)
  })

  /** The panel open for an owner with the car on the cable. */
  async function openedFor(role?: string): Promise<{ box: SimBox; site: SiteStore }> {
    const box = new SimBox({ now: () => Date.now(), ...(role ? { role } : {}) })
    const site = new SiteStore('test')
    site.connect(new LoopbackCarrier(box, { latencyMs: 5 }))
    for (let i = 0; i < 100 && site.session.phase !== 'streaming'; i++) {
      await vi.advanceTimersByTimeAsync(10)
    }
    render(EvPanel, { props: { site, onclose: () => {} } })
    await vi.advanceTimersByTimeAsync(500)
    return { box, site }
  }

  const button = (label: string) =>
    [...document.querySelectorAll<HTMLButtonElement>('button')].find(
      (b) => b.textContent?.trim() === label
    )

  const slider = () => document.querySelector<HTMLInputElement>('input[aria-label="Charging current"]')
  const socSlider = () =>
    document.querySelector<HTMLInputElement>('input[aria-label="Car\'s current charge, percent"]')
  const pvOnly = () => document.querySelector<HTMLInputElement>('input[role="switch"]')

  /** Move a thumb the way a browser reports it, and let go of it. */
  function slideTo(s: HTMLInputElement, to: number): void {
    s.value = String(to)
    s.dispatchEvent(new Event('input', { bubbles: true }))
  }
  function release(s: HTMLInputElement): void {
    s.dispatchEvent(new Event('change', { bubbles: true }))
  }
  const slide = (to: number) => slideTo(slider()!, to)

  it("offers the charger's own range of current, at its ceiling by default", async () => {
    vi.useFakeTimers()
    vi.setSystemTime(CHARGING_EVENING)
    await openedFor()

    expect(slider()).toBeNull()
    expect(document.body.textContent).toContain('Starts at up to 16 A')
    button('Charge now')!.click()
    await vi.advanceTimersByTimeAsync(1_000)
    const s = slider()
    expect(s, 'manual current must be editable after Charge now').not.toBeNull()
    expect(s!.min).toBe('6')
    expect(s!.max).toBe('16')
    expect(s!.value).toBe('16')
    expect(document.body.textContent).toContain('16 A · 11.0 kW')
    expect(document.body.textContent).toContain('Charge now is active')
  })

  it('charges now at the current the thumb chose, and the whole household says so', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(CHARGING_EVENING)
    const { box, site } = await openedFor()

    button('Charge now')!.click()
    await vi.advanceTimersByTimeAsync(1_000)
    const sent = vi.spyOn(site, 'command')
    slide(10)
    await vi.advanceTimersByTimeAsync(50)
    expect(document.body.textContent).toContain('10 A · 6.9 kW')
    expect(sent).not.toHaveBeenCalled()
    release(slider()!)
    await vi.advanceTimersByTimeAsync(1_000)

    // The box page's own body: the watts for 10 A, a persistent hold, three
    // phases. Then the panel repainted from the box, not from the button.
    expect(sent).toHaveBeenCalledWith(OP_LOADPOINT_HOLD, {
      id: 'carport',
      power_w: 6900,
      hold_s: 0,
      phase_mode: '3p',
    })
    expect(document.body.textContent).toMatch(/Charging at 6\.9 kW/)
    expect(document.body.textContent).toContain('Changes apply when you release the slider')
    expect(button('Update')).toBeUndefined()
    expect(button('Return to plan')).toBeDefined()
    // The thumb stays put, and Update has nothing new to send yet.
    expect(slider()!.value).toBe('10')
    expect(button('Update')).toBeUndefined()

    box.tick()
    await vi.advanceTimersByTimeAsync(100)
    expect(site.session.fields.get(FID.EV_W)).toBe(6900)
  })

  it('updates a running hold to a new current', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(CHARGING_EVENING)
    const { site } = await openedFor()

    button('Charge now')!.click()
    await vi.advanceTimersByTimeAsync(1_000)
    expect(document.body.textContent).toContain('Changes apply when you release the slider')

    const sent = vi.spyOn(site, 'command')
    slide(8)
    expect(sent).not.toHaveBeenCalled()
    slider()!.dispatchEvent(new Event('change', { bubbles: true }))
    await vi.advanceTimersByTimeAsync(1_000)
    expect(sent).toHaveBeenCalledWith(
      OP_LOADPOINT_HOLD,
      expect.objectContaining({ power_w: 5520, hold_s: 0 })
    )
    expect(document.body.textContent).toContain('Changes apply when you release the slider')
    expect(document.body.textContent).toMatch(/Charging at 5\.5 kW/)
  })

  it('opening goal settings does not change charging, and a one-off goal stays one-off', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(CHARGING_EVENING)
    const { site } = await openedFor()
    const asked = vi.spyOn(site, 'api')
    const sent = vi.spyOn(site, 'command')
    button('Change goal')!.click()
    await vi.advanceTimersByTimeAsync(100)
    expect(asked.mock.calls.filter(c => c[0].method !== 'GET')).toHaveLength(0)
    expect(sent).not.toHaveBeenCalled()
    const repeat = [...document.querySelectorAll('label')].find(l => l.textContent?.includes('Repeat on chosen days'))!.querySelector('input')!
    expect(repeat.checked).toBe(true)
    repeat.click()
    await vi.advanceTimersByTimeAsync(1_000)
    const saved = asked.mock.calls.find(c => c[0].method === 'PUT')![0]
    const body = JSON.parse(new TextDecoder().decode(saved.body!))
    expect(body.recurring).toBe(false)
    expect(body.days).toBe(0)
    expect(body).toHaveProperty('surplus_unlock_bat_soc')
  })

  it('shows that Charge now overrides the goal and solar rule until Return to plan', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(CHARGING_EVENING)
    const { site } = await openedFor()
    button('Charge now')!.click()
    await vi.advanceTimersByTimeAsync(1_000)
    expect(document.body.textContent).toContain('Charge now overrides this goal')
    expect(document.body.textContent).not.toContain('Charging ahead')
    expect(pvOnly()!.disabled).toBe(true)
    const sent = vi.spyOn(site, 'command')
    pvOnly()!.click()
    expect(sent).not.toHaveBeenCalled()
    button('Return to plan')!.click()
    await vi.advanceTimersByTimeAsync(1_000)
    expect(pvOnly()!.disabled).toBe(false)
    expect(slider()).toBeNull()
  })

  it('boosts from the house battery and stops it, saying why it ended', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(CHARGING_EVENING)
    const { site } = await openedFor()

    button('Boost from the house battery')!.click()
    await vi.advanceTimersByTimeAsync(50)

    // The box page's own defaults: a 30 % reserve for an hour.
    const reserve = document.querySelector<HTMLInputElement>('[aria-label="House battery reserve"]')!
    expect(reserve.value).toBe('30')
    expect(button('1 h')!.getAttribute('aria-pressed')).toBe('true')
    button('2 h')!.click()
    await vi.advanceTimersByTimeAsync(10)

    const sent = vi.spyOn(site, 'command')
    button('Start boost')!.click()
    await vi.advanceTimersByTimeAsync(1_000)

    expect(sent).toHaveBeenCalledWith(OP_LOADPOINT_BOOST, {
      id: 'carport',
      min_battery_soc_pct: 30,
      duration_s: 7200,
    })
    expect(document.body.textContent).toContain('Battery boost is on')
    expect(document.body.textContent).toContain('down to 30 %')
    expect(button('Stop boost')).toBeDefined()
    expect(button('Start boost')).toBeUndefined()

    button('Stop boost')!.click()
    await vi.advanceTimersByTimeAsync(1_000)
    expect(sent).toHaveBeenCalledWith(OP_LOADPOINT_BOOST, { id: 'carport', cancel: true })
    expect(document.body.textContent).not.toContain('Battery boost is on')
    expect(document.body.textContent).toContain('Boost stopped')
    expect(document.body.textContent).toContain('stopped by hand')
    expect(button('Boost from the house battery')).toBeDefined()
  })

  it('does not offer a boost while a manual charge runs, and says why', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(CHARGING_EVENING)
    await openedFor()

    button('Charge now')!.click()
    await vi.advanceTimersByTimeAsync(1_000)

    expect(button('Boost from the house battery')).toBeUndefined()
    expect(document.body.textContent).toContain('Available after returning to the plan')
  })

  it('explains where to connect a first charger instead of showing an empty panel', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(CHARGING_EVENING)
    const { box } = await openedFor()
    const serve = box.api.serve.bind(box.api)
    vi.spyOn(box.api, 'serve').mockImplementation(req => {
      const answer = serve(req)
      if (req.path === '/api/loadpoints' && 'body' in answer) answer.body = wireBytes(new TextEncoder().encode(JSON.stringify({ loadpoints: [] })))
      return answer
    })
    await vi.advanceTimersByTimeAsync(5_000)
    expect(document.body.textContent).toContain('Connect your first charger on your box: open Settings → Chargers, then choose Connect a charger.')
    expect(document.body.textContent).toContain('Once connected and added there, it appears here too.')
    expect(button('Charge now')).toBeUndefined()
  })

  it('offers three explicit choices when the charger or connection is unconfirmed', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(CHARGING_EVENING)
    const { box, site } = await openedFor()
    const serve = box.api.serve.bind(box.api)
    let waiting = true
    vi.spyOn(box.api, 'serve').mockImplementation(req => {
      const answer = serve(req)
      if (waiting && req.path === '/api/loadpoints' && 'body' in answer) {
        const payload = JSON.parse(new TextDecoder().decode(answer.body))
        Object.assign(payload.loadpoints[0], { manual_restore_unconfirmed: true, manual_active: false })
        answer.body = wireBytes(new TextEncoder().encode(JSON.stringify(payload)))
      }
      return answer
    })
    await vi.advanceTimersByTimeAsync(5_000)
    expect(document.body.textContent).toContain('Confirm how to continue charging')
    expect(document.body.textContent).not.toContain('Paused by you')
    for (const choice of ['Charge now', 'Resume plan', 'Pause charging']) expect(button(choice)).toBeDefined()
    expect(slider()).toBeNull()
    waiting = false
    const sent = vi.spyOn(site, 'command')
    button('Pause charging')!.click()
    await vi.advanceTimersByTimeAsync(1_000)
    expect(sent).toHaveBeenCalledWith(OP_LOADPOINT_HOLD, { id: 'carport', power_w: 0, hold_s: 0 })
    expect(document.body.textContent).toContain('Paused by you')
    expect(document.body.textContent).not.toContain('Confirm how to continue charging')
  })

  it('reports unsaved charging intent until a later poll confirms recovery', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(CHARGING_EVENING)
    const { box } = await openedFor()
    button('Pause charging')!.click()
    await vi.advanceTimersByTimeAsync(1_000)
    const serve = box.api.serve.bind(box.api)
    let saveFailed = true
    vi.spyOn(box.api, 'serve').mockImplementation(req => {
      const answer = serve(req)
      if (req.path === '/api/loadpoints' && 'body' in answer) {
        const payload = JSON.parse(new TextDecoder().decode(answer.body))
        payload.loadpoints[0].manual_save_error = saveFailed
        answer.body = wireBytes(new TextEncoder().encode(JSON.stringify(payload)))
      }
      return answer
    })
    await vi.advanceTimersByTimeAsync(5_000)
    expect(document.body.textContent).toContain('Paused by you')
    expect(document.body.textContent).toContain('This choice is active now, but could not be saved for restart. FTW is retrying.')
    expect(button('Save')).toBeUndefined()
    saveFailed = false
    await vi.advanceTimersByTimeAsync(5_000)
    expect(document.body.textContent).not.toContain('could not be saved for restart')
    expect(document.body.textContent).toContain('Paused by you')
  })

  it('pauses without removing the goal and resumes only when asked', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(CHARGING_EVENING)
    const { site } = await openedFor()
    const sent = vi.spyOn(site, 'command')
    button('Pause charging')!.click()
    await vi.advanceTimersByTimeAsync(1_000)
    expect(sent).toHaveBeenCalledWith(OP_LOADPOINT_HOLD, { id: 'carport', power_w: 0, hold_s: 0 })
    expect(document.body.textContent).toContain('Paused by you')
    expect(document.body.textContent).toContain('Ready by')
    expect(slider()).toBeNull()
    expect(button('Resume plan')).toBeDefined()
    expect(button('Charge now')).toBeDefined()
    await vi.advanceTimersByTimeAsync(20_000)
    expect(document.body.textContent).toContain('Paused by you')
    button('Resume plan')!.click()
    await vi.advanceTimersByTimeAsync(1_000)
    expect(sent).toHaveBeenLastCalledWith(OP_LOADPOINT_HOLD, { id: 'carport', clear: true })
    expect(document.body.textContent).not.toContain('Paused by you')
  })

  it('Charge now from a pause uses the normal charger limit, not a clamped zero', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(CHARGING_EVENING)
    const { site } = await openedFor()
    const sent = vi.spyOn(site, 'command')
    button('Pause charging')!.click()
    await vi.advanceTimersByTimeAsync(1_000)
    button('Charge now')!.click()
    await vi.advanceTimersByTimeAsync(1_000)
    expect(sent).toHaveBeenLastCalledWith(OP_LOADPOINT_HOLD, { id: 'carport', power_w: 11000, hold_s: 0, phase_mode: '3p' })
    expect(document.body.textContent).toContain('Charge now is active')
    expect(document.body.textContent).not.toContain('Paused by you')
  })

  it('saves battery size on field release, reads it back, and keeps it after reopening', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(CHARGING_EVENING)
    const { box, site } = await openedFor()
    const requests = vi.spyOn(box.api, 'serve')
    const capacity = document.querySelector<HTMLInputElement>('[aria-label="Usable battery size, kWh"]')!
    capacity.value = '77.4'
    capacity.dispatchEvent(new Event('input', { bubbles: true }))
    await vi.advanceTimersByTimeAsync(100)
    expect(requests.mock.calls.some(c => c[0].path.endsWith('/vehicle'))).toBe(false)
    capacity.dispatchEvent(new Event('change', { bubbles: true }))
    await vi.advanceTimersByTimeAsync(1_000)
    const writes = requests.mock.calls.filter(c => c[0].path.endsWith('/vehicle') && c[0].stepUp)
    expect(writes).toHaveLength(1)
    expect(JSON.parse(new TextDecoder().decode(writes[0]![0].body!))).toEqual({ capacity_wh: 77400 })
    expect(document.body.textContent).toContain('Car battery · 77.4 kWh')
    expect(document.body.textContent).toContain('Battery size saved')
    document.body.replaceChildren()
    render(EvPanel, { props: { site, onclose: () => {} } })
    await vi.advanceTimersByTimeAsync(500)
    expect(document.body.textContent).toContain('Car battery · 77.4 kWh')
  })

  it('lets an unplugged owner save the usual battery size without offering live car controls', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(Date.UTC(2026, 6, 15, 12, 0, 0))
    const { box, site } = await openedFor()
    const requests = vi.spyOn(box.api, 'serve')
    const commands = vi.spyOn(site, 'command')
    expect(document.body.textContent).toContain('Not plugged in')
    expect(socSlider()).toBeNull()
    expect(slider()).toBeNull()
    expect(button('Charge now')).toBeUndefined()
    expect(button('Pause charging')).toBeUndefined()
    const capacity = document.querySelector<HTMLInputElement>('[aria-label="Usable battery size, kWh"]')
    expect(capacity, 'the next car size must be editable before plugging in').not.toBeNull()
    capacity!.value = '61'
    capacity!.dispatchEvent(new Event('input', { bubbles: true }))
    await vi.advanceTimersByTimeAsync(100)
    expect(requests.mock.calls.some(([req]) => req.path.endsWith('/vehicle'))).toBe(false)
    capacity!.dispatchEvent(new Event('change', { bubbles: true }))
    await vi.advanceTimersByTimeAsync(1_000)
    const writes = requests.mock.calls.filter(([req]) => req.path.endsWith('/vehicle') && req.stepUp)
    expect(writes).toHaveLength(1)
    expect(JSON.parse(new TextDecoder().decode(writes[0]![0].body!))).toEqual({ capacity_wh: 61000 })
    expect(document.body.textContent).toContain('Car battery · 61 kWh')
    expect(document.body.textContent).toContain('Battery size saved. The plan uses this size for its estimates.')
    document.body.replaceChildren()
    render(EvPanel, { props: { site, onclose: () => {} } })
    await vi.advanceTimersByTimeAsync(500)
    expect(document.querySelector<HTMLInputElement>('[aria-label="Usable battery size, kWh"]')?.value).toBe('61')
    expect(document.body.textContent).toContain('Not plugged in')
    expect(socSlider()).toBeNull()
    expect(slider()).toBeNull()
    expect(button('Charge now')).toBeUndefined()
    expect(commands).not.toHaveBeenCalled()
  })

  it('does not offer battery-size edits to an unplugged viewer', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(Date.UTC(2026, 6, 15, 12, 0, 0))
    const { site } = await openedFor(ROLE_VIEWER)
    const requests = vi.spyOn(site, 'api')
    expect(document.body.textContent).toContain('Not plugged in')
    expect(document.querySelector('[aria-label="Usable battery size, kWh"]')).toBeNull()
    expect(socSlider()).toBeNull()
    expect(button('Charge now')).toBeUndefined()
    await vi.advanceTimersByTimeAsync(6_000)
    expect(requests.mock.calls.some(([req]) => req.method !== 'GET')).toBe(false)
  })

  it('distinguishes a saved default from the size used by the current car', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(CHARGING_EVENING)
    const { box } = await openedFor()
    const serve = box.api.serve.bind(box.api)
    vi.spyOn(box.api, 'serve').mockImplementation(req => {
      const answer = serve(req)
      if (req.method === 'GET' && req.path === '/api/loadpoints' && 'body' in answer) {
        const payload = JSON.parse(new TextDecoder().decode(answer.body))
        payload.loadpoints[0].vehicle_capacity_wh = 40000
        answer.body = wireBytes(new TextEncoder().encode(JSON.stringify(payload)))
      }
      return answer
    })
    const capacity = document.querySelector<HTMLInputElement>('[aria-label="Usable battery size, kWh"]')!
    capacity.value = '77.4'
    capacity.dispatchEvent(new Event('input', { bubbles: true }))
    capacity.dispatchEvent(new Event('change', { bubbles: true }))
    await vi.advanceTimersByTimeAsync(1_000)
    expect(document.body.textContent).toContain('Saved as the usual battery size. This session uses 40 kWh.')
    expect(document.body.textContent).toContain('Car battery · 40 kWh')
  })

  it('shows an invalid battery size without sending it', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(CHARGING_EVENING)
    const { site } = await openedFor()
    const asked = vi.spyOn(site, 'api')
    const capacity = document.querySelector<HTMLInputElement>('[aria-label="Usable battery size, kWh"]')!
    capacity.value = ''
    capacity.dispatchEvent(new Event('input', { bubbles: true }))
    capacity.dispatchEvent(new Event('change', { bubbles: true }))
    await vi.advanceTimersByTimeAsync(100)
    expect(document.body.textContent).toContain('Enter the usable battery size')
    expect(asked.mock.calls.some(c => c[0].method === 'POST')).toBe(false)
  })

  it('ages charger status while its read hangs on a live house connection', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(CHARGING_EVENING)
    const { site } = await openedFor()
    const api = site.api.bind(site)
    vi.spyOn(site, 'api').mockImplementation(req => req.path === '/api/loadpoints' ? new Promise(() => {}) : api(req))
    await vi.advanceTimersByTimeAsync(17_000)
    expect(site.session.phase).toBe('streaming')
    expect(document.body.textContent).toContain('The last reading is out of date')
    expect(document.querySelector('.status')?.textContent).not.toContain('Charging at')
  })

  it('polls current charging and its windows without requesting the full plan on current boxes', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(CHARGING_EVENING)
    const site = await streaming()
    const api = site.api.bind(site)
    let reads = 0
    const asked = vi.spyOn(site, 'api').mockImplementation(async req => {
      // An optional route that never answers must not be needed by this sheet.
      if (req.path === '/api/mpc/plan') return new Promise(() => {})
      const answer = await api(req)
      if (req.path === '/api/loadpoints') {
        reads++
        const payload = JSON.parse(new TextDecoder().decode(answer.body))
        Object.assign(payload.loadpoints[0], {
          current_power_w: 5000 + reads * 100,
          plan_pending: false, plan_outdated: false,
          plan_windows: [{ start_ms: CHARGING_EVENING, end_ms: CHARGING_EVENING + 3_600_000, wh: 4600 }],
        })
        return { ...answer, body: new TextEncoder().encode(JSON.stringify(payload)) }
      }
      return answer
    })
    render(EvPanel, { props: { site, onclose: () => {} } })
    await vi.advanceTimersByTimeAsync(21_000)
    expect(reads).toBeGreaterThanOrEqual(5)
    expect(asked.mock.calls.filter(([req]) => req.path === '/api/mpc/plan')).toHaveLength(0)
    expect(document.body.textContent).not.toContain('The last reading is out of date')
    expect(document.querySelector('.status')?.textContent).toContain('Charging at 5.5 kW')
    expect(document.body.textContent).toContain('Charging ahead')
    expect(document.body.textContent).toContain('4.6 kWh')
    expect(document.querySelector('.windows')?.textContent).not.toContain('up to')
  })

  it('describes a routine global replan without claiming that this owner saved a goal', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(CHARGING_EVENING)
    const site = await streaming()
    const api = site.api.bind(site)
    const asked = vi.spyOn(site, 'api').mockImplementation(async req => {
      const answer = await api(req)
      const payload = JSON.parse(new TextDecoder().decode(answer.body))
      if (req.path === '/api/loadpoints') payload.loadpoints[0].plan_pending = true
      if (req.path === '/api/mpc/plan') payload.meta = { replanning: true }
      return { ...answer, body: new TextEncoder().encode(JSON.stringify(payload)) }
    })
    render(EvPanel, { props: { site, onclose: () => {} } })
    await vi.advanceTimersByTimeAsync(500)
    expect(document.body.textContent).toContain('Updating the charging plan…')
    expect(document.body.textContent).not.toContain('Goal saved')
    expect(asked.mock.calls.every(([req]) => req.method === 'GET')).toBe(true)
  })

  it('never draws the slider or the boost for a viewer', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(CHARGING_EVENING)
    await openedFor(ROLE_VIEWER)

    expect(slider()).toBeNull()
    expect(button('Boost from the house battery')).toBeUndefined()
    expect(button('Stop boost')).toBeUndefined()
    expect(socSlider()).toBeNull()
    expect(pvOnly()).toBeNull()
    expect(document.body.textContent).toContain('Battery now')
    expect(document.body.textContent).toContain('42 %')
    expect(document.querySelector('[aria-label="Usable battery size, kWh"]')).toBeNull()
    expect(button('Pause charging')).toBeUndefined()
    expect(document.body.textContent).not.toContain('Choose Charge now')
  })

  it("prefills the car's level from the box and says where it came from", async () => {
    vi.useFakeTimers()
    vi.setSystemTime(CHARGING_EVENING)
    await openedFor()

    const s = socSlider()
    expect(s, 'no level slider for an owner with a plugged car').not.toBeNull()
    expect(s!.min).toBe('0')
    expect(s!.max).toBe('100')
    expect(s!.value).toBe('42')
    expect(document.body.textContent).toContain('42 %')
    expect(document.body.textContent).toContain('Estimated from energy delivered')
  })

  it("corrects the car's level on release, and the sentence follows the box", async () => {
    vi.useFakeTimers()
    vi.setSystemTime(CHARGING_EVENING)
    const { site } = await openedFor()

    const sent = vi.spyOn(site, 'command')
    slideTo(socSlider()!, 60)
    await vi.advanceTimersByTimeAsync(20)
    // A thumb mid-drag sends nothing; the readout follows it.
    expect(sent).not.toHaveBeenCalled()
    expect(document.body.textContent).toContain('60 %')

    release(socSlider()!)
    // A flush, not a wait: over the 5 ms loopback the box has answered
    // before the first timer, and what is under test is the moment before.
    await vi.advanceTimersByTimeAsync(0)
    expect(sent).toHaveBeenCalledWith(OP_LOADPOINT_SOC_SET, { id: 'carport', soc: 0.6 })
    expect(document.body.textContent).toContain('Sending charge level: 60 %…')

    await vi.advanceTimersByTimeAsync(1_000)
    expect(document.body.textContent).toContain('Charge level saved: 60 %.')
    expect(socSlider()!.value).toBe('60')

    // The sentence gives way to the source again; the slider stays on the
    // level the box now holds.
    await vi.advanceTimersByTimeAsync(6_000)
    expect(document.body.textContent).not.toContain('Plan updated')
    expect(document.body.textContent).toContain('Estimated from energy delivered')
    expect(socSlider()!.value).toBe('60')
  })

  it('keeps the accepted charge level through a failed reread, then follows fresh box state', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(CHARGING_EVENING)
    const { site } = await openedFor()
    const api = site.api.bind(site)
    let failRead = true
    vi.spyOn(site, 'api').mockImplementation(async req => {
      if (req.path === '/api/loadpoints' && failRead) throw new Error('read unavailable')
      const answer = await api(req)
      if (req.path === '/api/loadpoints') {
        const payload = JSON.parse(new TextDecoder().decode(answer.body))
        payload.loadpoints[0].current_soc = 0.61 // Fresh state has moved on since the accepted choice.
        return { ...answer, body: new TextEncoder().encode(JSON.stringify(payload)) }
      }
      return answer
    })
    const sent = vi.spyOn(site, 'command')
    slideTo(socSlider()!, 60)
    release(socSlider()!)
    await vi.advanceTimersByTimeAsync(1_000)
    expect(socSlider()!.value).toBe('60')
    expect(document.body.textContent).toContain('Charge level accepted: 60 %.')
    expect(document.body.textContent).not.toContain('Charge level saved: 42')
    expect(document.body.textContent).toContain('Waiting for updated charging status')
    await vi.advanceTimersByTimeAsync(7_000)
    expect(socSlider()!.value).toBe('60')
    expect(document.body.textContent).toContain('Waiting for updated charging status')
    failRead = false
    await vi.advanceTimersByTimeAsync(6_000)
    expect(socSlider()!.value).toBe('61')
    expect(document.body.textContent).not.toContain('Waiting for updated charging status')
    expect(document.body.textContent).not.toContain('The last reading is out of date')
    expect(sent).toHaveBeenCalledTimes(1)
  })

  it('keeps an accepted solar switch through a failed reread without sending it again', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(CHARGING_EVENING)
    const { site } = await openedFor()
    const api = site.api.bind(site)
    let failRead = true
    vi.spyOn(site, 'api').mockImplementation(req => req.path === '/api/loadpoints' && failRead
      ? Promise.reject(new Error('read unavailable')) : api(req))
    const sent = vi.spyOn(site, 'command')
    pvOnly()!.click()
    await vi.advanceTimersByTimeAsync(1_000)
    expect(pvOnly()!.checked).toBe(true)
    expect(document.body.textContent).toContain('Solar rule accepted. Waiting for updated charging status.')
    await vi.advanceTimersByTimeAsync(7_000)
    expect(pvOnly()!.checked).toBe(true)
    expect(document.body.textContent).toContain('Waiting for updated charging status')
    failRead = false
    await vi.advanceTimersByTimeAsync(6_000)
    expect(pvOnly()!.checked).toBe(true)
    expect(document.body.textContent).not.toContain('Waiting for updated charging status')
    expect(sent).toHaveBeenCalledTimes(1)
  })

  it('does not let a reread snap the slider from under a thumb', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(CHARGING_EVENING)
    const { site } = await openedFor()

    const asked = vi.spyOn(site, 'api')
    slideTo(socSlider()!, 70)
    // Well over a minute mid-drag: the panel's own ask comes and goes.
    await vi.advanceTimersByTimeAsync(90_000)
    expect(asked.mock.calls.length).toBeGreaterThan(0)
    expect(socSlider()!.value).toBe('70')
    expect(document.body.textContent).toContain('70 %')
  })

  it('hides the level slider for an empty bay, and keeps the PV-only switch', async () => {
    vi.useFakeTimers()
    // Midday: the car left with the morning commute.
    vi.setSystemTime(Date.UTC(2026, 6, 15, 12, 0, 0))
    await openedFor()

    expect(document.body.textContent).toContain('Not plugged in')
    expect(socSlider()).toBeNull()
    expect(slider()).toBeNull()
    // A standing setting outlives an unplug, so it is still offered.
    expect(pvOnly()).not.toBeNull()
  })

  it('switches to solar surplus only through the door, and the boost offer follows', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(CHARGING_EVENING)
    const { site } = await openedFor()

    const sw = pvOnly()
    expect(sw, 'no PV-only switch for an owner').not.toBeNull()
    expect(sw!.checked).toBe(false)
    expect(button('Boost from the house battery')).toBeDefined()

    const sent = vi.spyOn(site, 'command')
    sw!.click()
    await vi.advanceTimersByTimeAsync(1_000)

    expect(sent).toHaveBeenCalledWith(OP_LOADPOINT_SURPLUS_ONLY_SET, {
      id: 'carport',
      surplus_only: true,
    })
    expect(pvOnly()!.checked).toBe(true)
    expect(document.body.textContent).toContain('The plan uses spare solar only')
    // The box refuses a boost while PV only is on; the offer says so instead.
    expect(button('Boost from the house battery')).toBeUndefined()
    expect(document.body.textContent).toContain('Not while the charger uses spare solar only')

    pvOnly()!.click()
    await vi.advanceTimersByTimeAsync(1_000)
    expect(sent).toHaveBeenCalledWith(OP_LOADPOINT_SURPLUS_ONLY_SET, {
      id: 'carport',
      surplus_only: false,
    })
    expect(pvOnly()!.checked).toBe(false)
    expect(document.body.textContent).toContain('may use grid power again')
    expect(button('Boost from the house battery')).toBeDefined()
  })

  it('names a solar save failure, preserves the previous choice and allows retry', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(CHARGING_EVENING)
    const { site } = await openedFor()
    const sent = vi.spyOn(site, 'command').mockResolvedValueOnce({
      cmdId: 'solar-save-failed', state: 'rejected',
      error: { code: 'E_UNAVAILABLE', args: { op: OP_LOADPOINT_SURPLUS_ONLY_SET } },
    })
    pvOnly()!.click()
    await vi.advanceTimersByTimeAsync(1_000)
    expect(pvOnly()!.checked).toBe(false)
    expect(document.body.textContent).toContain('Solar rule not saved. Your previous choice is unchanged. Try again.')
    expect(document.body.textContent).not.toContain("can't reach the charger")
    sent.mockRestore()
    pvOnly()!.click()
    await vi.advanceTimersByTimeAsync(1_000)
    expect(pvOnly()!.checked).toBe(true)
    expect(document.body.textContent).toContain('Solar rule saved')
  })

  it('puts a refused switch back where the box says it is', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(CHARGING_EVENING)
    const { box } = await openedFor()

    box.faults = { ...box.faults, failPreconditions: true }
    pvOnly()!.click()
    await vi.advanceTimersByTimeAsync(1_000)

    expect(document.body.textContent).toContain('Your home changed while that was sending')
    expect(pvOnly()!.checked).toBe(false)
  })
})
