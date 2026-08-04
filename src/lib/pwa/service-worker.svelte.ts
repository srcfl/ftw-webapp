/* Registering the service worker, and noticing when a newer build is waiting.
 *
 * Registration is deliberately late — after `load` — because installing a
 * worker fetches the whole shell again, and the first launch has better things
 * to do with the radio. Nothing here is on the path to the first frame.
 *
 * `waiting` means a newer build is downloaded, verified and parked. It takes
 * over on its own at the next launch with no page left open (see src/sw.ts),
 * so this is information, not a task: there is nothing for the user to press
 * and nothing that breaks if they ignore it.
 */

class ServiceWorkerState {
  /** A newer build is installed and will start at the next clean launch. */
  waiting = $state(false)
}

export const serviceWorker = new ServiceWorkerState()

export async function registerServiceWorker(): Promise<void> {
  // The worker is emitted by the build, so in development there is nothing at
  // /sw.js and the dev server answers with the HTML fallback — a registration
  // that can only fail, loudly, on every save.
  if (!import.meta.env.PROD) return
  if (!('serviceWorker' in navigator)) return

  try {
    const registration = await navigator.serviceWorker.register('/sw.js')
    watch(registration)
  } catch {
    // No worker means no offline launch, and nothing else. Every other path in
    // the app already treats the network as optional, so there is no failure
    // here worth telling anyone about.
  }
}

function watch(registration: ServiceWorkerRegistration): void {
  // Parked by an earlier visit that ended before the app was closed.
  announce(registration.waiting)

  registration.addEventListener('updatefound', () => {
    const worker = registration.installing
    if (!worker) return
    worker.addEventListener('statechange', () => {
      if (worker.state === 'installed') announce(worker)
    })
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
