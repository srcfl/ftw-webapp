/* The ring on Now, on what a person can do with it and what it costs.
 *
 * jsdom has no canvas, so the drawing itself is checked in a browser; here
 * the nodes, their doors, the live switch and the frame loop. */

import { afterEach, describe, expect, it, vi } from 'vitest'
import { render } from '@testing-library/svelte'
import { tick } from 'svelte'
import EnergyRing from './EnergyRing.svelte'
import { ringReadings, type RingReading } from '$lib/state/ring'
import { flowReadingsFromStatus } from '$lib/state/flow'

HTMLCanvasElement.prototype.getContext = (() => null) as never

const house = (live = true): RingReading[] =>
  ringReadings(
    flowReadingsFromStatus({
      grid_w: 2_000,
      load_w: 3_700,
      drivers: { sungrow: { status: 'ok', pv_w: -1_100, bat_w: 0, bat_soc: 0.62 }, easee: { status: 'ok', ev_w: 7_300 } },
    }),
    live
  )

describe('the ring', () => {
  afterEach(() => {
    document.body.replaceChildren()
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
    HTMLCanvasElement.prototype.getContext = (() => null) as never
    Object.defineProperty(document, 'visibilityState', { value: 'visible', configurable: true })
    document.documentElement.removeAttribute('style')
  })

  it('draws each node as text on the ground with the home in the middle', () => {
    render(EnergyRing, { props: { readings: house() } })
    const text = (n: string) => document.querySelector(`[data-node="${n}"]`)?.textContent?.replace(/\s+/g, ' ').trim()
    expect(text('solar')).toBe('Solar 1.1 kW Making')
    expect(text('battery')).toBe('Battery 0 W Resting · 62%')
    expect(text('grid')).toBe('Grid 2.0 kW Buying')
    expect(text('car')).toBe('Car 7.3 kW Charging')
    expect(text('home')).toBe('3.7 kW Usage')
  })

  it('opens what a tap on a node names', () => {
    const onopen = vi.fn()
    render(EnergyRing, { props: { readings: house(), onopen } })
    ;(document.querySelector('[data-node="car"]') as HTMLElement).click()
    ;(document.querySelector('[data-node="home"]') as HTMLElement).click()
    expect(onopen.mock.calls).toEqual([[{ role: 'ev', name: 'easee', id: 'ev-easee' }], [{ role: 'load' }]])
  })

  it('says live only for readings the box confirms', () => {
    render(EnergyRing, { props: { readings: house(false) } })
    const ring = document.querySelector('.ring')!
    expect(ring.getAttribute('data-live')).toBe('false')
    expect(document.querySelector('[data-node="solar"]')!.getAttribute('aria-label')).toMatch(/not live$/)
  })

  it('asks for no frame when a tick changes nothing, and for one when it does', async () => {
    // A cached house: nothing glows or runs, so the loop rests once a change
    // has played. A live flowing arc keeps it running, as on the phone.
    const frames = vi.fn((_: FrameRequestCallback) => 1)
    vi.stubGlobal('requestAnimationFrame', frames)
    vi.stubGlobal('cancelAnimationFrame', vi.fn())
    const view = render(EnergyRing, { props: { readings: house(false), active: true } })
    await tick()
    expect(frames).toHaveBeenCalledTimes(1)
    // Past the moment a change plays for, the frame asks for no other.
    vi.spyOn(performance, 'now').mockReturnValue(performance.now() + 10_000)
    frames.mock.calls[0]![0](0)
    expect(frames).toHaveBeenCalledTimes(1)
    frames.mockClear()

    await view.rerender({ readings: house(false), active: true })
    await tick()
    expect(frames, 'an unchanged reading started the loop').not.toHaveBeenCalled()

    const next = house(false)
    const car = next.findIndex((r) => r.node === 'car')
    next[car] = { ...next[car]!, watts: 3_000 }
    await view.rerender({ readings: next, active: true })
    await tick()
    expect(frames).toHaveBeenCalledTimes(1)
  })

  it('draws nothing while hidden', async () => {
    const frames = vi.fn(() => 1)
    vi.stubGlobal('requestAnimationFrame', frames)
    vi.stubGlobal('cancelAnimationFrame', vi.fn())
    const view = render(EnergyRing, { props: { readings: house(), active: false } })
    await tick()
    await view.rerender({ readings: house(false), active: false })
    await tick()
    expect(frames).not.toHaveBeenCalled()
  })

  it('keeps running while a live arc flows, and rests when the page or the view goes away', async () => {
    const frames = stubFrames()
    const later = performance.now() + 10_000
    const view = render(EnergyRing, { props: { readings: house(), active: true } })
    await tick()
    vi.spyOn(performance, 'now').mockReturnValue(later)
    frames.run()
    expect(frames.asked(), 'a live flowing arc stopped its light').toBe(1)

    visibility('hidden')
    frames.run()
    expect(frames.asked(), 'the loop ran on a hidden page').toBe(0)
    visibility('visible')
    expect(frames.asked()).toBe(1)

    await view.rerender({ readings: house(), active: false })
    frames.run()
    expect(frames.asked(), 'the loop ran behind another tab').toBe(0)
  })

  it('glows only while live, and draws a cache in ink', async () => {
    // The page's ink and the sun's colour, as the theme would give them.
    document.documentElement.style.setProperty('--fg-dim', '#9aa5b8')
    document.documentElement.style.setProperty('--energy-generation', '#ffe14d')
    const strokes = recordStrokes()
    const frames = stubFrames()
    const view = render(EnergyRing, { props: { readings: house(), active: true } })
    await tick()
    frames.run()
    expect(strokes.wide(), 'a live arc did not glow').toBeGreaterThan(0)
    expect(strokes.colours.has('rgba(255, 225, 77)'), 'a live sun was not in its colour').toBe(true)

    strokes.clear()
    await view.rerender({ readings: house(false), active: true })
    await tick()
    // Well past the cooling, the light is out.
    vi.spyOn(performance, 'now').mockReturnValue(performance.now() + 10_000)
    frames.run()
    expect(strokes.list.length, 'nothing was drawn').toBeGreaterThan(0)
    expect(strokes.wide(), 'a cached arc glowed').toBe(0)
    expect(Math.max(...strokes.stops), 'a cached arc kept its full strength').toBeLessThanOrEqual(0.35 + 1e-6)
    expect([...strokes.colours], 'a cached arc kept its colour').toEqual(['rgba(154, 165, 184)'])
  })
})

/** A frame queue the test drives by hand. */
function stubFrames() {
  let queue: FrameRequestCallback[] = []
  vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => (queue.push(cb), queue.length))
  vi.stubGlobal('cancelAnimationFrame', () => { queue = [] })
  return {
    asked: () => queue.length,
    run() {
      const now = queue
      queue = []
      for (const cb of now) cb(0)
    },
  }
}

function visibility(state: DocumentVisibilityState) {
  Object.defineProperty(document, 'visibilityState', { value: state, configurable: true })
  document.dispatchEvent(new Event('visibilitychange'))
}

/** A 2D context that keeps each stroke's width and each colour stop's alpha. */
function recordStrokes() {
  const list: { width: number }[] = []
  const stops: number[] = []
  const colours = new Set<string>()
  const alphaOf = (c: string) => Number(/,\s*([\d.]+)\)$/.exec(c)?.[1] ?? 1)
  const ctx = {
    lineWidth: 1, strokeStyle: '' as unknown, fillStyle: '#000', lineCap: '', lineJoin: '',
    setTransform() {}, clearRect() {}, beginPath() {}, arc() {}, moveTo() {}, lineTo() {}, save() {}, restore() {},
    stroke() { list.push({ width: this.lineWidth }) },
    createConicGradient() {
      return {
        addColorStop: (_: number, c: string) => {
          stops.push(alphaOf(c))
          colours.add(c.replace(/,\s*[\d.]+\)$/, ')'))
        },
      }
    },
  }
  HTMLCanvasElement.prototype.getContext = (() => ctx) as never
  return {
    list,
    stops,
    /** The colours of the stops, without their alpha. */
    colours,
    /** Strokes wider than an arc: the glow. */
    wide: () => list.filter((s) => s.width > 20).length,
    clear() {
      list.length = 0
      stops.length = 0
      colours.clear()
    },
  }
}
