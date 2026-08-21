/* The live-line sheet, over a real wire.
 *
 * The chart is a canvas, so what a test can hold is the frame around it: the
 * big number in words matching the reading, the sheet opening on the right
 * bubble, no raw minus reaching the reading, and the panel opening with
 * nothing but the stream — no box API, unlike the charger's.
 */

import { describe, it, expect, vi, afterEach } from 'vitest'
import { render } from '@testing-library/svelte'
import Now from './Now.svelte'
import { SiteStore } from '$lib/state/site.svelte'
import { LoopbackCarrier } from '$lib/carrier/loopback'
import { SimBox } from '$lib/sim/box'
import { FID } from '$lib/format/explanation'
import { planetColor } from '$lib/state/flow'

// jsdom has no canvas 2d context; the panel's chrome is what is under test,
// not its pixels, so a quiet stub keeps the chart's effect from throwing.
class QuietResizeObserver {
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
}
globalThis.ResizeObserver ??= QuietResizeObserver as unknown as typeof ResizeObserver
HTMLCanvasElement.prototype.getContext = (() => null) as never

const NOON = Date.UTC(2026, 6, 15, 12, 0, 0)

async function streaming(): Promise<SiteStore> {
  const site = new SiteStore('test')
  site.connect(new LoopbackCarrier(new SimBox({ now: () => Date.now() }), { latencyMs: 5 }))
  for (let i = 0; i < 100 && site.session.phase !== 'streaming'; i++) {
    await vi.advanceTimersByTimeAsync(10)
  }
  expect(site.session.phase).toBe('streaming')
  return site
}

function openBubble(role: string) {
  document
    .querySelector('ftw-energy-flow')!
    .dispatchEvent(new CustomEvent('ftw-planet-click', { detail: { role }, bubbles: true }))
}

describe('a live line behind a bubble', () => {
  afterEach(() => {
    document.body.replaceChildren()
    vi.useRealTimers()
    vi.restoreAllMocks()
  })

  it('opens the tapped part and reads it in words, never a minus', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(NOON)
    const site = await streaming()
    render(Now, { props: { site } })
    await vi.advanceTimersByTimeAsync(50)

    openBubble('battery')
    await vi.advanceTimersByTimeAsync(50)

    const sheet = document.querySelector('[role="dialog"]')
    expect(sheet, 'the battery bubble opened nothing').not.toBeNull()
    expect(sheet!.getAttribute('aria-label')).toBe('Battery')
    expect(sheet!.textContent).toMatch(/kW|W/)
    // The sign convention must not leak into the reading.
    expect(sheet!.textContent).not.toMatch(/-\d/)
    // A direction word, not a bare number.
    expect(sheet!.textContent).toMatch(/charging|discharging|resting/)
  })

  it('opens a live line with only the stream — no box API needed', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(NOON)
    const site = await streaming()
    // The panel must not need the passthrough the charger needs: prove it by
    // spying that no api call is made when a bubble is tapped.
    const api = vi.spyOn(site, 'api')
    render(Now, { props: { site } })
    await vi.advanceTimersByTimeAsync(50)
    // Now asks for chargers so the house/car split can match the LAN page.
    // The live line itself still needs only the stream — clear those asks
    // before tapping, or they would look like the panel reaching the API.
    api.mockClear()

    openBubble('pv')
    await vi.advanceTimersByTimeAsync(200)

    expect(document.querySelector('[role="dialog"]')!.getAttribute('aria-label')).toBe('Solar')
    const besidesChargers = api.mock.calls.filter(
      (c) => (c[0] as { path?: string } | undefined)?.path !== '/api/loadpoints'
    )
    expect(besidesChargers, 'the live panel reached for the box API it does not need').toEqual([])
  })

  it('does not open a live line over retained readings after the wire drops', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(NOON)
    const site = new SiteStore('test')
    const carrier = new LoopbackCarrier(new SimBox({ now: () => Date.now() }), { latencyMs: 5 })
    site.connect(carrier)
    for (let i = 0; i < 100 && site.session.phase !== 'streaming'; i++) {
      await vi.advanceTimersByTimeAsync(10)
    }
    carrier.drop('wire died')
    await vi.advanceTimersByTimeAsync(20)

    render(Now, { props: { site } })
    await vi.advanceTimersByTimeAsync(20)
    openBubble('grid')
    await vi.advanceTimersByTimeAsync(20)

    expect(document.querySelector('[role="dialog"]')).toBeNull()
    site.destroy()
  })

  it('closes on Escape', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(NOON)
    const site = await streaming()
    render(Now, { props: { site } })
    await vi.advanceTimersByTimeAsync(50)

    openBubble('grid')
    await vi.advanceTimersByTimeAsync(50)
    expect(document.querySelector('[role="dialog"]')).not.toBeNull()

    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))
    await vi.advanceTimersByTimeAsync(50)
    expect(document.querySelector('[role="dialog"]')).toBeNull()
  })

  it('wears the bubble colour, and does not sit inside the scrolling house', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(NOON)
    const site = await streaming()

    const scroller = document.createElement('main')
    document.body.append(scroller)
    render(Now, { target: scroller, props: { site } })
    await vi.advanceTimersByTimeAsync(50)

    scroller.scrollTop = 280
    openBubble('battery')
    await vi.advanceTimersByTimeAsync(50)

    const sheet = document.querySelector('[role="dialog"]')
    expect(sheet, 'the battery bubble opened nothing').not.toBeNull()
    expect(
      scroller.contains(sheet),
      'the sheet stayed in the scroller, so a tap walks the house off screen'
    ).toBe(false)
    expect(scroller.scrollTop, 'opening the line scrolled the house away').toBe(280)

    const watts = site.session.fields.get(FID.BATTERY_W)
    const reading = sheet!.querySelector('.reading')
    expect(reading?.getAttribute('style')).toBe(`color: ${planetColor('battery', watts)}`)
  })
})
