import { applyD1Migrations, env as cloudflareEnv, reset, type D1Migration } from 'cloudflare:test'
import { exportJWK, generateKeyPair, SignJWT } from 'jose'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import worker from '../src/index.ts'
import { collectGitHub } from '../src/github.ts'
import { collectSiteTraffic } from '../src/site.ts'
import type { AppEnv, RelayIngestBody } from '../src/types.ts'

interface TestEnv extends AppEnv {
  TEST_MIGRATIONS: D1Migration[]
}

const env = cloudflareEnv as unknown as TestEnv
const secret = '0123456789abcdef0123456789abcdef'

beforeEach(async () => {
  await reset()
  await applyD1Migrations(env.DB, env.TEST_MIGRATIONS)
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('project stats Worker', () => {
  it('serves a strict public shell and an empty source-backed response', async () => {
    const page = await worker.fetch(new Request('https://stats.ftw.energy/'), env)
    expect(page.status).toBe(200)
    expect(page.headers.get('content-security-policy')).toContain("default-src 'none'")
    expect(page.headers.get('x-frame-options')).toBe('DENY')
    const html = await page.text()
    expect(html).toContain('Project growth, without user tracking.')
    expect(html).toContain('Project at a glance')
    expect(html).toContain('Aggregate relay activity')
    expect(html).toContain('Daily counts stay hidden while the public sample is small.')

    const response = await worker.fetch(new Request('https://stats.ftw.energy/api/public'), env)
    const data = await response.json<Record<string, any>>()
    expect(response.status).toBe(200)
    expect(data.mode).toBe('public')
    expect(data.github.repositories).toEqual([])
    expect(data.fleet).toMatchObject({
      state: 'empty',
      reports_30d: null,
      minimum: 10,
      observed: { ftw_versions: [], drivers: [] },
    })
    expect(data.relay_status).toEqual({
      state: 'empty',
      observed_at: null,
      meaning: 'export heartbeat only; no relay load or user counts',
    })
    expect(data.relay_activity).toMatchObject({
      state: 'empty',
      rooms_band: null,
      sockets_band: null,
      frames_band: null,
      bytes_band: null,
    })
  })

  it('fails the private view closed without a verified Access token', async () => {
    const api = await worker.fetch(new Request('https://stats.ftw.energy/api/admin'), env)
    const page = await worker.fetch(new Request('https://stats.ftw.energy/admin'), env)
    expect(api.status).toBe(403)
    expect(page.status).toBe(403)
  })

  it('opens the private API only after checking the Access signature, issuer and audience', async () => {
    const { privateKey, publicKey } = await generateKeyPair('RS256', { extractable: true })
    const publicJwk = await exportJWK(publicKey)
    const token = await new SignJWT({ type: 'app', email: 'operator@ftw.energy' })
      .setProtectedHeader({ alg: 'RS256', kid: 'test-key' })
      .setIssuer('https://test.cloudflareaccess.com')
      .setAudience('test-audience')
      .setIssuedAt()
      .setExpirationTime('5m')
      .sign(privateKey)
    vi.stubGlobal('fetch', async (input: RequestInfo | URL) => {
      const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input : input.url)
      expect(url.href).toBe('https://test.cloudflareaccess.com/cdn-cgi/access/certs')
      return githubResponse({ keys: [{ ...publicJwk, alg: 'RS256', use: 'sig', kid: 'test-key' }] })
    })

    const response = await worker.fetch(
      new Request('https://stats.ftw.energy/api/admin', {
        headers: { 'cf-access-jwt-assertion': token },
      }),
      env
    )
    const data = await response.json<Record<string, unknown>>()
    expect(response.status).toBe(200)
    expect(data['mode']).toBe('private')
    expect(data).toHaveProperty('relay')
    expect(data).toHaveProperty('collectors')
  })

  it('accepts a signed aggregate relay body and withholds a small public fleet', async () => {
    const now = new Date()
    const earlier = new Date(now.getTime() - 60_000)
    const earlierPayload = relayPayload(earlier, 1)
    await sendRelay(earlierPayload, earlier)
    const payload = relayPayload(now, 1)
    payload.relay.uptime_seconds = 360
    payload.relay.frames_routed = 1540
    payload.relay.bytes_routed = 2_005_000
    const response = await sendRelay(payload, now)
    expect(response.status).toBe(204)

    const stored = await env.DB.prepare(
      'SELECT rooms, sockets FROM relay_snapshots ORDER BY observed_at DESC LIMIT 1'
    ).first<{ rooms: number; sockets: number }>()
    expect(stored).toEqual({ rooms: 2, sockets: 3 })

    const publicResponse = await worker.fetch(new Request('https://stats.ftw.energy/api/public'), env)
    const data = await publicResponse.json<Record<string, any>>()
    expect(data.fleet).toMatchObject({ state: 'withheld', reports_30d: null, minimum: 10 })
    expect(data.fleet.observed).toEqual({
      ftw_versions: ['v1.16.1-beta.22'],
      drivers: ['easee_cloud'],
    })
    expect(data.fleet.dimensions).toEqual({})
    expect(JSON.stringify(data.fleet)).not.toContain('SE3')
    expect(JSON.stringify(data.fleet)).not.toContain('5-15')
    expect(JSON.stringify(data.fleet)).not.toContain('0-1m')
    expect(data.relay_status).toMatchObject({ state: 'reporting', observed_at: now.toISOString() })
    expect(data.relay_activity).toMatchObject({
      state: 'reporting',
      observed_at: now.toISOString(),
      rooms_band: '<10',
      sockets_band: '<10',
      frames_band: '1k–9.9k',
      bytes_band: '1–9 MB',
    })
    for (const field of ['rooms', 'sockets', 'frames_routed', 'bytes_routed', 'latest', 'series']) {
      expect(JSON.stringify(data.relay_activity)).not.toContain('"' + field + '"')
    }
    expect(data.freshness.relay).toBe(now.toISOString())
    expect(data.freshness.fleet).toBe(now.toISOString())
  })

  it('shows a public total at ten reports but still drops small labels', async () => {
    const now = new Date()
    const payload = relayPayload(now, 10)
    payload.fleet.days[0]!.channels = { beta: 9, unknown: 1 }
    payload.fleet.days[0]!.drivers = { easee_cloud: 10 }
    await sendRelay(payload, now)

    const response = await worker.fetch(new Request('https://stats.ftw.energy/api/public'), env)
    const data = await response.json<Record<string, any>>()
    expect(data.fleet.reports_30d).toBe(10)
    expect(data.fleet.days[0].reports).toBe(10)
    expect(data.fleet.dimensions.channels).toEqual({})
    expect(data.fleet.dimensions.drivers).toEqual({ easee_cloud: 10 })
    expect(data.fleet.observed).toEqual({
      ftw_versions: ['v1.16.1-beta.22'],
      drivers: ['easee_cloud'],
    })
  })

  it('rejects a changed body after it has been signed', async () => {
    const now = new Date()
    const payload = relayPayload(now, 1)
    const body = JSON.stringify(payload)
    const timestamp = String(Math.floor(now.getTime() / 1000))
    const signature = await sign(timestamp, body)
    const changed = body.replace('"rooms":2', '"rooms":3')
    const response = await worker.fetch(
      new Request('https://stats.ftw.energy/api/ingest/relay', {
        method: 'POST',
        body: changed,
        headers: {
          'content-type': 'application/json',
          'x-ftw-timestamp': timestamp,
          'x-ftw-signature': `v1=${signature}`,
        },
      }),
      env
    )
    expect(response.status).toBe(401)
    expect(await env.DB.prepare('SELECT COUNT(*) AS count FROM relay_snapshots').first('count')).toBe(0)
  })

  it('rejects fields that could turn an aggregate into an identity log', async () => {
    const now = new Date()
    const payload = relayPayload(now, 1) as RelayIngestBody & { gateway_id?: string }
    payload.gateway_id = 'box-7'
    const response = await sendRelay(payload, now)
    expect(response.status).toBe(400)
  })

  it('collects repository work and reach from bounded GitHub responses', async () => {
    const calls: string[] = []
    vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input : input.url)
      calls.push(url.pathname + url.search)
      const headers = new Headers(init?.headers)
      expect(headers.get('authorization')).toBe('Bearer github-test-token')

      if (url.pathname === '/repos/srcfl/ftw') {
        return githubResponse({
          stargazers_count: 14,
          forks_count: 9,
          subscribers_count: 2,
          pushed_at: '2026-08-14T11:00:00Z',
        })
      }
      if (url.pathname === '/repos/srcfl/ftw/pulls') {
        return githubResponse([
          { draft: true, user: { login: 'fredde', type: 'User' } },
          { draft: false, user: { login: 'dependabot[bot]', type: 'Bot' } },
        ])
      }
      if (url.pathname === '/repos/srcfl/ftw/issues') {
        return githubResponse([{ number: 1 }, { number: 2, pull_request: {} }])
      }
      if (url.pathname === '/repos/srcfl/ftw/contributors') {
        return githubResponse([{ login: 'fredde' }, { login: 'dependabot[bot]' }])
      }
      if (url.pathname === '/search/issues') {
        return githubResponse({ total_count: url.searchParams.get('q')?.includes('is:merged') ? 8 : 5 })
      }
      if (url.pathname === '/repos/srcfl/ftw/releases/latest') {
        return githubResponse({ tag_name: 'v1.16.1-beta.22', published_at: '2026-08-13T18:00:00Z' })
      }
      return new Response(null, { status: 404 })
    })

    await collectGitHub(env, false, Date.UTC(2026, 7, 14, 12))
    const row = await env.DB.prepare('SELECT * FROM github_snapshots WHERE repo = ?')
      .bind('ftw')
      .first<Record<string, unknown>>()
    expect(row).toMatchObject({
      stars: 14,
      forks: 9,
      watchers: 2,
      open_prs: 2,
      draft_prs: 1,
      dependency_prs: 1,
      open_issues: 1,
      merged_prs_30d: 8,
      closed_issues_30d: 5,
      contributors: 2,
      latest_release: 'v1.16.1-beta.22',
    })
    expect(calls).toHaveLength(7)
  })

  it('collects 14 complete days of server-side site traffic without visitor ids', async () => {
    const now = new Date()
    now.setUTCHours(12, 0, 0, 0)
    const nowMs = now.getTime()
    const todayMs = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate())
    const firstDay = new Date(todayMs - 14 * 86400000).toISOString().slice(0, 10)
    const lastDay = new Date(todayMs - 86400000).toISOString().slice(0, 10)
    vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
      expect(String(input)).toBe('https://api.cloudflare.com/client/v4/graphql')
      const headers = new Headers(init?.headers)
      expect(headers.get('authorization')).toBe('Bearer cloudflare-analytics-test-token')
      const body = JSON.parse(String(init?.body)) as { query: string; variables: Record<string, string> }
      expect(body.variables).toEqual({
        zoneTag: '0123456789abcdef0123456789abcdef',
        hostname: 'ftw.energy',
        start: `${firstDay}T00:00:00Z`,
        end: new Date(todayMs).toISOString(),
      })
      expect(body.query.match(/httpRequestsAdaptiveGroups/g) ?? []).toHaveLength(1)
      expect(body.query).toContain('orderBy: [datetimeHour_ASC]')
      expect(body.query).toContain('clientRequestHTTPHost: $hostname')
      expect(body.query).toContain('dimensions { datetimeHour }')
      const traffic = Array.from({ length: 14 }, (_, index) => {
        const date = new Date(todayMs - (14 - index) * 86400000).toISOString().slice(0, 10)
        return {
          count: 100 + index,
          avg: { sampleInterval: index === 13 ? 5 : 1 },
          sum: { visits: index + 1, edgeResponseBytes: 1000 * (index + 1) },
          dimensions: { datetimeHour: `${date}T12:00:00Z` },
        }
      })
      return githubResponse({ data: { viewer: { zones: [{ traffic }] } }, errors: null })
    })

    await collectSiteTraffic(env, nowMs)

    const rows = await env.DB.prepare(
      'SELECT date, requests, visits, response_bytes, sample_interval FROM site_traffic_daily ORDER BY date'
    ).all<Record<string, unknown>>()
    expect(rows.results).toHaveLength(14)
    expect(rows.results[0]).toMatchObject({ date: firstDay, requests: 100, visits: 1 })
    expect(rows.results.at(-1)).toMatchObject({
      date: lastDay,
      requests: 113,
      visits: 14,
      response_bytes: 14000,
      sample_interval: 5,
    })

    const response = await worker.fetch(new Request('https://stats.ftw.energy/api/public'), env)
    const data = await response.json<Record<string, any>>()
    expect(data.site).toMatchObject({
      state: 'visible',
      meaning: 'Cloudflare visits, not users or unique people',
      sampled: true,
      totals: { visits_14d: 105, requests_14d: 1491, response_bytes_14d: 105000 },
    })
    expect(JSON.stringify(data.site)).not.toContain('visitor_id')
  })

  it('stores a safe cause when Cloudflare rejects an expensive GraphQL query', async () => {
    vi.stubGlobal('fetch', async () =>
      githubResponse({
        data: null,
        errors: [{ message: 'query exceeded the resource budget for an internal account' }],
      })
    )

    await expect(collectSiteTraffic(env, Date.UTC(2026, 7, 16, 12))).rejects.toMatchObject({
      name: 'CloudflareGraphQLError',
    })

    const run = await env.DB.prepare(
      'SELECT ok, detail FROM collector_runs WHERE source = ? ORDER BY finished_at DESC LIMIT 1'
    )
      .bind('site:ftw.energy')
      .first<{ ok: number; detail: string }>()
    expect(run).toEqual({ ok: 0, detail: 'graphql-query-limit' })
    expect(JSON.stringify(run)).not.toContain('internal account')
  })

  it('retries site traffic on the hourly schedule', async () => {
    let siteCalls = 0
    vi.stubGlobal('fetch', async (input: RequestInfo | URL) => {
      const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input : input.url)
      if (url.hostname === 'api.cloudflare.com') {
        siteCalls += 1
        return githubResponse({ data: { viewer: { zones: [{ traffic: [] }] } }, errors: null })
      }
      if (url.pathname === '/repos/srcfl/ftw') {
        return githubResponse({
          stargazers_count: 0,
          forks_count: 0,
          subscribers_count: 0,
          pushed_at: null,
        })
      }
      if (
        url.pathname === '/repos/srcfl/ftw/pulls' ||
        url.pathname === '/repos/srcfl/ftw/issues' ||
        url.pathname === '/repos/srcfl/ftw/contributors'
      ) {
        return githubResponse([])
      }
      if (url.pathname === '/search/issues') return githubResponse({ total_count: 0 })
      if (url.pathname === '/repos/srcfl/ftw/releases/latest') return new Response(null, { status: 404 })
      return new Response(null, { status: 404 })
    })

    await worker.scheduled(
      { cron: '3 * * * *', scheduledTime: Date.UTC(2026, 7, 16, 9, 3), noRetry() {} },
      env
    )

    expect(siteCalls).toBe(1)
    expect(await env.DB.prepare('SELECT COUNT(*) AS count FROM site_traffic_daily').first('count')).toBe(14)
    const run = await env.DB.prepare(
      'SELECT ok, detail FROM collector_runs WHERE source = ? ORDER BY finished_at DESC LIMIT 1'
    )
      .bind('site:ftw.energy')
      .first<{ ok: number; detail: string }>()
    expect(run).toEqual({ ok: 1, detail: '14-day traffic window' })
  })
})

function relayPayload(now: Date, reports: number): RelayIngestBody {
  return {
    schema: 'ftw.relay-stats/1',
    observed_at: now.toISOString(),
    relay: {
      uptime_seconds: 300,
      rooms: 2,
      sockets: 3,
      frames_routed: 40,
      bytes_routed: 5000,
    },
    fleet: {
      schema: 'ftw.fleet-stats/1',
      meaning: 'reports, not unique boxes',
      days: [
        {
          date: now.toISOString().slice(0, 10),
          reports,
          ftw_versions: { 'v1.16.1-beta.22': reports },
          channels: { beta: reports },
          drivers: { easee_cloud: reports },
          battery_kwh: { '5-15': reports },
          price_zones: { SE3: reports },
          install_age: { '0-1m': reports },
        },
      ],
    },
  }
}

async function sendRelay(payload: unknown, now: Date): Promise<Response> {
  const body = JSON.stringify(payload)
  const timestamp = String(Math.floor(now.getTime() / 1000))
  const signature = await sign(timestamp, body)
  return worker.fetch(
    new Request('https://stats.ftw.energy/api/ingest/relay', {
      method: 'POST',
      body,
      headers: {
        'content-type': 'application/json',
        'x-ftw-timestamp': timestamp,
        'x-ftw-signature': `v1=${signature}`,
      },
    }),
    env
  )
}

async function sign(timestamp: string, body: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  )
  const signature = await crypto.subtle.sign(
    'HMAC',
    key,
    new TextEncoder().encode(`${timestamp}.${body}`)
  )
  return [...new Uint8Array(signature)].map((byte) => byte.toString(16).padStart(2, '0')).join('')
}

function githubResponse(value: unknown): Response {
  return new Response(JSON.stringify(value), {
    headers: { 'content-type': 'application/json; charset=utf-8' },
  })
}
