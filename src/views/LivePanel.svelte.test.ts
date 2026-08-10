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

    openBubble('pv')
    await vi.advanceTimersByTimeAsync(200)

    expect(document.querySelector('[role="dialog"]')!.getAttribute('aria-label')).toBe('Solar')
    expect(api, 'the live panel reached for the box API it does not need').not.toHaveBeenCalled()
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
})
