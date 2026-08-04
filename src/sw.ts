/* The service worker.
 *
 * Two jobs, and deliberately nothing else: open the app without a network,
 * and never mix two builds while doing it.
 *
 * ## Atomicity
 *
 * There is no `skipWaiting` and no `clients.claim`. Both exist to make an
 * update land sooner, and both buy that by letting a page that has already
 * loaded one build start fetching parts of another — a lazy chunk, a stylesheet
 * — from a cache that has moved underneath it. The failure is silent and
 * unreproducible, and it looks to the user like the app broke.
 *
 * So a new build installs quietly, waits, and takes over at the next launch
 * with no live client left. Every request a page makes is answered from the
 * cache belonging to the worker that page was loaded by. Old caches are dropped
 * in `activate`, which by that point cannot run while anyone is still reading
 * from them.
 *
 * The cost is that an update is one launch late. For a home screen app that is
 * opened and dismissed several times a day, that is minutes — and it is paid in
 * exchange for never shipping a half-updated UI.
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
