import { applyD1Migrations, env as cloudflareEnv, reset, type D1Migration } from 'cloudflare:test'
import { exportJWK, generateKeyPair, SignJWT } from 'jose'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import worker from '../src/index.ts'
import { collectOps, parseOps, OPS_URL } from '../src/ops.ts'
import { dashboardData } from '../src/store.ts'
import type { AppEnv } from '../src/types.ts'
import written from './fixtures/cloud-ops.json'

interface TestEnv extends AppEnv { TEST_MIGRATIONS: D1Migration[] }
const env = cloudflareEnv as unknown as TestEnv
const key = 'ops-test-key-0123456789abcdef0123456789abcdef'
const HOUR = 3600_000

beforeEach(async () => {
  await reset()
  await applyD1Migrations(env.DB, env.TEST_MIGRATIONS)
})
afterEach(() => { vi.unstubAllGlobals() })

const hourOf = (ms: number) => new Date(Math.floor(ms / HOUR) * HOUR).toISOString().replace('.000Z', 'Z')

// One settled hour, as ftwcloudd writes it.
function hour(ms: number, over: Record<string, unknown> = {}) {
  return {
    hour: hourOf(ms), seconds: 3600, starts: 0,
    counters: { bytes_out_box: 2_000_000, bytes_out_app: 3_000_000, tun_bytes_up: 400_000, tun_bytes_down: 100_000, drops_tun_rate_up: 2, drops_phone_too_slow: 0,
      apns_alert_ok: 9, apns_alert_gone: 1, webpush_ok: 2, mcp_ok: 30, mcp_tool_error: 2, mcp_refused: 1, drains: 0, drained_sockets: 0, drain_left_open: 0 },
    gauges: { sockets_box: { min: 3, mean: 4.5, max: 6 }, sockets_app: { min: 0, mean: 1.25, max: 2 }, homes_connected: { min: 3, mean: 4, max: 5 },
      transport_sockets_box_quic: { min: 2, mean: 3, max: 4 }, transport_sockets_box_websocket: { min: 1, mean: 1, max: 1 } },
    latency_ms: { forward_seconds_tun_up: { n: 120, p50: 0.25, p95: 1, p99: 2.5 }, handshake_seconds_box: { n: 4, p50: 5, p95: 25, p99: 25 },
      mcp_call_seconds: { n: 32, p50: 100, p95: 500, p99: null } },
    ...over,
  }
}

const daysBack = (nowMs: number, n: number) => new Date(nowMs - n * 24 * HOUR).toISOString().slice(0, 10)
function feed(nowMs: number, hours = [hour(nowMs - 3 * HOUR), hour(nowMs - 2 * HOUR)], over: Record<string, unknown> = {}) {
  return {
    schema: 'ftw.cloud-ops/1',
    meaning: 'sums over the whole service, and closed daily totals over all reports; no home, device or address',
    shard: 's1', observed_at: new Date(nowMs).toISOString().replace(/\.\d{3}Z$/, 'Z'), hours,
    fleet_days: [{ date: daysBack(nowMs, 1), reports: 2, ftw_versions: { 'v0.155.1-beta.1': 2 }, channels: { beta: 2 }, drivers: { sungrow: 2, easee_cloud: 1 },
      battery_kwh: { '5-15': 2 }, price_zones: { SE3: 2 }, install_age: { '1-6m': 2 } }],
    energy_days: [{ date: daysBack(nowMs, 4), reports: 2, pv_generation_kwh: 15, grid_import_kwh: 40, grid_export_kwh: 4, battery_charge_kwh: 9, battery_discharge_kwh: 8, vehicle_charge_kwh: 7 }],
    ...over,
  }
}

describe('FTW Cloud ops feed', () => {
  // The fixture is ftwcloudd's own answer (srcfl/ftw-cloud internal/ops),
  // with test series renamed: two hours, and a closed fleet day and energy
  // date of two reports each.
  it('takes a feed ftwcloudd wrote', () => {
    const now = Date.parse(written.observed_at)
    expect(parseOps(written, now)).toEqual(written)
    expect(written.hours[0]!.latency_ms['example_slow_seconds']).toEqual({ n: 1, p50: null, p95: null, p99: null })
    expect(written.fleet_days[0]!.reports).toBe(2)
    expect(written.energy_days[0]!.grid_import_kwh).toBe(40)
  })

  it('takes exactly the fields ftwcloudd writes and refuses anything that could name a home', () => {
    const now = Date.UTC(2026, 9, 24, 6, 23)
    const good = feed(now)
    expect(parseOps(good, now)).toEqual(good)
    const variants: [string, (f: any) => void][] = [
      ['a home id at the top', f => { f.home = 'canaryhomecanaryhomecanary' }],
      ['a device on an hour', f => { f.hours[0].device = 'd1' }],
      ['an address on a gauge', f => { f.hours[0].gauges.sockets_box.addr = '192.0.2.1' }],
      ['a home on a latency', f => { f.hours[0].latency_ms.handshake_seconds_box.home = 'x' }],
      ['a box id on a fleet day', f => { f.fleet_days[0].box = 'b' }],
      ['a series name with a dot', f => { f.hours[0].counters['home.abc'] = 1 }],
      ['a series name in capitals', f => { f.hours[0].counters['Home'] = 1 }],
      ['a text counter', f => { f.hours[0].counters.drops_x = '1' }],
      ['a negative counter', f => { f.hours[0].counters.drops_x = -1 }],
      ['a fractional counter', f => { f.hours[0].counters.drops_x = 1.5 }],
      ['a gauge mean above its max', f => { f.hours[0].gauges.sockets_box.mean = 7 }],
      ['quantiles out of order', f => { f.hours[0].latency_ms.handshake_seconds_box.p95 = 1 }],
      ['a quantile after a null one', f => { f.hours[0].latency_ms.mcp_call_seconds = { n: 1, p50: null, p95: 1, p99: 1 } }],
      ['quantiles without a count', f => { f.hours[0].latency_ms.mcp_call_seconds = { n: 0, p50: 1, p95: 1, p99: 1 } }],
      ['an hour still open', f => { f.hours.push(hour(now)) }],
      ['hours out of order', f => { f.hours.reverse() }],
      ['an hour off the clock', f => { f.hours[0].hour = '2026-10-24T03:30:00Z' }],
      ['an hour past 91 days', f => { f.hours.unshift(hour(now - 92 * 24 * HOUR)) }],
      ['more than a week of hours', f => { f.hours = Array.from({ length: 169 }, (_, i) => hour(now - (170 - i) * HOUR)) }],
      ['an old observation', f => { f.observed_at = new Date(now - 3 * HOUR).toISOString() }],
      ['another schema', f => { f.schema = 'ftw.cloud-ops/2' }],
      ['another meaning', f => { f.meaning = 'per home' }],
      ['a fleet label above the reports', f => { f.fleet_days[0].drivers.sungrow = 3 }],
      ['a fleet label of zero', f => { f.fleet_days[0].drivers.sungrow = 0 }],
      ['a fleet day in the future', f => { f.fleet_days[0].date = '2026-10-25' }],
      ['a fleet day still open', f => { f.fleet_days[0].date = '2026-10-24' }],
      ['an energy date still open', f => { f.energy_days[0].date = '2026-10-21' }],
      ['a home on an energy day', f => { f.energy_days[0].home = 'x' }],
      ['an energy sum above a report\'s most', f => { f.energy_days[0].pv_generation_kwh = 2001 }],
      ['an energy day without reports', f => { f.energy_days[0].reports = 0 }],
      ['an array for counters', f => { f.hours[0].counters = [] }],
    ]
    for (const [what, change] of variants) {
      const f = structuredClone(good)
      change(f)
      expect(() => parseOps(f, now), what).toThrow()
    }
  })

  it('waits without a key and asks with it, from the newest hour kept', async () => {
    const now = Date.UTC(2026, 9, 24, 6, 23)
    const calls: { url: string; auth: string | null; redirect?: string | undefined }[] = []
    vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
      calls.push({ url: String(input), auth: new Headers(init?.headers).get('authorization'), redirect: init?.redirect })
      return Response.json(feed(now))
    })
    await collectOps(env, now)
    expect(calls).toHaveLength(0)
    expect(await env.DB.prepare("SELECT ok, detail FROM collector_runs WHERE source='cloud:ops'").first()).toEqual({ ok: 1, detail: 'awaiting key' })

    const keyed = { ...env, CLOUD_OPS_KEY: key }
    await collectOps(keyed, now)
    expect(calls[0]).toEqual({ url: OPS_URL + '?since=' + encodeURIComponent('2026-07-26T06:00:00Z'), auth: 'Bearer ' + key, redirect: 'manual' })
    const rows = await env.DB.prepare('SELECT shard, hour, seconds, starts FROM cloud_ops_hours ORDER BY hour').all()
    expect(rows.results).toEqual([
      { shard: 's1', hour: '2026-10-24T03:00:00.000Z', seconds: 3600, starts: 0 },
      { shard: 's1', hour: '2026-10-24T04:00:00.000Z', seconds: 3600, starts: 0 },
    ])

    // The next pull starts an hour before the newest kept, and a restart's
    // late part replaces that hour.
    const later = now + HOUR
    vi.stubGlobal('fetch', async (input: RequestInfo | URL) => {
      calls.push({ url: String(input), auth: null })
      return Response.json(feed(later, [hour(now - 2 * HOUR, { seconds: 3600, starts: 1 }), hour(now - HOUR)]))
    })
    await collectOps(keyed, later)
    expect(calls[1]!.url).toBe(OPS_URL + '?since=' + encodeURIComponent('2026-10-24T03:00:00Z'))
    const after = await env.DB.prepare('SELECT hour, starts FROM cloud_ops_hours ORDER BY hour').all()
    expect(after.results).toEqual([
      { hour: '2026-10-24T03:00:00.000Z', starts: 0 },
      { hour: '2026-10-24T04:00:00.000Z', starts: 1 },
      { hour: '2026-10-24T05:00:00.000Z', starts: 0 },
    ])
  })

  it('treats a Cloud without the key as waiting, and a refusal, a redirect or bad data as a failure', async () => {
    const now = Date.UTC(2026, 9, 24, 6, 23)
    const keyed = { ...env, CLOUD_OPS_KEY: key }
    vi.stubGlobal('fetch', async () => new Response(null, { status: 404 }))
    await collectOps(keyed, now)
    expect(await env.DB.prepare("SELECT ok, detail FROM collector_runs WHERE source='cloud:ops'").first()).toEqual({ ok: 1, detail: 'awaiting key on Cloud' })
    for (const answer of [
      () => new Response(null, { status: 401 }),
      () => new Response(null, { status: 302, headers: { location: 'https://elsewhere.example/' } }),
      () => Response.json({ ...feed(now), home: 'canaryhomecanaryhomecanary' }),
      () => new Response('x'.repeat(1024 * 1024 + 1)),
    ]) {
      vi.stubGlobal('fetch', async () => answer())
      await expect(collectOps(keyed, now)).rejects.toThrow()
      expect(await env.DB.prepare("SELECT ok FROM collector_runs WHERE source='cloud:ops'").first('ok')).toBe(0)
    }
    expect(await env.DB.prepare('SELECT COUNT(*) AS n FROM cloud_ops_hours').first('n')).toBe(0)
  })

  it('stores only sums and exact day totals, under these columns', async () => {
    const columns = async (table: string) => (await env.DB.prepare(`PRAGMA table_info(${table})`).all<{ name: string }>()).results.map(c => c.name).sort()
    expect(await columns('cloud_ops_hours')).toEqual(['counters_json', 'gauges_json', 'hour', 'latency_json', 'observed_at', 'seconds', 'shard', 'starts'])
    expect(await columns('cloud_ops_days')).toEqual(['energy_json', 'fleet_json', 'id', 'observed_at'])
  })

  it('shows the service and exact fleet days in the private view only', async () => {
    const now = Date.UTC(2026, 9, 24, 6, 23)
    vi.stubGlobal('fetch', async () => Response.json(feed(now, [hour(now - 3 * HOUR, { starts: 1, counters: { ...hour(0).counters, drains: 1, drained_sockets: 9, drain_left_open: 1 } }), hour(now - 2 * HOUR)])))
    await collectOps({ ...env, CLOUD_OPS_KEY: key }, now)

    const pub = await dashboardData(env, false, now)
    expect(pub).not.toHaveProperty('cloud_ops')
    expect(JSON.stringify(pub)).not.toContain('easee_cloud')
    expect(JSON.stringify(pub)).not.toContain('2026-10-20')
    const ops = (await dashboardData(env, true, now))['cloud_ops'] as Record<string, any>
    expect(ops.state).toBe('visible')
    expect(ops.now.boxes).toEqual({ min: 3, mean: 4, max: 5 })
    expect(ops.now.box_quic_percent).toBe(75)
    expect(ops.month.bytes_out).toBe(10_000_000)
    expect(ops.month.budget_bytes).toBe(100e9)
    expect(ops.hours).toHaveLength(2)
    expect(ops.week.drops).toEqual([{ name: 'tun_rate_up', count: 4 }])
    expect(ops.week.push.alert).toEqual({ results: { ok: 18, gone: 2 }, sent: 20, ok_percent: 90 })
    expect(ops.week.mcp.outcomes).toEqual([{ name: 'ok', count: 60 }, { name: 'tool_error', count: 4 }, { name: 'refused', count: 2 }])
    expect(ops.deploys).toEqual([expect.objectContaining({ starts: 1, drains: 1, drained_sockets: 9, left_open: 1, box_handshakes: 4, box_handshake_p99_ms: 25 })])
    expect(ops.fleet.days).toEqual([expect.objectContaining({ date: '2026-10-23', reports: 2, drivers: { sungrow: 2, easee_cloud: 1 } })])
    expect(ops.energy.days).toEqual([expect.objectContaining({ date: '2026-10-20', reports: 2, pv_generation_kwh: 15, vehicle_charge_kwh: 7 })])

    const { privateKey, publicKey } = await generateKeyPair('RS256', { extractable: true })
    const jwk = await exportJWK(publicKey)
    const token = await new SignJWT({ type: 'app', email: 'operator@ftw.energy' }).setProtectedHeader({ alg: 'RS256', kid: 'k' })
      .setIssuer('https://test.cloudflareaccess.com').setAudience('test-audience').setIssuedAt().setExpirationTime('5m').sign(privateKey)
    vi.stubGlobal('fetch', async () => Response.json({ keys: [{ ...jwk, alg: 'RS256', use: 'sig', kid: 'k' }] }))
    const res = await worker.fetch(new Request('https://stats.ftw.energy/api/admin', { headers: { 'cf-access-jwt-assertion': token } }), env)
    expect(res.status).toBe(200)
    expect(await res.json<Record<string, any>>()).toHaveProperty('cloud_ops.fleet.days')

    const page = await worker.fetch(new Request('https://stats.ftw.energy/admin', { headers: { 'cf-access-jwt-assertion': token } }), env)
    expect(await page.text()).toContain('Service operations')
  })
})
