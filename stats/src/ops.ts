import { saveCollectorRun } from './collector.ts'
import { energyFields } from './energy.ts'
import type { AppEnv, FleetDay } from './types.ts'

// FTW Cloud's internal feed: the service's own hours, each a sum over the
// whole service, and the exact totals of the anonymous fleet and energy
// reports for closed days. Private view only. The parser takes exactly these
// fields, so a field that could name a home, a device or an address cannot
// ride in.

const HOUR_MS = 3600_000
const DAY_MS = 24 * HOUR_MS
export const OPS_URL = 'https://cloud.ftw.energy/v1/ops'
export const OPS_KEPT_DAYS = 90
const MAX_HOURS = 168
const MAX_BYTES = 1024 * 1024
const MEANING = 'sums over the whole service, and closed daily totals over all reports; no home, device or address'
// A box names one of the last three closed days, so the newest closed
// energy date is four days back.
const ENERGY_OPEN_DAYS = 4
// AWS's free data out, across the account, a month.
export const EGRESS_BUDGET_BYTES = 100e9

const dimensions = ['ftw_versions', 'channels', 'drivers', 'battery_kwh', 'price_zones', 'install_age'] as const
// How the boxes ran, from ftw.fleet/2 reports only: each a few fixed words.
// A day without such a report has none of these fields.
export const healthBuckets = {
  plan_solve: ['none', '0-1s', '1-5s', '5s+'],
  plan_fallbacks: ['none', '0', '1-3', '4+'],
  driver_errors: ['none', '0', '0-1%', '1%+'],
  update: ['none', 'ok', 'failed'],
} as const
const health = Object.keys(healthBuckets) as (keyof typeof healthBuckets)[]

export interface Gauge { min: number; mean: number; max: number }
export interface Latency { n: number; p50: number | null; p95: number | null; p99: number | null }
export interface OpsHour {
  hour: string; seconds: number; starts: number
  counters: Record<string, number>; gauges: Record<string, Gauge>; latency_ms: Record<string, Latency>
}
export type ExactEnergyDay = { date: string; reports: number } & Record<typeof energyFields[number], number>
export interface OpsFeed { schema: 'ftw.cloud-ops/1'; meaning: string; shard: string; observed_at: string; hours: OpsHour[]; fleet_days: FleetDay[]; energy_days: ExactEnergyDay[] }

function record(v: unknown, what: string): Record<string, unknown> {
  if (!v || typeof v !== 'object' || Array.isArray(v)) throw new Error('invalid ops ' + what)
  return v as Record<string, unknown>
}
function exact(v: Record<string, unknown>, keys: readonly string[], what: string) {
  if (Object.keys(v).sort().join() !== [...keys].sort().join()) throw new Error('unexpected ops fields in ' + what)
}
const int = (n: unknown, lo: number, hi: number) => typeof n === 'number' && Number.isSafeInteger(n) && n >= lo && n <= hi
const name = (k: string) => /^[a-z0-9_]{1,80}$/.test(k)
function series<T>(v: unknown, what: string, each: (x: unknown) => T): Record<string, T> {
  const m = record(v, what)
  if (Object.keys(m).length > 256) throw new Error('too many ops series')
  for (const [k, x] of Object.entries(m)) { if (!name(k)) throw new Error('invalid ops series name'); each(x) }
  return m as Record<string, T>
}
function quantile(v: unknown) {
  if (v !== null && (typeof v !== 'number' || !Number.isFinite(v) || v < 0 || v > 10_000)) throw new Error('invalid ops quantile')
  return v as number | null
}

export function parseOps(value: unknown, nowMs: number): OpsFeed {
  const v = record(value, 'feed')
  exact(v, ['schema', 'meaning', 'shard', 'observed_at', 'hours', 'fleet_days', 'energy_days'], 'feed')
  const observed = typeof v['observed_at'] === 'string' ? Date.parse(v['observed_at']) : NaN
  if (v['schema'] !== 'ftw.cloud-ops/1' || v['meaning'] !== MEANING || typeof v['shard'] !== 'string' || !/^[a-z0-9-]{1,16}$/.test(v['shard'])) throw new Error('invalid ops feed')
  if (!Number.isFinite(observed) || observed > nowMs + 60_000 || nowMs - observed > 2 * HOUR_MS) throw new Error('invalid ops time')
  if (!Array.isArray(v['hours']) || v['hours'].length > MAX_HOURS || !Array.isArray(v['fleet_days']) || v['fleet_days'].length > 90 ||
    !Array.isArray(v['energy_days']) || v['energy_days'].length > 31) throw new Error('invalid ops window')
  let last = -Infinity
  for (const item of v['hours']) {
    const h = record(item, 'hour')
    exact(h, ['hour', 'seconds', 'starts', 'counters', 'gauges', 'latency_ms'], 'hour')
    const at = typeof h['hour'] === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:00:00Z$/.test(h['hour']) ? Date.parse(h['hour']) : NaN
    if (!Number.isFinite(at) || at <= last || at + HOUR_MS > observed || at < nowMs - (OPS_KEPT_DAYS + 1) * DAY_MS) throw new Error('invalid ops hour')
    last = at
    if (!int(h['seconds'], 0, 7200) || !int(h['starts'], 0, 1000)) throw new Error('invalid ops coverage')
    series(h['counters'], 'counters', (n) => { if (!int(n, 0, 1e15)) throw new Error('invalid ops counter') })
    series(h['gauges'], 'gauges', (x) => {
      const g = record(x, 'gauge')
      exact(g, ['min', 'mean', 'max'], 'gauge')
      const mean = g['mean'] as number
      if (!int(g['min'], -1e15, 1e15) || !int(g['max'], -1e15, 1e15) || typeof mean !== 'number' || !Number.isFinite(mean) ||
        (g['min'] as number) > (g['max'] as number) || mean < (g['min'] as number) - 1e-6 || mean > (g['max'] as number) + 1e-6) throw new Error('invalid ops gauge')
    })
    series(h['latency_ms'], 'latency', (x) => {
      const l = record(x, 'latency')
      exact(l, ['n', 'p50', 'p95', 'p99'], 'latency')
      if (!int(l['n'], 0, 1e15)) throw new Error('invalid ops latency count')
      const q = [quantile(l['p50']), quantile(l['p95']), quantile(l['p99'])]
      if (l['n'] === 0 && q.some(p => p !== null)) throw new Error('quantiles without a count')
      const known = q.filter((p): p is number => p !== null)
      if (q.indexOf(null) !== -1 && q.slice(q.indexOf(null)).some(p => p !== null) || known.some((p, i) => i > 0 && p < known[i - 1]!)) throw new Error('quantiles out of order')
    })
  }
  // A day shows only once closed, so two pulls never differ by one report.
  const today = new Date(observed).toISOString().slice(0, 10)
  const day = (date: string, newest: string, seen: Set<string>) => {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !Number.isFinite(Date.parse(date)) || new Date(date).toISOString().slice(0, 10) !== date ||
      date >= newest || Date.parse(date) < nowMs - 91 * DAY_MS || seen.has(date)) throw new Error('invalid ops day')
    seen.add(date)
  }
  const seen = new Set<string>()
  for (const item of v['fleet_days']) {
    const d = record(item, 'day'), date = String(d['date'])
    const withHealth = 'plan_solve' in d
    exact(d, ['date', 'reports', ...dimensions, ...(withHealth ? health : [])], 'day')
    day(date, today, seen)
    const reports = d['reports']
    if (!int(reports, 0, 100_000)) throw new Error('invalid ops fleet count')
    for (const key of dimensions) {
      const labels = record(d[key], 'fleet labels')
      if (Object.keys(labels).length > 128) throw new Error('too many ops fleet labels')
      for (const [label, n] of Object.entries(labels)) {
        if (!label || label.length > 128 || /[\x00-\x1f\x7f]/.test(label) || !int(n, 1, reports as number)) throw new Error('invalid ops fleet label')
      }
    }
    if (withHealth) for (const key of health) {
      const labels = record(d[key], 'fleet health')
      let total = 0
      for (const [label, n] of Object.entries(labels)) {
        if (!(healthBuckets[key] as readonly string[]).includes(label) || !int(n, 1, reports as number)) throw new Error('invalid ops fleet health')
        total += n as number
      }
      if (total < 1 || total > (reports as number)) throw new Error('invalid ops fleet health total')
    }
  }
  const closed = new Date(Date.parse(today) - (ENERGY_OPEN_DAYS - 1) * DAY_MS).toISOString().slice(0, 10)
  const energySeen = new Set<string>()
  for (const item of v['energy_days']) {
    const d = record(item, 'energy day')
    exact(d, ['date', 'reports', ...energyFields], 'energy day')
    day(String(d['date']), closed, energySeen)
    if (!int(d['reports'], 1, 100_000) || energyFields.some(k => !int(d[k], 0, (d['reports'] as number) * 1000))) throw new Error('invalid ops energy day')
  }
  return v as unknown as OpsFeed
}

async function readCapped(r: Response, cap: number): Promise<unknown> {
  const reader = r.body?.getReader()
  if (!reader) throw new Error('empty ops body')
  const parts: Uint8Array[] = []
  let size = 0
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      size += value.length
      if (size > cap) throw new Error('large ops body')
      parts.push(value)
    }
  } finally { await reader.cancel() }
  const bytes = new Uint8Array(size)
  let offset = 0
  for (const p of parts) { bytes.set(p, offset); offset += p.length }
  return JSON.parse(new TextDecoder().decode(bytes))
}

// collectOps pulls the hours after the newest one kept, the last again in
// case a restart added to it, and the exact day totals. Without a key it
// waits; so does a Cloud that has none set (404).
export async function collectOps(env: AppEnv, nowMs = Date.now()): Promise<void> {
  const started = new Date(nowMs).toISOString()
  if (!env.CLOUD_OPS_KEY) { await saveCollectorRun(env.DB, 'cloud:ops', started, true, 'awaiting key'); return }
  try {
    const newest = await env.DB.prepare('SELECT MAX(hour) AS hour FROM cloud_ops_hours').first<{ hour: string | null }>()
    const floor = Math.floor((nowMs - OPS_KEPT_DAYS * DAY_MS) / HOUR_MS) * HOUR_MS
    const since = Math.max(floor, newest?.hour ? Date.parse(newest.hour) - HOUR_MS : floor)
    const url = OPS_URL + '?since=' + encodeURIComponent(new Date(since).toISOString().replace('.000Z', 'Z'))
    const r = await fetch(url, { redirect: 'manual', headers: { accept: 'application/json', authorization: 'Bearer ' + env.CLOUD_OPS_KEY }, signal: AbortSignal.timeout(15_000) })
    if (r.status === 404) { await r.body?.cancel(); await saveCollectorRun(env.DB, 'cloud:ops', started, true, 'awaiting key on Cloud'); return }
    if (!r.ok) { await r.body?.cancel(); throw new Error('ops source unavailable') }
    const feed = parseOps(await readCapped(r, MAX_BYTES), nowMs)
    const statements = feed.hours.map(h => env.DB.prepare(
      `INSERT INTO cloud_ops_hours(shard,hour,seconds,starts,counters_json,gauges_json,latency_json,observed_at) VALUES(?,?,?,?,?,?,?,?)
       ON CONFLICT(shard,hour) DO UPDATE SET seconds=excluded.seconds,starts=excluded.starts,counters_json=excluded.counters_json,
       gauges_json=excluded.gauges_json,latency_json=excluded.latency_json,observed_at=excluded.observed_at`
    ).bind(feed.shard, new Date(h.hour).toISOString(), h.seconds, h.starts, JSON.stringify(h.counters), JSON.stringify(h.gauges), JSON.stringify(h.latency_ms), feed.observed_at))
    statements.push(env.DB.prepare(
      'INSERT INTO cloud_ops_days(id,observed_at,fleet_json,energy_json) VALUES(1,?,?,?) ON CONFLICT(id) DO UPDATE SET observed_at=excluded.observed_at,fleet_json=excluded.fleet_json,energy_json=excluded.energy_json'
    ).bind(feed.observed_at, JSON.stringify(feed.fleet_days), JSON.stringify(feed.energy_days)))
    await env.DB.batch(statements)
    await saveCollectorRun(env.DB, 'cloud:ops', started, true, feed.hours.length + ' service hours')
  } catch (e) { await saveCollectorRun(env.DB, 'cloud:ops', started, false, 'ops source unavailable or invalid'); throw e }
}

interface HourRow { shard: string; hour: string; seconds: number; starts: number; counters_json: string; gauges_json: string; latency_json: string }
interface Hour { hour: string; seconds: number; starts: number; counters: Record<string, number>; gauges: Record<string, Gauge>; latency: Record<string, Latency> }

// A quantile past ftwcloudd's last bucket (10 s) comes as null beside a
// count. It is the slowest case there is, never a missing one.
export const OVER_LAST_BUCKET = 'over_10s' as const
type Slowest = number | typeof OVER_LAST_BUCKET | null
function quantileOf(l: Latency | undefined, q: 'p50' | 'p95' | 'p99'): Slowest {
  if (!l || l.n === 0) return null
  return l[q] ?? OVER_LAST_BUCKET
}
function slowest(values: Slowest[]): Slowest {
  if (values.includes(OVER_LAST_BUCKET)) return OVER_LAST_BUCKET
  const v = values.filter((x): x is number => typeof x === 'number')
  return v.length ? Math.max(...v) : null
}
const slowestOf = (rows: Hour[], key: string, q: 'p50' | 'p99' = 'p99') => slowest(rows.map(r => quantileOf(r.latency[key], q)))

// byHour adds the shards of each hour together: each holds its own homes, so
// counts and gauges sum, and a latency keeps the slowest shard's quantile.
function byHour(rows: HourRow[]): Hour[] {
  const hours = new Map<string, Hour>()
  for (const r of rows) {
    const counters = JSON.parse(r.counters_json) as Record<string, number>
    const gauges = JSON.parse(r.gauges_json) as Record<string, Gauge>
    const latency = JSON.parse(r.latency_json) as Record<string, Latency>
    const h = hours.get(r.hour)
    if (!h) { hours.set(r.hour, { hour: r.hour, seconds: r.seconds, starts: r.starts, counters, gauges, latency }); continue }
    h.seconds = Math.min(h.seconds, r.seconds)
    h.starts += r.starts
    for (const [k, n] of Object.entries(counters)) h.counters[k] = (h.counters[k] ?? 0) + n
    for (const [k, g] of Object.entries(gauges)) {
      const o = h.gauges[k]
      h.gauges[k] = o ? { min: o.min + g.min, mean: o.mean + g.mean, max: o.max + g.max } : g
    }
    for (const [k, l] of Object.entries(latency)) {
      const o = h.latency[k]
      if (!o) { h.latency[k] = l; continue }
      // A quantile of both is no slower than the slower shard's.
      const merged = (q: 'p50' | 'p95' | 'p99') => { const w = slowest([quantileOf(o, q), quantileOf(l, q)]); return w === OVER_LAST_BUCKET ? null : w }
      h.latency[k] = { n: o.n + l.n, p50: merged('p50'), p95: merged('p95'), p99: merged('p99') }
    }
  }
  return [...hours.values()].sort((a, b) => a.hour.localeCompare(b.hour))
}

const sumOf = (rows: Record<string, number>[], key: string) => rows.reduce((n, c) => n + (c[key] ?? 0), 0)
function prefixed(totals: Record<string, number>, prefix: string): { name: string; count: number }[] {
  return Object.entries(totals).filter(([k, n]) => k.startsWith(prefix) && n > 0).map(([k, n]) => ({ name: k.slice(prefix.length), count: n })).sort((a, b) => b.count - a.count)
}
function share(a: number | undefined, b: number | undefined): number | null {
  const total = (a ?? 0) + (b ?? 0)
  return total > 0 ? Math.round((a ?? 0) / total * 1000) / 10 : null
}

// opsSummary is what the private view shows: the service now, the last two
// days hour by hour with missing hours as gaps, a week of drops, pushes and
// assistant calls, deploys over 30 days, data out this month against the
// free allowance, and the fleet's exact days. Old data reads as stale, never
// as nothing happening.
export async function opsSummary(db: D1Database, nowMs: number): Promise<Record<string, unknown>> {
  const monthStartMs = Date.UTC(new Date(nowMs).getUTCFullYear(), new Date(nowMs).getUTCMonth(), 1)
  const monthStart = new Date(monthStartMs).toISOString()
  const since = new Date(Math.min(nowMs - 30 * DAY_MS, monthStartMs)).toISOString()
  const [stored, days] = await Promise.all([
    db.prepare('SELECT shard,hour,seconds,starts,counters_json,gauges_json,latency_json FROM cloud_ops_hours WHERE hour >= ? ORDER BY hour ASC').bind(since).all<HourRow>(),
    db.prepare('SELECT observed_at, fleet_json, energy_json FROM cloud_ops_days WHERE id=1').first<{ observed_at: string; fleet_json: string; energy_json: string }>(),
  ])
  const rows = byHour(stored.results)
  const daysState = !days ? 'empty' : nowMs - Date.parse(days.observed_at) > 2 * DAY_MS ? 'stale' : 'visible'
  const fleet = { state: daysState, observed_at: days?.observed_at ?? null, meaning: 'exact daily reports for closed UTC days, not users or unique boxes; private view only',
    days: days ? (JSON.parse(days.fleet_json) as FleetDay[]).sort((a, b) => a.date.localeCompare(b.date)) : [] }
  const energy = { state: daysState, observed_at: days?.observed_at ?? null, meaning: 'exact daily energy reports for closed dates, not homes; private view only',
    days: days ? (JSON.parse(days.energy_json) as ExactEnergyDay[]).sort((a, b) => a.date.localeCompare(b.date)) : [] }
  if (!rows.length) return { state: 'empty', hours: [], fleet, energy }
  const weekRows = rows.filter(r => Date.parse(r.hour) >= nowMs - 7 * DAY_MS)
  const monthRows = rows.filter(r => r.hour >= monthStart)
  const totals: Record<string, number> = {}
  for (const r of weekRows) for (const [k, n] of Object.entries(r.counters)) totals[k] = (totals[k] ?? 0) + n
  const latest = rows.at(-1)!
  const g = (key: string) => latest.gauges[key]
  const month = monthRows.map(r => r.counters)
  const bytesOut = sumOf(month, 'bytes_out_box') + sumOf(month, 'bytes_out_app')
  const byStart = new Map(rows.map(r => [Date.parse(r.hour), r]))
  const lastHour = Math.floor(nowMs / HOUR_MS) * HOUR_MS - HOUR_MS
  return {
    state: nowMs - Date.parse(latest.hour) <= 3 * HOUR_MS ? 'visible' : 'stale',
    meaning: 'sums over the whole service each hour; no home, device or address',
    latest_hour: latest.hour,
    now: {
      boxes: g('homes_connected') ?? g('sockets_box') ?? null, phones: g('sockets_app') ?? null, homes: g('homes') ?? null,
      box_quic_percent: share(g('transport_sockets_box_quic')?.mean, g('transport_sockets_box_websocket')?.mean),
      app_quic_percent: share(g('transport_sockets_app_quic')?.mean, g('transport_sockets_app_websocket')?.mean),
    },
    month: { start: monthStart, bytes_out: bytesOut, tun_bytes: sumOf(month, 'tun_bytes_up') + sumOf(month, 'tun_bytes_down'),
      budget_bytes: EGRESS_BUDGET_BYTES, budget_percent: Math.round(bytesOut / EGRESS_BUDGET_BYTES * 1000) / 10,
      hours_recorded: monthRows.length, hours_so_far: Math.max(0, Math.floor((nowMs - monthStartMs) / HOUR_MS)),
      note: 'Message bytes the service wrote to boxes and phones in the hours recorded; TLS and framing come on top. The allowance is AWS\'s free data out across the account.' },
    // The last 48 hours, one slot each; an hour Cloud did not report is a gap.
    hours: Array.from({ length: 48 }, (_, i) => lastHour - (47 - i) * HOUR_MS).map(start => {
      const r = byStart.get(start)
      if (!r) return { hour: new Date(start).toISOString(), missing: true }
      return {
        hour: r.hour, seconds: r.seconds, starts: r.starts,
        boxes_max: r.gauges['sockets_box']?.max ?? null, phones_max: r.gauges['sockets_app']?.max ?? null,
        bytes_out: (r.counters['bytes_out_box'] ?? 0) + (r.counters['bytes_out_app'] ?? 0),
        drops: Object.entries(r.counters).filter(([k]) => k.startsWith('drops_')).reduce((n, [, v]) => n + v, 0),
        forward_p99_ms: slowest(['forward_seconds_envelope', 'forward_seconds_tun_up', 'forward_seconds_tun_down'].map(k => quantileOf(r.latency[k], 'p99'))),
      }
    }),
    week: {
      hours_recorded: weekRows.length,
      drops: prefixed(totals, 'drops_'),
      push: {
        alert: pushResults(totals, 'apns_alert_'), widgets: pushResults(totals, 'apns_widgets_'), browser: pushResults(totals, 'webpush_'),
        breaker_opened: totals['apns_breaker_open'] ?? 0, coalesced: totals['push_coalesced'] ?? 0,
      },
      mcp: { outcomes: prefixed(totals, 'mcp_'), p99_ms_max: slowestOf(weekRows, 'mcp_call_seconds') },
      wrong_shard: prefixed(totals, 'wrong_shard_'),
    },
    latency_24h: ['forward_seconds_envelope', 'forward_seconds_tun_up', 'forward_seconds_tun_down', 'handshake_seconds_box', 'handshake_seconds_app', 'handshake_seconds_once', 'mcp_call_seconds']
      .map(key => {
        const day = rows.filter(r => Date.parse(r.hour) >= nowMs - DAY_MS)
        return { name: key, n: day.reduce((t, r) => t + (r.latency[key]?.n ?? 0), 0), p99_ms_max: slowestOf(day, key), p50_ms_max: slowestOf(day, key, 'p50') }
      }),
    deploys: rows.filter(r => r.starts > 0 || (r.counters['drains'] ?? 0) > 0).map(r => ({
      hour: r.hour, starts: r.starts, seconds: r.seconds, drains: r.counters['drains'] ?? 0, drained_sockets: r.counters['drained_sockets'] ?? 0,
      left_open: r.counters['drain_left_open'] ?? 0, box_handshakes: r.latency['handshake_seconds_box']?.n ?? 0, box_handshake_p99_ms: quantileOf(r.latency['handshake_seconds_box'], 'p99'),
    })).reverse(),
    fleet,
    energy,
  }
}

function pushResults(totals: Record<string, number>, prefix: string) {
  const r = Object.fromEntries(prefixed(totals, prefix).map(x => [x.name, x.count]))
  const sent = Object.values(r).reduce((n, c) => n + c, 0)
  return { results: r, sent, ok_percent: sent > 0 ? Math.round((r['ok'] ?? 0) / sent * 1000) / 10 : null }
}
