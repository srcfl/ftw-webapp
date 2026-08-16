import { saveCollectorRun } from './collector.ts'
import type { AppEnv } from './types.ts'

const API_URL = 'https://api.cloudflare.com/client/v4/graphql'
const MAX_RESPONSE_BYTES = 256 * 1024
const HISTORY_DAYS = 14
const MAX_HOURLY_GROUPS = HISTORY_DAYS * 24
const ZONE_ID_RE = /^[a-f0-9]{32}$/i
const HOSTNAME_RE = /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/i
const HOUR_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:00:00Z$/

type JsonRecord = Record<string, unknown>
type GraphQLErrorCode = 'graphql-access-denied' | 'graphql-query-limit' | 'graphql-error'

interface SiteDay {
  date: string
  requests: number
  visits: number
  responseBytes: number
  sampleInterval: number
}

export async function collectSiteTraffic(env: AppEnv, nowMs = Date.now()): Promise<void> {
  const startedAt = new Date(nowMs).toISOString()
  try {
    const zoneId = checkedZoneId(env.CLOUDFLARE_ZONE_ID)
    const token = checkedToken(env.CLOUDFLARE_ANALYTICS_TOKEN)
    const hostname = checkedHostname(env.SITE_HOSTNAME)
    const days = completeDays(nowMs)
    const lastDay = days[days.length - 1]!
    const start = `${days[0]}T00:00:00Z`
    const end = new Date(Date.parse(`${lastDay}T00:00:00Z`) + 24 * 60 * 60_000).toISOString()
    const response = await fetch(API_URL, {
      method: 'POST',
      headers: {
        accept: 'application/json',
        authorization: `Bearer ${token}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        query: analyticsQuery(),
        variables: { zoneTag: zoneId, hostname, start, end },
      }),
      signal: AbortSignal.timeout(15_000),
    })
    if (!response.ok) {
      await response.body?.cancel()
      throw new CloudflareRequestError(response.status)
    }

    const text = await boundedResponseText(response)
    const rows = parseAnalyticsResponse(JSON.parse(text) as unknown, days)
    const observedAt = new Date(nowMs).toISOString()
    await env.DB.batch(
      rows.map((row) =>
        env.DB.prepare(
          `INSERT INTO site_traffic_daily
            (date, hostname, requests, visits, response_bytes, sample_interval, observed_at)
           VALUES (?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(date) DO UPDATE SET
            hostname = excluded.hostname,
            requests = excluded.requests,
            visits = excluded.visits,
            response_bytes = excluded.response_bytes,
            sample_interval = excluded.sample_interval,
            observed_at = excluded.observed_at`
        ).bind(
          row.date,
          hostname,
          row.requests,
          row.visits,
          row.responseBytes,
          row.sampleInterval,
          observedAt
        )
      )
    )
    await saveCollectorRun(env.DB, 'site:ftw.energy', startedAt, true, '14-day traffic window')
  } catch (error) {
    await saveCollectorRun(env.DB, 'site:ftw.energy', startedAt, false, siteCollectorFailureCode(error))
    throw error
  }
}

function completeDays(nowMs: number): string[] {
  const today = new Date(nowMs)
  today.setUTCHours(0, 0, 0, 0)
  return Array.from({ length: HISTORY_DAYS }, (_, index) => {
    const offset = HISTORY_DAYS - index
    return new Date(today.getTime() - offset * 24 * 60 * 60_000).toISOString().slice(0, 10)
  })
}

function analyticsQuery(): string {
  return `query SiteTraffic($zoneTag: string, $hostname: string, $start: Time, $end: Time) {
    viewer {
      zones(filter: { zoneTag: $zoneTag }) {
        traffic: httpRequestsAdaptiveGroups(
          limit: 10000
          orderBy: [datetimeHour_ASC]
          filter: {
            datetime_geq: $start
            datetime_lt: $end
            clientRequestHTTPHost: $hostname
            requestSource: "eyeball"
          }
        ) {
          count
          avg { sampleInterval }
          sum { visits edgeResponseBytes }
          dimensions { datetimeHour }
        }
      }
    }
  }`
}

function parseAnalyticsResponse(value: unknown, days: string[]): SiteDay[] {
  const root = record(value, 'Cloudflare response')
  const errors = root['errors']
  if (Array.isArray(errors) && errors.length > 0) {
    throw new CloudflareGraphQLError(graphQLErrorCode(errors))
  }
  const data = record(root['data'], 'Cloudflare data')
  const viewer = record(data['viewer'], 'Cloudflare viewer')
  const zones = viewer['zones']
  if (!Array.isArray(zones) || zones.length !== 1) throw new TypeError('Cloudflare zone was not unique')
  const zone = record(zones[0], 'Cloudflare zone')
  const groups = zone['traffic']
  if (!Array.isArray(groups) || groups.length > MAX_HOURLY_GROUPS) {
    throw new TypeError('Cloudflare traffic window was not bounded')
  }

  const byDate = new Map<string, SiteDay>(
    days.map((date) => [date, { date, requests: 0, visits: 0, responseBytes: 0, sampleInterval: 1 }])
  )
  const seenHours = new Set<string>()
  for (const raw of groups) {
    const group = record(raw, 'Cloudflare traffic group')
    const dimensions = record(group['dimensions'], 'Cloudflare traffic dimensions')
    const hour = checkedHour(dimensions['datetimeHour'])
    const day = byDate.get(hour.slice(0, 10))
    if (!day || seenHours.has(hour)) throw new TypeError('Cloudflare traffic hour was outside the window')
    seenHours.add(hour)
    const sum = record(group['sum'], 'Cloudflare traffic sum')
    const avg = record(group['avg'], 'Cloudflare traffic average')
    day.requests = safeAdd(day.requests, nonNegativeInt(group['count'], 'request count'))
    day.visits = safeAdd(day.visits, nonNegativeInt(sum['visits'], 'visit count'))
    day.responseBytes = safeAdd(
      day.responseBytes,
      nonNegativeInt(sum['edgeResponseBytes'], 'response bytes')
    )
    day.sampleInterval = Math.max(
      day.sampleInterval,
      positiveNumber(avg['sampleInterval'], 'sample interval')
    )
  }

  return days.map((date) => {
    const day = byDate.get(date)
    if (!day) throw new TypeError('Cloudflare traffic day was missing')
    return day
  })
}

async function boundedResponseText(response: Response): Promise<string> {
  const length = Number(response.headers.get('content-length') ?? 0)
  if (Number.isFinite(length) && length > MAX_RESPONSE_BYTES) {
    await response.body?.cancel()
    throw new RangeError('Cloudflare response was too large')
  }
  if (!response.body) return ''

  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []
  let total = 0
  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    total += value.byteLength
    if (total > MAX_RESPONSE_BYTES) {
      await reader.cancel()
      throw new RangeError('Cloudflare response was too large')
    }
    chunks.push(value)
  }
  const bytes = new Uint8Array(total)
  let offset = 0
  for (const chunk of chunks) {
    bytes.set(chunk, offset)
    offset += chunk.byteLength
  }
  return new TextDecoder().decode(bytes)
}

export function siteCollectorFailureCode(error: unknown): string {
  if (error instanceof CloudflareRequestError) return `http-${error.status}`
  if (error instanceof CloudflareGraphQLError) return error.code
  if (error instanceof DOMException && (error.name === 'TimeoutError' || error.name === 'AbortError')) {
    return 'request-timeout'
  }
  if (error instanceof RangeError) return 'response-too-large'
  if (error instanceof SyntaxError) return 'invalid-json'
  if (error instanceof TypeError) return 'invalid-response'
  if (
    error instanceof Error &&
    (error.message.includes('is not configured') || error.message.includes('is invalid'))
  ) {
    return 'configuration-error'
  }
  return 'unexpected-error'
}

function graphQLErrorCode(errors: unknown[]): GraphQLErrorCode {
  const message = errors
    .map((error) => {
      if (typeof error !== 'object' || error === null || Array.isArray(error)) return ''
      const value = (error as JsonRecord)['message']
      return typeof value === 'string' ? value.toLowerCase() : ''
    })
    .join(' ')
  if (/(auth|permission|access denied|not authorized|forbidden)/.test(message)) {
    return 'graphql-access-denied'
  }
  if (/(limit|complex|resource|budget|timeout|too many)/.test(message)) {
    return 'graphql-query-limit'
  }
  return 'graphql-error'
}

function checkedHour(value: unknown): string {
  if (typeof value !== 'string' || !HOUR_RE.test(value)) {
    throw new TypeError('datetimeHour was not an hour')
  }
  return value
}

function checkedZoneId(value: string | undefined): string {
  if (!value || !ZONE_ID_RE.test(value)) throw new Error('CLOUDFLARE_ZONE_ID is not configured')
  return value
}

function checkedToken(value: string | undefined): string {
  if (!value || value.length < 20 || value.length > 512) {
    throw new Error('CLOUDFLARE_ANALYTICS_TOKEN is not configured')
  }
  return value
}

function checkedHostname(value: string): string {
  if (!HOSTNAME_RE.test(value)) throw new Error('SITE_HOSTNAME is invalid')
  return value.toLowerCase()
}

function nonNegativeInt(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) throw new TypeError(`${label} was not a count`)
  return value as number
}

function safeAdd(left: number, right: number): number {
  const total = left + right
  if (!Number.isSafeInteger(total)) throw new TypeError('Cloudflare traffic total was too large')
  return total
}

function positiveNumber(value: unknown, label: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 1) {
    throw new TypeError(`${label} was not positive`)
  }
  return value
}

function record(value: unknown, label: string): JsonRecord {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new TypeError(`${label} was not an object`)
  }
  return value as JsonRecord
}

class CloudflareRequestError extends Error {
  override name = 'CloudflareRequestError'

  constructor(readonly status: number) {
    super(`Cloudflare returned HTTP ${status}`)
  }
}

class CloudflareGraphQLError extends Error {
  override name = 'CloudflareGraphQLError'

  constructor(readonly code: GraphQLErrorCode) {
    super('Cloudflare returned GraphQL errors')
  }
}
