/* A small pull-to-refresh gesture for an installed app.
 *
 * The document itself never scrolls: each FTW view scrolls inside the fixed
 * shell, which means iOS has no page edge on which to provide its own pull
 * gesture. This owns that one missing interaction on the view scroller.
 *
 * It writes transforms straight to the two compositor layers instead of
 * routing every touchmove through Svelte. That keeps the content under the
 * finger, while the state that belongs to the app remains untouched until a
 * deliberate pull crosses the threshold and is released.
 */

const INTENT_PX = 6
const THRESHOLD_PX = 60
const MAX_PX = 92
const RESISTANCE_PX = 112
const HOLD_PX = 48

type Refresh = () => void | Promise<void>

export interface PullToRefreshOptions {
  scroller: HTMLElement
  surface: HTMLElement
  indicator: HTMLElement
  refresh: Refresh
}

/** Native-like resistance: quick at first, then harder near the limit. */
export function resistedPull(rawPx: number): number {
  if (rawPx <= 0) return 0
  return Math.min(MAX_PX, MAX_PX * (1 - Math.exp(-rawPx / RESISTANCE_PX)))
}

/**
 * Attach the gesture. The caller decides where it is available; FTW enables
 * it only in an installed window, leaving Safari's own page gesture alone.
 */
export function attachPullToRefresh({
  scroller,
  surface,
  indicator,
  refresh,
}: PullToRefreshOptions): () => void {
  let startX = 0
  let startY = 0
  let tracking = false
  let locked = false
  let armed = false
  let settleTimer: ReturnType<typeof setTimeout> | undefined

  const start = (event: TouchEvent) => {
    if (event.touches.length !== 1 || scroller.scrollTop > 0) return
    const touch = event.touches[0]
    if (!touch) return

    clearTimeout(settleTimer)
    startX = touch.clientX
    startY = touch.clientY
    tracking = true
    locked = false
    armed = false
    surface.style.willChange = 'transform'
  }

  const move = (event: TouchEvent) => {
    if (!tracking || event.touches.length !== 1) return
    const touch = event.touches[0]
    if (!touch) return

    const dx = touch.clientX - startX
    const dy = touch.clientY - startY

    if (!locked) {
      if (Math.max(Math.abs(dx), Math.abs(dy)) < INTENT_PX) return
      // A sideways swipe belongs to a chart or the browser. Once rejected it
      // stays rejected until the next touch, so a diagonal move cannot steal
      // the gesture halfway through.
      if (dy <= 0 || Math.abs(dx) >= dy) {
        tracking = false
        clearPull()
        return
      }
      locked = true
    }

    if (dy <= 0 || scroller.scrollTop > 0) {
      cancel()
      return
    }

    // We own the downward gesture now. Without this, WebKit stretches the
    // fixed document behind the surface at the same time as we move it.
    if (event.cancelable) event.preventDefault()

    const distance = resistedPull(dy)
    const ready = distance >= THRESHOLD_PX
    if (ready && !armed) {
      // iOS ignores vibrate; platforms that support it get one small detent.
      navigator.vibrate?.(8)
    }
    armed = ready
    paint(distance, ready)
  }

  const end = () => {
    if (!tracking) return
    tracking = false
    locked = false

    if (!armed) {
      settle()
      return
    }

    armed = false
    surface.removeAttribute('data-pulling')
    surface.style.transform = `translate3d(0, ${HOLD_PX}px, 0)`
    indicator.dataset.state = 'refreshing'
    indicator.style.opacity = '1'
    indicator.style.transform = 'translate3d(-50%, 8px, 0) scale(1)'
    indicator.setAttribute('aria-hidden', 'false')
    indicator.setAttribute('aria-label', 'Refreshing FTW')

    try {
      // A successful refresh navigates. If a host blocks that navigation,
      // release the held surface instead of leaving the app stuck halfway.
      void Promise.resolve(refresh()).then(
        () => {
          settleTimer = setTimeout(settle, 1_500)
        },
        settle
      )
    } catch {
      settle()
    }
  }

  const cancel = () => {
    if (!tracking) return
    tracking = false
    locked = false
    armed = false
    settle()
  }

  const paint = (distance: number, ready: boolean) => {
    const progress = Math.min(1, distance / THRESHOLD_PX)
    surface.dataset.pulling = 'true'
    surface.style.transform = `translate3d(0, ${distance.toFixed(2)}px, 0)`
    indicator.dataset.state = ready ? 'ready' : 'pulling'
    indicator.style.opacity = String(Math.max(0, Math.min(1, (distance - 8) / 28)))
    indicator.style.transform = `translate3d(-50%, ${(distance * 0.55 - 28).toFixed(2)}px, 0) scale(${(
      0.78 + progress * 0.22
    ).toFixed(3)})`
    indicator.style.setProperty('--pull-turn', `${Math.round(progress * 280)}deg`)
  }

  const settle = () => {
    tracking = false
    locked = false
    armed = false
    surface.removeAttribute('data-pulling')
    surface.style.transform = 'translate3d(0, 0, 0)'
    indicator.dataset.state = 'settling'
    indicator.style.opacity = '0'
    indicator.style.transform = 'translate3d(-50%, -28px, 0) scale(0.78)'
    indicator.setAttribute('aria-hidden', 'true')
    indicator.removeAttribute('aria-label')
    clearTimeout(settleTimer)
    settleTimer = setTimeout(clearPull, 240)
  }

  const clearPull = () => {
    surface.style.removeProperty('transform')
    surface.style.removeProperty('will-change')
    surface.removeAttribute('data-pulling')
    indicator.style.removeProperty('opacity')
    indicator.style.removeProperty('transform')
    indicator.style.removeProperty('--pull-turn')
    indicator.dataset.state = 'idle'
    indicator.setAttribute('aria-hidden', 'true')
    indicator.removeAttribute('aria-label')
  }

  scroller.addEventListener('touchstart', start, { passive: true })
  scroller.addEventListener('touchmove', move, { passive: false })
  scroller.addEventListener('touchend', end, { passive: true })
  scroller.addEventListener('touchcancel', cancel, { passive: true })

  return () => {
    clearTimeout(settleTimer)
    scroller.removeEventListener('touchstart', start)
    scroller.removeEventListener('touchmove', move)
    scroller.removeEventListener('touchend', end)
    scroller.removeEventListener('touchcancel', cancel)
    clearPull()
  }
}
