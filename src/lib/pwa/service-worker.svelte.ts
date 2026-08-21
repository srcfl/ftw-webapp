/* Registering the service worker, and landing a newer build the app is holding.
 *
 * Registration is deliberately late — after `load` — because installing a
 * worker fetches the whole shell again, and the first launch has better things
 * to do with the radio. Nothing here is on the path to the first frame.
 *
 * A newer build downloads, verifies and parks without touching the live page.
 * The worker alone would take over at the next launch with no page left open,
 * but an installed iOS app is never quite closed (see src/sw.ts), so the app
 * asks for the handover itself at a safe moment: at launch when a build already
 * waits, or while the app is hidden. It also checks again whenever a kept-alive
 * page returns to the foreground. No update control belongs on screen.
 * The reload is a whole navigation, so no build's shell ever meets another's
 * chunks. A parked build that installs mid-session is not forced on a page
 * someone is reading: it lands when they next leave or reopen.
 */

/** Set once the page has asked a worker to skip, so the reload fires once. */
let asked = false

/** The registration watched by the page, and used by pull-to-refresh. */
let currentRegistration: ServiceWorkerRegistration | null = null
/** The worker announced as ready; kept even before registration.waiting updates. */
let parkedWorker: ServiceWorker | null = null

/** Install the one reload listener before any path can request a handover. */
let reloadArmed = false
let reloaded = false

function armReload(): void {
  if (reloadArmed || !('serviceWorker' in navigator)) return
  reloadArmed = true
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    if (reloaded) return
    reloaded = true
    location.reload()
  })
}

export async function registerServiceWorker(): Promise<void> {
  // The worker is emitted by the build, so in development there is nothing at
  // /sw.js and the dev server answers with the HTML fallback — a registration
  // that can only fail, loudly, on every save.
  if (!import.meta.env.PROD) return
  if (!('serviceWorker' in navigator)) return

  try {
    const registration = await navigator.serviceWorker.register('/sw.js')
    currentRegistration = registration
    armReload()
    watch(registration)

    // A page kept in the foreground never hides, so visibilitychange never
    // gives it a reason to look for a newer build — it would only learn of
    // one at the next launch. Check once now; this already runs after `load`,
    // so nothing moves onto the critical path.
    void checkForAppUpdate()
  } catch {
    // No worker means no offline launch, and nothing else. Every other path in
    // the app already treats the network as optional, so there is no failure
    // here worth telling anyone about.
  }
}

function watch(registration: ServiceWorkerRegistration): void {
  // Parked by an earlier visit. This launch is a safe handover point: the
  // page has only just loaded and nobody has started a task in it yet.
  land(registration.waiting)

  registration.addEventListener('updatefound', () => {
    const worker = registration.installing
    if (!worker) return
    worker.addEventListener('statechange', () => {
      if (worker.state === 'installed') park(worker)
    })
  })

  // Leaving the app is the other safe moment: hand over while hidden, so the
  // reload happens off-screen. Returning may resume this same page without a
  // load event on iOS, so check again without asking the user to refresh.
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') {
      land(registration.waiting ?? parkedWorker)
    } else {
      void checkForAppUpdate()
    }
  })
}

/**
 * Hold a complete build until the page is safe to replace.
 *
 * A worker only counts as an update if something already controls this page.
 * If it finishes after the app was hidden, the visibility event has already
 * passed, so land it here rather than waiting for another leave.
 */
function park(worker: ServiceWorker | null): void {
  if (!worker || !navigator.serviceWorker.controller) return
  parkedWorker = worker
  if (document.visibilityState === 'hidden') requestTakeover(worker)
}

function requestTakeover(worker: ServiceWorker): void {
  armReload()
  if (!asked) {
    asked = true
    worker.postMessage({ type: 'skip-waiting' })
  }
}

/**
 * Check for a new build and park it when one is ready.
 *
 * This is the action behind the installed app's pull gesture. The update
 * check runs beside the in-place data refresh. Reloading when no update exists
 * would only ask the active worker for the same cached shell, discard every
 * mounted view, and make a live app feel like a web page.
 */
export async function checkForAppUpdate(): Promise<boolean> {
  if ('serviceWorker' in navigator) {
    try {
      const registration =
        currentRegistration ?? (await navigator.serviceWorker.getRegistration()) ?? null
      if (registration) {
        currentRegistration = registration
        armReload()

        if (!registration.waiting) await registration.update()
        const worker = registration.waiting ?? (await waitForInstall(registration.installing))
        if (worker && navigator.serviceWorker.controller) {
          park(worker)
          return true
        }
      }
    } catch {
      // Offline is a valid state. The current worker has a complete shell.
    }
  }
  return false
}

/** Wait briefly for a worker found by update() to finish installing. */
async function waitForInstall(worker: ServiceWorker | null): Promise<ServiceWorker | null> {
  if (!worker) return null
  if (worker.state === 'installed') return worker
  if (worker.state === 'redundant') return null

  return await new Promise((resolve) => {
    let done = false
    const finish = (value: ServiceWorker | null) => {
      if (done) return
      done = true
      clearTimeout(timeout)
      worker.removeEventListener('statechange', changed)
      resolve(value)
    }
    const changed = () => {
      if (worker.state === 'installed') finish(worker)
      else if (worker.state === 'redundant') finish(null)
    }
    const timeout = setTimeout(() => finish(null), 2_000)
    worker.addEventListener('statechange', changed)
  })
}

/** Note the parked build, and ask it to take over now. */
function land(worker: ServiceWorker | null): void {
  if (!worker || !navigator.serviceWorker.controller) return
  parkedWorker = worker
  requestTakeover(worker)
}
