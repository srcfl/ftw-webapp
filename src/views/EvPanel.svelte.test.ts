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
