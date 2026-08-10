/* Whether the system has already kept this window out of the home indicator.
 *
 * An installed iOS web app is laid out short of the screen: the window, the
 * visual viewport and everything in them end above the home indicator, and
 * `env(safe-area-inset-bottom)` goes on reporting the inset anyway. Honour it
 * there and the same strip is reserved twice — once by iOS outside the web
 * view, once by us inside it — which is a band of empty bar at the bottom of
 * the app and the reason it looked like dead space.
 *
 * Measured rather than assumed: 812 of an 846-point screen, with the inset
 * still reading 34px. So the test is exactly that — a standalone iOS window
 * whose height falls short of the screen by about the inset it claims. Every
 * other case (a Safari tab, Android, a desktop, an installed app whose window
 * really does reach the bottom) is left alone, because there the inset is the
 * only thing keeping the tab bar off the indicator.
 */

/** How much shorter than the screen counts as "the system took it". */
const ENOUGH_PX = 8

export interface Window {
  /** iOS only: true from the home screen, false in a tab, undefined elsewhere. */
  standalone: boolean | undefined
  innerHeight: number
  /** The screen's own height, in the same units. */
  screenHeight: number
  /** What `env(safe-area-inset-bottom)` resolves to, in pixels. */
  insetBottom: number
}

export function reservedByTheOs(w: Window): boolean {
  if (w.standalone !== true) return false
  if (w.insetBottom <= 0) return false
  // Short of the screen by roughly the inset it is still claiming. Compared
  // loosely: the point is that the gap exists, not its exact size, and a
  // future iOS that trims it differently should still be recognised.
  return w.screenHeight - w.innerHeight >= Math.min(w.insetBottom, ENOUGH_PX)
}

/** Read the live window, and mark the document when the system got there first. */
export function markIfReserved(): void {
  const nav = navigator as Navigator & { standalone?: boolean }
  const probe = document.createElement('div')
  probe.style.cssText = 'position:fixed;bottom:0;height:env(safe-area-inset-bottom,0px);'
  document.body.append(probe)
  const insetBottom = probe.getBoundingClientRect().height
  probe.remove()

  if (
    reservedByTheOs({
      standalone: nav.standalone,
      innerHeight: window.innerHeight,
      screenHeight: window.screen.height,
      insetBottom,
    })
  ) {
    document.documentElement.classList.add('reserved-by-the-os')
  }
}
