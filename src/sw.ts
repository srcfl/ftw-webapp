/* The service worker.
 *
 * Three jobs, and deliberately nothing else: open the app without a network,
 * never mix two builds while doing it, and put the box's pushes on the lock
 * screen exactly as they arrived.
 *
 * ## Atomicity
 *
 * There is no install-time `skipWaiting` and no `clients.claim`. Both make an
 * update land sooner, and both buy that by letting a page that has already
 * loaded one build start fetching parts of another — a lazy chunk, a stylesheet
 * — from a cache that has moved underneath it. The failure is silent and
 * unreproducible, and it looks to the user like the app broke.
 *
 * So a new build installs quietly and waits. It takes over on its own at the
 * next launch with no live client left — but an installed iOS app is never
 * that: the OS keeps the page alive in the app switcher across a swipe-away,
 * so "no live client left" can be days off, and the user sits on a build that
 * has long since been replaced. The client asks for the handover instead, at a
 * moment when nothing is mid-flight: it messages `skip-waiting` only while the
 * page is hidden or when a waiting build is found at launch, and reloads when
 * the new worker takes control. That reload is a whole navigation, so the page
 * still never runs one build's shell against another's chunks — atomicity is kept,
 * the handover is just asked for rather than waited out. Old caches are dropped
 * in `activate`, which by then cannot run while anyone is still reading them.
 *
 * ## What is cached
 *
 * Exactly the files this build emitted, listed at build time by the
 * `ftw:service-worker` plugin in vite.config.ts. Nothing else is ever stored.
 * Box traffic rides a WebSocket to another origin and never reaches a fetch
 * handler at all, but the same-origin and precache checks below mean that even
 * if it did, it would pass straight through.
 */

// A worker imports nothing and exports nothing. This is here so TypeScript
// treats the file as a module rather than a script sharing the global scope,
// and Rollup drops it from the output.
export {}

/** Replaced during the build. `files` are absolute paths, `v` hashes them. */
declare const __PRECACHE__: { v: string; files: string[] }

const sw = self as unknown as ServiceWorkerGlobalScope

const CACHE = `ftw:${__PRECACHE__.v}`
const FILES = __PRECACHE__.files
const SHELL = '/'

sw.addEventListener('install', (event) => {
  event.waitUntil(caches.open(CACHE).then((cache) => cache.addAll(FILES)))
})

sw.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      // Safe here and nowhere earlier: activation is what proves no page is
      // still being served from the build these caches belong to.
      for (const name of await caches.keys()) {
        if (name.startsWith('ftw:') && name !== CACHE) await caches.delete(name)
      }
    })()
  )
})

// The client asks for the handover when nothing is mid-flight. Honoured only
// here, never on install, so a waiting build still never jumps a live page on
// its own — the page decides the moment, and reloads the instant this lands.
sw.addEventListener('message', (event) => {
  if ((event.data as { type?: unknown } | null)?.type === 'skip-waiting') void sw.skipWaiting()
})

sw.addEventListener('fetch', (event) => {
  const request = event.request
  if (request.method !== 'GET') return

  const url = new URL(request.url)
  if (url.origin !== sw.location.origin) return

  // Cache first, so opening the app never waits on a network that may not be
  // there. A build is only ever replaced wholesale, so this cannot serve a
  // shell that disagrees with the assets it will ask for next.
  if (request.mode === 'navigate') {
    event.respondWith(fromCache(SHELL, request))
    return
  }

  // Anything this build did not emit — including anything ever added that
  // talks to a server — is left alone.
  if (!FILES.includes(url.pathname)) return
  event.respondWith(fromCache(url.pathname, request))
})

/**
 * A precached response, or the network.
 *
 * The network fallback is for an evicted entry, not for freshness: every
 * asset path here is either content-addressed or the shell itself, so a
 * fetch can only return the same bytes or fail.
 */
async function fromCache(path: string, request: Request): Promise<Response> {
  const cache = await caches.open(CACHE)
  return (await cache.match(path)) ?? fetch(request)
}

/* ## Push
 *
 * The payload arrives already rendered by the box — title and body from
 * contract/push-catalogue.yaml, the one place push sentences are written —
 * and is shown verbatim. Nothing is decided here: a worker that rewrites
 * prose is a second copy of the catalogue, and it would rot.
 *
 * Every push shows a notification, whatever arrived. Safari withdraws the
 * subscription from a worker it catches swallowing a push, so a payload
 * this handler cannot read still shows the app's one generic sentence —
 * never nothing.
 */

sw.addEventListener('push', (event) => {
  let title = 'Something happened at home'
  let body = 'Open the app to see what.'
  try {
    const payload = event.data?.json() as { title?: unknown; body?: unknown } | null
    if (payload && typeof payload.title === 'string' && payload.title !== '') {
      title = payload.title
      body = typeof payload.body === 'string' ? payload.body : ''
    }
  } catch {
    /* Not the JSON it claimed to be. The generic sentence stands. */
  }
  event.waitUntil(sw.registration.showNotification(title, { body }))
})

sw.addEventListener('notificationclick', (event) => {
  event.notification.close()
  event.waitUntil(
    (async () => {
      // The app is one screen, so any open client is the right one to front.
      const open = await sw.clients.matchAll({ type: 'window', includeUncontrolled: true })
      if (open[0]) await open[0].focus()
      else await sw.clients.openWindow('/')
    })()
  )
})
