import { saveCollectorRun } from './collector.ts'
import type { AppEnv } from './types.ts'

const API_URL = 'https://api.cloudflare.com/client/v4/graphql'
const MAX_RESPONSE_BYTES = 256 * 1024
const HISTORY_DAYS = 14
const ZONE_ID_RE = /^[a-f0-9]{32}$/i
const HOSTNAME_RE = /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/i

type JsonRecord = Record<string, unknown>

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
    const query = analyticsQuery(days)
    const response = await fetch(API_URL, {
      method: 'POST',
      headers: {
        accept: 'application/json',
        authorization: `Bearer ${token}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ query, variables: { zoneTag: zoneId, hostname } }),
      signal: AbortSignal.timeout(15_000),
    })
    if (!response.ok) {
      await response.body?.cancel()
      throw new CloudflareRequestError(response.status)
    }

    const length = Number(response.headers.get('content-length') ?? 0)
    if (Number.isFinite(length) && length > MAX_RESPONSE_BYTES) {
      await response.body?.cancel()
      throw new RangeError('Cloudflare response was too large')
    }
    const text = await response.text()
    if (new TextEncoder().encode(text).byteLength > MAX_RESPONSE_BYTES) {
      throw new RangeError('Cloudflare response was too large')
    }
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
    await saveCollectorRun(env.DB, 'site:ftw.energy', startedAt, false, 'traffic request failed')
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

function analyticsQuery(days: string[]): string {
  const selections = days.map((date, index) => {
    const start = `${date}T00:00:00Z`
    const end = new Date(Date.parse(start) + 24 * 60 * 60_000).toISOString()
    return `day${index}: httpRequestsAdaptiveGroups(
      limit: 1
      filter: {
        datetime_geq: "${start}"
        datetime_lt: "${end}"
        clientRequestHTTPHost: $hostname
        requestSource: "eyeball"
      }
    ) {
      count
      avg { sampleInterval }
      sum { visits edgeResponseBytes }
    }`
  })
  return `query SiteTraffic($zoneTag: string, $hostname: string) {
    viewer {
      zones(filter: { zoneTag: $zoneTag }) {
        ${selections.join('\n')}
      }
    }
  }`
}

function parseAnalyticsResponse(value: unknown, days: string[]): SiteDay[] {
  const root = record(value, 'Cloudflare response')
  const errors = root['errors']
  if (Array.isArray(errors) && errors.length > 0) throw new TypeError('Cloudflare returned GraphQL errors')
  const data = record(root['data'], 'Cloudflare data')
  const viewer = record(data['viewer'], 'Cloudflare viewer')
  const zones = viewer['zones']
  if (!Array.isArray(zones) || zones.length !== 1) throw new TypeError('Cloudflare zone was not unique')
  const zone = record(zones[0], 'Cloudflare zone')

  return days.map((date, index) => {
    const groups = zone[`day${index}`]
    if (!Array.isArray(groups) || groups.length > 1) throw new TypeError('Cloudflare day was not bounded')
    if (groups.length === 0) {
      return { date, requests: 0, visits: 0, responseBytes: 0, sampleInterval: 1 }
    }
    const group = record(groups[0], 'Cloudflare traffic group')
    const sum = record(group['sum'], 'Cloudflare traffic sum')
    const avg = record(group['avg'], 'Cloudflare traffic average')
    return {
      date,
      requests: nonNegativeInt(group['count'], 'request count'),
      visits: nonNegativeInt(sum['visits'], 'visit count'),
      responseBytes: nonNegativeInt(sum['edgeResponseBytes'], 'response bytes'),
      sampleInterval: positiveNumber(avg['sampleInterval'], 'sample interval'),
    }
  })
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

  constructor(status: number) {
    super(`Cloudflare returned HTTP ${status}`)
  }
}
