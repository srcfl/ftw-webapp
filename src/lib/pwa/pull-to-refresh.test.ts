/* The installed app's one direct gesture.
 *
 * These tests send touch events to the real DOM listener. That proves the
 * threshold and direction lock together: testing only the resistance formula
 * would still allow a sideways chart swipe or a half-pull to reload the app.
 */

import { afterEach, describe, expect, it, vi } from 'vitest'
import { attachPullToRefresh, resistedPull } from './pull-to-refresh'

interface Point {
  clientX: number
  clientY: number
}

function touch(target: HTMLElement, type: string, points: Point[]): Event {
  const event = new Event(type, { bubbles: true, cancelable: true })
  Object.defineProperty(event, 'touches', { value: points })
  target.dispatchEvent(event)
  return event
}

function mounted(refresh = vi.fn(() => new Promise<void>(() => {}))) {
  const scroller = document.createElement('main')
  const indicator = document.createElement('div')
  const surface = document.createElement('div')
  scroller.append(indicator, surface)
  document.body.append(scroller)
  const stop = attachPullToRefresh({ scroller, indicator, surface, refresh })
  return { scroller, indicator, surface, refresh, stop }
}

afterEach(() => {
  document.body.replaceChildren()
  vi.useRealTimers()
  vi.restoreAllMocks()
})

describe('pull to refresh', () => {
  it('warms the moving layer before the first touch and releases it on teardown', () => {
    const view = mounted()

    expect(view.surface.style.willChange).toBe('transform')
    view.stop()
    expect(view.surface.style.willChange).toBe('')
  })

  it('follows a downward pull and refreshes only after release past the detent', () => {
    const view = mounted()

    touch(view.scroller, 'touchstart', [{ clientX: 100, clientY: 20 }])
    const move = touch(view.scroller, 'touchmove', [{ clientX: 102, clientY: 210 }])

    expect(move.defaultPrevented, 'WebKit would rubber-band behind our surface').toBe(true)
    expect(view.surface.style.transform).toMatch(/translate3d\(0, [6-9]\d\.\d{2}px, 0\)/)
    expect(view.indicator.dataset.state).toBe('ready')
    expect(view.refresh).not.toHaveBeenCalled()

    touch(view.scroller, 'touchend', [])

    expect(view.refresh).toHaveBeenCalledOnce()
    expect(view.indicator.dataset.state).toBe('refreshing')
    expect(view.surface.style.transform).toContain('44px')
    view.stop()
  })

  it('snaps back without refreshing below the detent', () => {
    const view = mounted()

    touch(view.scroller, 'touchstart', [{ clientX: 100, clientY: 20 }])
    touch(view.scroller, 'touchmove', [{ clientX: 101, clientY: 72 }])
    expect(view.indicator.dataset.state).toBe('pulling')

    touch(view.scroller, 'touchend', [])

    expect(view.refresh).not.toHaveBeenCalled()
    expect(view.surface.style.transform).toBe('translate3d(0, 0, 0)')
    expect(view.indicator.dataset.state).toBe('settling')
    view.stop()
  })

  it('settles quickly after an in-place refresh completes', async () => {
    vi.useFakeTimers()
    const view = mounted(vi.fn(() => Promise.resolve()))

    touch(view.scroller, 'touchstart', [{ clientX: 100, clientY: 20 }])
    touch(view.scroller, 'touchmove', [{ clientX: 102, clientY: 210 }])
    touch(view.scroller, 'touchend', [])
    await Promise.resolve()

    expect(view.indicator.dataset.state).toBe('refreshing')
    await vi.advanceTimersByTimeAsync(280)
    expect(view.indicator.dataset.state).toBe('settling')
    view.stop()
  })

  it('leaves sideways gestures and a view below its top alone', () => {
    const sideways = mounted()
    touch(sideways.scroller, 'touchstart', [{ clientX: 20, clientY: 20 }])
    const horizontal = touch(sideways.scroller, 'touchmove', [{ clientX: 120, clientY: 28 }])
    touch(sideways.scroller, 'touchend', [])

    expect(horizontal.defaultPrevented).toBe(false)
    expect(sideways.refresh).not.toHaveBeenCalled()
    expect(sideways.surface.style.transform).toBe('')
    sideways.stop()

    const scrolled = mounted()
    scrolled.scroller.scrollTop = 8
    touch(scrolled.scroller, 'touchstart', [{ clientX: 20, clientY: 20 }])
    const downward = touch(scrolled.scroller, 'touchmove', [{ clientX: 22, clientY: 220 }])
    touch(scrolled.scroller, 'touchend', [])

    expect(downward.defaultPrevented).toBe(false)
    expect(scrolled.refresh).not.toHaveBeenCalled()
    scrolled.stop()
  })

  it('adds resistance and never lets the surface run away from the finger', () => {
    expect(resistedPull(0)).toBe(0)
    expect(resistedPull(40)).toBeGreaterThan(0)
    expect(resistedPull(80), 'an ordinary thumb pull should cross the detent').toBeGreaterThan(56)
    expect(resistedPull(200)).toBeGreaterThan(resistedPull(40))
    expect(resistedPull(10_000)).toBeLessThanOrEqual(104)
  })
})
