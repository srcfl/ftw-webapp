/* Registering the service worker, and landing a newer build the app is holding.
 *
 * Registration is deliberately late — after `load` — because installing a
 * worker fetches the whole shell again, and the first launch has better things
 * to do with the radio. Nothing here is on the path to the first frame.
 *
 * `waiting` means a newer build is downloaded, verified and parked. The worker
 * alone would take over at the next launch with no page left open, but an
 * installed iOS app is never quite closed (see src/sw.ts), so the app asks for
 * the handover at a safe moment — when it is freshly loaded or when it goes to
 * the background — and reloads the instant the new worker controls the page.
 * The reload is a whole navigation, so no build's shell ever meets another's
 * chunks. A parked build that installs mid-session is not forced on a page
 * someone is reading: it lands when they next leave or reopen.
 */

class ServiceWorkerState {
  /** A newer build is installed and about to take over. */
  waiting = $state(false)
}

export const serviceWorker = new ServiceWorkerState()

/** Set once the page has asked a worker to skip, so the reload fires once. */
let asked = false

export async function registerServiceWorker(): Promise<void> {
  // The worker is emitted by the build, so in development there is nothing at
  // /sw.js and the dev server answers with the HTML fallback — a registration
  // that can only fail, loudly, on every save.
  if (!import.meta.env.PROD) return
  if (!('serviceWorker' in navigator)) return

  try {
    const registration = await navigator.serviceWorker.register('/sw.js')

    // The new worker taking control is the cue to reload — once, into the
    // build it just activated. Guarded so a controllerchange from anything
    // else cannot loop the page.
    let reloaded = false
    navigator.serviceWorker.addEventListener('controllerchange', () => {
      if (reloaded) return
      reloaded = true
      location.reload()
    })

    watch(registration)
  } catch {
    // No worker means no offline launch, and nothing else. Every other path in
    // the app already treats the network as optional, so there is no failure
    // here worth telling anyone about.
  }
}

function watch(registration: ServiceWorkerRegistration): void {
  // Parked by an earlier visit — this launch is exactly the safe moment to
  // land it, before the user has touched anything.
  land(registration.waiting)

  registration.addEventListener('updatefound', () => {
    const worker = registration.installing
    if (!worker) return
    worker.addEventListener('statechange', () => {
      if (worker.state === 'installed') announce(worker)
    })
  })

  // Leaving the app is the other safe moment: hand over while the page is
  // hidden, so the reload happens off-screen and the next look is the new
  // build with no flash.
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') land(registration.waiting)
  })
}

/**
 * A worker only counts as an update if something is already controlling this
 * page. Without that check the very first install — where there is no old
 * build and nothing to replace — would announce itself as a pending update.
 */
function announce(worker: ServiceWorker | null): void {
  if (worker && navigator.serviceWorker.controller) serviceWorker.waiting = true
}

/** Note the parked build, and ask it to take over now. */
function land(worker: ServiceWorker | null): void {
  announce(worker)
  if (worker && navigator.serviceWorker.controller && !asked) {
    asked = true
    worker.postMessage({ type: 'skip-waiting' })
  }
}
