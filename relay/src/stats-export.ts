import { createHmac } from 'node:crypto'
import type { RelayAggregateStats } from './server.ts'

const DEFAULT_INTERVAL_MS = 5 * 60_000
const DEFAULT_TIMEOUT_MS = 10_000
const MAX_BODY_BYTES = 240 * 1024

export interface StatsExportOptions {
  url: string
  secret: string
  snapshot: () => RelayAggregateStats
  intervalMs?: number
  timeoutMs?: number
  now?: () => number
  log?: (line: string) => void
  post?: (url: string, init: RequestInit) => Promise<{ status: number }>
}

export class RelayStatsExporter {
  #opts: Required<StatsExportOptions>
  #timer: ReturnType<typeof setInterval> | null = null
  #inFlight = false
  #abort: AbortController | null = null

  constructor(opts: StatsExportOptions) {
    const url = new URL(opts.url)
    if (url.protocol !== 'https:' || url.username || url.password) {
      throw new Error('relay stats export needs an HTTPS URL')
    }
    if (Buffer.byteLength(opts.secret) < 32) {
      throw new Error('relay stats export secret is too short')
    }
    this.#opts = {
      url: url.toString(),
      secret: opts.secret,
      snapshot: opts.snapshot,
      intervalMs: opts.intervalMs ?? DEFAULT_INTERVAL_MS,
      timeoutMs: opts.timeoutMs ?? DEFAULT_TIMEOUT_MS,
      now: opts.now ?? (() => Date.now()),
      log: opts.log ?? (() => {}),
      post: opts.post ?? ((target, init) => fetch(target, init)),
    }
  }

  start(): void {
    if (this.#timer) return
    void this.sendOnce()
    this.#timer = setInterval(() => void this.sendOnce(), this.#opts.intervalMs)
    this.#timer.unref?.()
  }

  stop(): void {
    if (this.#timer) clearInterval(this.#timer)
    this.#timer = null
    this.#abort?.abort()
  }

  async sendOnce(): Promise<boolean> {
    if (this.#inFlight) return false
    this.#inFlight = true
    const abort = new AbortController()
    this.#abort = abort
    const timeout = setTimeout(() => abort.abort(), this.#opts.timeoutMs)
    timeout.unref?.()

    try {
      const snapshot = this.#opts.snapshot()
      let days = snapshot.fleet.days
      let body = JSON.stringify(snapshot)
      while (Buffer.byteLength(body) > MAX_BODY_BYTES && days.length > 1) {
        days = days.slice(0, -1)
        body = JSON.stringify({ ...snapshot, fleet: { ...snapshot.fleet, days } })
      }
      if (Buffer.byteLength(body) > MAX_BODY_BYTES) {
        this.#opts.log('relay: stats export too large')
        return false
      }
      const timestamp = String(Math.floor(this.#opts.now() / 1000))
      const signature = createHmac('sha256', this.#opts.secret)
        .update(`${timestamp}.${body}`)
        .digest('hex')
      const response = await this.#opts.post(this.#opts.url, {
        method: 'POST',
        body,
        signal: abort.signal,
        headers: {
          'content-type': 'application/json',
          'user-agent': 'ftw-relay/1',
          'x-ftw-timestamp': timestamp,
          'x-ftw-signature': `v1=${signature}`,
        },
      })
      if (response.status < 200 || response.status >= 300) {
        this.#opts.log('relay: stats export rejected')
        return false
      }
      return true
    } catch {
      this.#opts.log('relay: stats export failed')
      return false
    } finally {
      clearTimeout(timeout)
      this.#abort = null
      this.#inFlight = false
    }
  }
}
