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
    exact(d, ['date', 'reports', ...dimensions], 'day')
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

const sumOf = (rows: Record<string, number>[], key: string) => rows.reduce((n, c) => n + (c[key] ?? 0), 0)
function prefixed(totals: Record<string, number>, prefix: string): { name: string; count: number }[] {
  return Object.entries(totals).filter(([k, n]) => k.startsWith(prefix) && n > 0).map(([k, n]) => ({ name: k.slice(prefix.length), count: n })).sort((a, b) => b.count - a.count)
}
function share(a: number | undefined, b: number | undefined): number | null {
  const total = (a ?? 0) + (b ?? 0)
  return total > 0 ? Math.round((a ?? 0) / total * 1000) / 10 : null
}

// opsSummary is what the private view shows: the service now, the last two
// days hour by hour, a week of drops, pushes and assistant calls, deploys over
// 30 days, data out this month against the free allowance, and the fleet's
// exact days.
export async function opsSummary(db: D1Database, nowMs: number): Promise<Record<string, unknown>> {
  const monthStart = new Date(Date.UTC(new Date(nowMs).getUTCFullYear(), new Date(nowMs).getUTCMonth(), 1)).toISOString()
  const since = new Date(Math.min(nowMs - 30 * DAY_MS, Date.parse(monthStart))).toISOString()
  const [hours, days] = await Promise.all([
    db.prepare('SELECT shard,hour,seconds,starts,counters_json,gauges_json,latency_json FROM cloud_ops_hours WHERE hour >= ? ORDER BY hour ASC').bind(since).all<HourRow>(),
    db.prepare('SELECT observed_at, fleet_json, energy_json FROM cloud_ops_days WHERE id=1').first<{ observed_at: string; fleet_json: string; energy_json: string }>(),
  ])
  const rows = hours.results.map(r => ({ hour: r.hour, seconds: r.seconds, starts: r.starts,
    counters: JSON.parse(r.counters_json) as Record<string, number>, gauges: JSON.parse(r.gauges_json) as Record<string, Gauge>, latency: JSON.parse(r.latency_json) as Record<string, Latency> }))
  const fleetDays = days ? (JSON.parse(days.fleet_json) as FleetDay[]).sort((a, b) => a.date.localeCompare(b.date)) : []
  const fleet = { state: days ? 'visible' : 'empty', observed_at: days?.observed_at ?? null, meaning: 'exact daily reports for closed UTC days, not users or unique boxes; private view only', days: fleetDays }
  const energy = { state: days ? 'visible' : 'empty', observed_at: days?.observed_at ?? null, meaning: 'exact daily energy reports for closed dates, not homes; private view only',
    days: days ? (JSON.parse(days.energy_json) as ExactEnergyDay[]).sort((a, b) => a.date.localeCompare(b.date)) : [] }
  if (!rows.length) return { state: 'empty', hours: [], fleet, energy }
  const week = rows.filter(r => Date.parse(r.hour) >= nowMs - 7 * DAY_MS).map(r => r.counters)
  const month = rows.filter(r => r.hour >= monthStart).map(r => r.counters)
  const totals: Record<string, number> = {}
  for (const c of week) for (const [k, n] of Object.entries(c)) totals[k] = (totals[k] ?? 0) + n
  const latest = rows.at(-1)!
  const g = (key: string) => latest.gauges[key]
  const p99 = (r: typeof latest, key: string) => r.latency[key]?.p99 ?? null
  const bytesOut = sumOf(month, 'bytes_out_box') + sumOf(month, 'bytes_out_app')
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
      note: 'Message bytes the service wrote to boxes and phones; TLS and framing come on top. The allowance is AWS\'s free data out across the account.' },
    hours: rows.filter(r => Date.parse(r.hour) >= nowMs - 2 * DAY_MS).map(r => ({
      hour: r.hour, seconds: r.seconds, starts: r.starts,
      boxes_max: r.gauges['sockets_box']?.max ?? null, phones_max: r.gauges['sockets_app']?.max ?? null,
      bytes_out: (r.counters['bytes_out_box'] ?? 0) + (r.counters['bytes_out_app'] ?? 0),
      drops: Object.entries(r.counters).filter(([k]) => k.startsWith('drops_')).reduce((n, [, v]) => n + v, 0),
      forward_p99_ms: Math.max(...['forward_seconds_envelope', 'forward_seconds_tun_up', 'forward_seconds_tun_down'].map(k => p99(r, k) ?? 0)),
    })),
    week: {
      drops: prefixed(totals, 'drops_'),
      push: {
        alert: pushResults(totals, 'apns_alert_'), widgets: pushResults(totals, 'apns_widgets_'), browser: pushResults(totals, 'webpush_'),
        breaker_opened: totals['apns_breaker_open'] ?? 0, coalesced: totals['push_coalesced'] ?? 0,
      },
      mcp: { outcomes: prefixed(totals, 'mcp_'), p99_ms_max: maxOf(rows, 'mcp_call_seconds') },
      wrong_shard: prefixed(totals, 'wrong_shard_'),
    },
    latency_24h: ['forward_seconds_envelope', 'forward_seconds_tun_up', 'forward_seconds_tun_down', 'handshake_seconds_box', 'handshake_seconds_app', 'handshake_seconds_once', 'mcp_call_seconds']
      .map(key => ({ name: key, ...latencyOver(rows.filter(r => Date.parse(r.hour) >= nowMs - DAY_MS), key) })),
    deploys: rows.filter(r => r.starts > 0 || (r.counters['drains'] ?? 0) > 0).map(r => ({
      hour: r.hour, starts: r.starts, seconds: r.seconds, drains: r.counters['drains'] ?? 0, drained_sockets: r.counters['drained_sockets'] ?? 0,
      left_open: r.counters['drain_left_open'] ?? 0, box_handshakes: r.latency['handshake_seconds_box']?.n ?? 0, box_handshake_p99_ms: p99(r, 'handshake_seconds_box'),
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
function maxOf(rows: { latency: Record<string, Latency> }[], key: string): number | null {
  const v = rows.map(r => r.latency[key]?.p99).filter((p): p is number => typeof p === 'number')
  return v.length ? Math.max(...v) : null
}
function latencyOver(rows: { latency: Record<string, Latency> }[], key: string) {
  const n = rows.reduce((t, r) => t + (r.latency[key]?.n ?? 0), 0)
  return { n, p99_ms_max: maxOf(rows, key), p50_ms_max: (() => { const v = rows.map(r => r.latency[key]?.p50).filter((p): p is number => typeof p === 'number'); return v.length ? Math.max(...v) : null })() }
}
