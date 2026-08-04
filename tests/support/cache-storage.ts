/* A Cache Storage stand-in, and a way to run src/sw.ts against it.
 *
 * The service worker's whole job is which bytes come back after a deploy, so
 * the interesting behaviour is only visible with a store that survives across
 * two installs. This keeps enough of the API for that — open, keys, delete,
 * addAll, match — and nothing else.
 */

export interface FakeResponse {
  body: string
}

export class FakeCache {
  #entries = new Map<string, FakeResponse>()

  constructor(private readonly fetchFile: (path: string) => string | undefined) {}

  async addAll(paths: string[]): Promise<void> {
    for (const path of paths) {
      const body = this.fetchFile(path)
      if (body === undefined) throw new Error(`addAll: ${path} is not on the server`)
      this.#entries.set(path, { body })
    }
  }

  async match(path: string): Promise<FakeResponse | undefined> {
    return this.#entries.get(path)
  }

  evict(path: string): void {
    this.#entries.delete(path)
  }
}

export class FakeCacheStorage {
  #caches = new Map<string, FakeCache>()

  constructor(private readonly fetchFile: (path: string) => string | undefined) {}

  async open(name: string): Promise<FakeCache> {
    let cache = this.#caches.get(name)
    if (!cache) {
      cache = new FakeCache(this.fetchFile)
      this.#caches.set(name, cache)
    }
    return cache
  }

  async keys(): Promise<string[]> {
    return [...this.#caches.keys()]
  }

  async delete(name: string): Promise<boolean> {
    return this.#caches.delete(name)
  }
}

export interface Precache {
  v: string
  files: string[]
}

type Listener = (event: SwEvent) => void

/** The subset of the event surface src/sw.ts uses. */
export interface SwEvent {
  request?: { method: string; url: string; mode: string }
  waitUntil(promise: Promise<unknown>): void
  respondWith(response: Promise<unknown>): void
}

/**
 * One registered worker: its listeners, its precache manifest, and the shared
 * Cache Storage every worker on the origin sees.
 */
export class FakeWorker {
  #listeners = new Map<string, Listener[]>()
  responded: Promise<unknown> | null = null

  constructor(
    readonly precache: Precache,
    readonly caches: FakeCacheStorage,
    readonly origin: string
  ) {}

  addEventListener(type: string, listener: Listener): void {
    const list = this.#listeners.get(type) ?? []
    list.push(listener)
    this.#listeners.set(type, list)
  }

  location = { origin: '' }

  /** Fires one event and settles everything its handler passed to waitUntil. */
  async fire(type: string, request?: SwEvent['request']): Promise<Promise<unknown> | null> {
    const pending: Promise<unknown>[] = []
    let responded: Promise<unknown> | null = null

    const event: SwEvent = {
      ...(request ? { request } : {}),
      waitUntil: (promise) => void pending.push(promise),
      respondWith: (promise) => {
        responded = promise
      },
    }

    for (const listener of this.#listeners.get(type) ?? []) listener(event)
    await Promise.all(pending)
    return responded
  }
}
