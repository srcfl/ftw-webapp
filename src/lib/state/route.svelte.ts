/* Navigation, in full.
 *
 * Four screens. A router library would bring a matcher, a history stack and
 * a lifecycle to choose between them, none of which this app has a use for.
 * The hash is enough, and it comes with the back button already working —
 * which is what a phone user reaches for first.
 *
 * Reading location.hash costs nothing at startup, so this stays off the path
 * to the first frame. The History view itself is loaded on demand.
 */

export type Route = 'now' | 'plan' | 'history' | 'box'

const ROUTES: Route[] = ['now', 'plan', 'history', 'box']

function fromHash(hash: string): Route {
  const name = hash.replace(/^#\/?/, '')
  return ROUTES.find((r) => r === name) ?? 'now'
}

export class Router {
  current = $state<Route>('now')

  constructor() {
    if (typeof location !== 'undefined') this.current = fromHash(location.hash)
  }

  /** Returns a teardown, so a component can own the listener. */
  listen(): () => void {
    const onHashChange = () => {
      this.current = fromHash(location.hash)
    }
    addEventListener('hashchange', onHashChange)
    return () => removeEventListener('hashchange', onHashChange)
  }

  go(route: Route): void {
    // Through the hash rather than straight to the field, so the back button
    // and a shared link both land where the user expects.
    location.hash = route === 'now' ? '' : `#/${route}`
    this.current = route
  }
}
