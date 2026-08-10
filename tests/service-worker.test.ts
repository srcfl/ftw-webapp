/* The service worker, held to the one promise that matters.
 *
 * A page must never be served a shell from one build and an asset from
 * another. That failure is invisible in a browser until something explodes at
 * runtime, and it cannot be reproduced by hand, so it is tested here — by
 * deploying twice and checking what the still-running worker answers with
 * while the new one waits.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest'
import { FakeCacheStorage, FakeWorker, type Precache, type SwEvent } from './support/cache-storage.ts'

const ORIGIN = 'https://app.sourceful.energy'

/** Whatever the CDN is currently serving. Replaced wholesale by `deploy`. */
let server = new Map<string, string>()

const caches = new FakeCacheStorage((path) => server.get(path))

function buildOf(version: string): { precache: Precache; files: Map<string, string> } {
  const asset = `/assets/index-${version}.js`
  return {
    precache: { v: version, files: ['/', asset, '/manifest.webmanifest'] },
    files: new Map([
      ['/', `<html>${version}</html>`],
      [asset, `app ${version}`],
      ['/manifest.webmanifest', '{}'],
    ]),
  }
}

/** Puts a build on the server and loads its worker, without installing it. */
async function load(version: string): Promise<FakeWorker> {
  const { precache, files } = buildOf(version)
  server = files

  const worker = new FakeWorker(precache, caches, ORIGIN)
  worker.location = { origin: ORIGIN }

  vi.stubGlobal('self', worker)
  vi.stubGlobal('caches', caches)
  vi.stubGlobal('__PRECACHE__', precache)
  vi.stubGlobal('fetch', async (request: { url: string }) => {
    const path = new URL(request.url).pathname
    const body = server.get(path)
    if (body === undefined) throw new Error(`network: no ${path}`)
    return { body, fromNetwork: true }
  })

  vi.resetModules()
  await import('../src/sw.ts')
  return worker
}

/** A worker that has installed and taken over. */
async function activate(version: string): Promise<FakeWorker> {
  const worker = await load(version)
  await worker.fire('install')
  await worker.fire('activate')
  return worker
}

function request(path: string, mode = 'no-cors', method = 'GET'): SwEvent['request'] {
  return { method, url: `${ORIGIN}${path}`, mode }
}

async function answer(worker: FakeWorker, req: SwEvent['request']): Promise<unknown> {
  const responded = await worker.fire('fetch', req)
  return responded === null ? null : await responded
}

beforeEach(() => {
  vi.unstubAllGlobals()
})

describe('opening without a network', () => {
  it('serves the shell from cache', async () => {
    const worker = await activate('a1')
    server = new Map() // the whole internet, gone

    expect(await answer(worker, request('/', 'navigate'))).toEqual({ body: '<html>a1</html>' })
  })

  it('serves precached assets from cache', async () => {
    const worker = await activate('a1')
    server = new Map()

    expect(await answer(worker, request('/assets/index-a1.js'))).toEqual({ body: 'app a1' })
  })

  it('answers any navigation with the shell, whatever the path', async () => {
    const worker = await activate('a1')
    server = new Map()

    expect(await answer(worker, request('/history/day', 'navigate'))).toEqual({
      body: '<html>a1</html>',
    })
  })
})

describe('an update never mixes two builds', () => {
  it('keeps serving the old build while the new one waits', async () => {
    const running = await activate('a1')

    // A deploy lands and its worker installs. Nothing activates it: no
    // skipWaiting, and the page in front of the user is still alive.
    const waiting = await load('b2')
    await waiting.fire('install')

    // The old worker is still the one answering, and it answers with itself —
    // not with what the server now holds.
    expect(await answer(running, request('/', 'navigate'))).toEqual({ body: '<html>a1</html>' })
    expect(await answer(running, request('/assets/index-a1.js'))).toEqual({ body: 'app a1' })
  })

  it('switches wholesale once the new worker activates', async () => {
    await activate('a1')

    const next = await load('b2')
    await next.fire('install')
    await next.fire('activate')

    expect(await answer(next, request('/', 'navigate'))).toEqual({ body: '<html>b2</html>' })
    expect(await caches.keys()).toEqual(['ftw:b2'])
  })

  it('leaves the old cache alone until the new worker activates', async () => {
    await activate('a1')
    const next = await load('b2')
    await next.fire('install')

    expect((await caches.keys()).sort()).toEqual(['ftw:a1', 'ftw:b2'])
  })

  it('takes over only when the page explicitly asks', async () => {
    const next = await load('b2')
    await next.fire('install')

    expect(next.skipped).toBe(false)
    await next.fire('message', undefined, { data: { type: 'something-else' } })
    expect(next.skipped).toBe(false)

    await next.fire('message', undefined, { data: { type: 'skip-waiting' } })
    expect(next.skipped).toBe(true)
  })
})

describe('what it refuses to touch', () => {
  it('ignores other origins, which is where the box traffic goes', async () => {
    const worker = await activate('a1')
    const relay = { method: 'GET', url: 'https://relay.sourceful.energy/r/7/abcdef/app', mode: 'cors' }

    expect(await worker.fire('fetch', relay)).toBeNull()
  })

  it('ignores anything that is not a GET', async () => {
    const worker = await activate('a1')

    expect(await worker.fire('fetch', request('/', 'cors', 'POST'))).toBeNull()
  })

  it('ignores same-origin paths this build did not emit', async () => {
    const worker = await activate('a1')

    expect(await worker.fire('fetch', request('/api/whatever'))).toBeNull()
  })
})

describe('when the cache has been evicted', () => {
  it('falls back to the network rather than failing', async () => {
    const worker = await activate('a1')
    const cache = await caches.open('ftw:a1')
    cache.evict('/assets/index-a1.js')

    expect(await answer(worker, request('/assets/index-a1.js'))).toEqual({
      body: 'app a1',
      fromNetwork: true,
    })
  })
})

describe('a push from the box', () => {
  /* The payload arrives already rendered — the box holds the catalogue and
   * fills the placeholders, because a push must read as a sentence when this
   * app is not running to write one. What this worker owes in return is
   * showing it verbatim, and showing SOMETHING for every push: Safari
   * withdraws the subscription from a worker it catches staying silent.
   */

  it('shows the box’s sentence exactly as it arrived', async () => {
    const worker = await activate('a1')

    await worker.push(
      JSON.stringify({
        kind: 'charging.session_complete',
        title: 'Car charged',
        body: '38.4 kWh delivered — ready to go.',
      })
    )

    expect(worker.shown).toEqual([
      { title: 'Car charged', body: '38.4 kWh delivered — ready to go.' },
    ])
  })

  it('still shows a notification when the payload is not readable', async () => {
    const worker = await activate('a1')

    await worker.push('not json at all {')

    expect(worker.shown, 'a silent push costs the subscription on Safari').toHaveLength(1)
    expect(worker.shown[0]!.title).not.toBe('')
  })

  it('still shows a notification when the push carries nothing at all', async () => {
    const worker = await activate('a1')

    await worker.push(null)

    expect(worker.shown).toHaveLength(1)
  })

  it('never invents prose: a payload without a title gets the generic sentence', async () => {
    // Half a payload is not a sentence. Showing a body under a made-up title
    // would be this worker writing push prose, which only the catalogue may.
    const worker = await activate('a1')

    await worker.push(JSON.stringify({ kind: 'update.installed', body: 'Now running v9.' }))

    expect(worker.shown).toHaveLength(1)
    expect(worker.shown[0]!.body).not.toContain('Now running v9.')
  })
})

describe('tapping a notification', () => {
  it('fronts the app when a window is already open', async () => {
    const worker = await activate('a1')
    const open = {
      focused: false,
      focus: async () => {
        open.focused = true
      },
    }
    worker.windows = [open]

    const closed = await worker.clickNotification()

    expect(closed).toBe(true)
    expect(open.focused).toBe(true)
    expect(worker.opened, 'opened a second copy of a running app').toEqual([])
  })

  it('opens the app when nothing is open', async () => {
    const worker = await activate('a1')

    await worker.clickNotification()

    expect(worker.opened).toEqual(['/'])
  })
})
