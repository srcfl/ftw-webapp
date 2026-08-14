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
    expect(await page.text()).toContain('Project growth, without user tracking.')

    const response = await worker.fetch(new Request('https://stats.ftw.energy/api/public'), env)
    const data = await response.json<Record<string, any>>()
    expect(response.status).toBe(200)
    expect(data.mode).toBe('public')
    expect(data.github.repositories).toEqual([])
    expect(data.fleet).toMatchObject({ state: 'empty', reports_30d: null, minimum: 10 })
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
    const payload = relayPayload(now, 1)
    const response = await sendRelay(payload, now)
    expect(response.status).toBe(204)

    const stored = await env.DB.prepare('SELECT rooms, sockets FROM relay_snapshots').first<{
      rooms: number
      sockets: number
    }>()
    expect(stored).toEqual({ rooms: 2, sockets: 3 })

    const publicResponse = await worker.fetch(new Request('https://stats.ftw.energy/api/public'), env)
    const data = await publicResponse.json<Record<string, any>>()
    expect(data.fleet).toMatchObject({ state: 'withheld', reports_30d: null, minimum: 10 })
    expect(JSON.stringify(data)).not.toContain('easee_cloud')
    expect(JSON.stringify(data)).not.toContain('rooms')
    expect(data.freshness.relay).toBeUndefined()
    expect(data.freshness.fleet).toBeNull()
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
    const nowMs = Date.UTC(2026, 7, 14, 12)
    vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
      expect(String(input)).toBe('https://api.cloudflare.com/client/v4/graphql')
      const headers = new Headers(init?.headers)
      expect(headers.get('authorization')).toBe('Bearer cloudflare-analytics-test-token')
      const body = JSON.parse(String(init?.body)) as { query: string; variables: Record<string, string> }
      expect(body.variables).toEqual({
        zoneTag: '0123456789abcdef0123456789abcdef',
        hostname: 'ftw.energy',
      })
      expect(body.query).toContain('day0: httpRequestsAdaptiveGroups')
      expect(body.query).toContain('day13: httpRequestsAdaptiveGroups')
      expect(body.query).toContain('clientRequestHTTPHost: $hostname')
      const zone = Object.fromEntries(
        Array.from({ length: 14 }, (_, index) => [
          `day${index}`,
          [
            {
              count: 100 + index,
              avg: { sampleInterval: index === 13 ? 5 : 1 },
              sum: { visits: index + 1, edgeResponseBytes: 1000 * (index + 1) },
            },
          ],
        ])
      )
      return githubResponse({ data: { viewer: { zones: [zone] } }, errors: null })
    })

    await collectSiteTraffic(env, nowMs)

    const rows = await env.DB.prepare(
      'SELECT date, requests, visits, response_bytes, sample_interval FROM site_traffic_daily ORDER BY date'
    ).all<Record<string, unknown>>()
    expect(rows.results).toHaveLength(14)
    expect(rows.results[0]).toMatchObject({ date: '2026-07-31', requests: 100, visits: 1 })
    expect(rows.results.at(-1)).toMatchObject({
      date: '2026-08-13',
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
