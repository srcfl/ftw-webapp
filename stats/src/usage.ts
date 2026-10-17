import { saveCollectorRun } from './collector.ts'
import type { AppEnv } from './types.ts'

export const usageKeys = ['battery_capacity_wh', 'flexible_power_w', 'pv_rated_w', 'grid_import_wh', 'grid_export_wh', 'pv_generation_wh', 'battery_charge_wh', 'battery_discharge_wh', 'vehicle_charge_wh', 'vehicle_discharge_wh'] as const
interface Cell { state: 'visible' | 'withheld' | 'dominated' | 'empty'; value: number | null; homes: number | null }
export interface UsageView {
  schema: 'ftw.project-usage/1'; observed_at: string; window_start: string; window_end: string; minimum: number
  installations: Cell; metrics: Record<string, Cell>
}
function record(v: unknown): Record<string, unknown> {
  if (!v || typeof v !== 'object' || Array.isArray(v)) throw new Error('invalid usage object')
  return v as Record<string, unknown>
}
function exact(v: Record<string, unknown>, keys: readonly string[]) {
  if (Object.keys(v).length !== keys.length || Object.keys(v).some(k => !keys.includes(k))) throw new Error('unexpected usage fields')
}
function cell(v: unknown, installation = false): Cell {
  const c = record(v)
  exact(c, ['state', 'value', 'homes'])
  const integer = (n: unknown) => typeof n === 'number' && Number.isSafeInteger(n) && n >= 0
  if (c['state'] === 'empty' && installation && c['value'] === 0 && c['homes'] === null) return c as unknown as Cell
  if (c['state'] === 'withheld' && c['value'] === null && c['homes'] === null) return c as unknown as Cell
  if (!integer(c['homes']) || (c['homes'] as number) < 20) throw new Error('small usage cell')
  if (c['state'] === 'dominated' && !installation && c['value'] === null) return c as unknown as Cell
  if (c['state'] !== 'visible' || !integer(c['value']) || (installation && c['value'] !== c['homes'])) throw new Error('invalid usage cell')
  return c as unknown as Cell
}
export function parseUsage(value: unknown, nowMs: number): UsageView {
  const v = record(value)
  exact(v, ['schema', 'observed_at', 'window_start', 'window_end', 'minimum', 'installations', 'metrics'])
  const time = (k: string) => typeof v[k] === 'string' ? Date.parse(v[k] as string) : NaN
  const observed = time('observed_at'), start = time('window_start'), end = time('window_end')
  if (v['schema'] !== 'ftw.project-usage/1' || v['minimum'] !== 20 || !Number.isFinite(observed) || observed > nowMs + 60_000 || nowMs - observed > 2 * 3600_000 || end % 3600_000 !== 0 || end - start !== 24 * 3600_000 || end > observed || observed - end >= 3600_000) throw new Error('invalid usage window')
  cell(v['installations'], true)
  const metrics = record(v['metrics'])
  exact(metrics, usageKeys)
  for (const c of Object.values(metrics)) cell(c)
  return v as unknown as UsageView
}
export async function collectUsage(env: AppEnv, nowMs = Date.now()): Promise<void> {
  const started = new Date(nowMs).toISOString()
  try {
    const response = await fetch('https://cloud.ftw.energy/v1/stats', { headers: { accept: 'application/json' }, redirect: 'error', signal: AbortSignal.timeout(15_000) })
    if (response.status === 503 && response.headers.get('FTW-Statistics-State') === 'disabled') {await response.body?.cancel(); await saveCollectorRun(env.DB,'cloud:usage',started,true,'awaiting policy approval');return}
    if (!response.ok) { await response.body?.cancel(); throw new Error('usage source unavailable') }
    const reader = response.body?.getReader()
    if (!reader) throw new Error('empty usage body')
    const chunks: Uint8Array[] = []; let size = 0
    try { while (true) { const { done, value } = await reader.read(); if (done) break; size += value.length; if (size > 32 * 1024) throw new Error('large usage body'); chunks.push(value) } }
    finally { await reader.cancel() }
    const bytes = new Uint8Array(size); let offset = 0
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length }
    const view = parseUsage(JSON.parse(new TextDecoder().decode(bytes)), nowMs)
    await env.DB.prepare('INSERT INTO usage_snapshots(captured_hour,observed_at,view_json) VALUES(?,?,?) ON CONFLICT(captured_hour) DO UPDATE SET observed_at=excluded.observed_at,view_json=excluded.view_json').bind(started.slice(0, 13) + ':00:00.000Z', view.observed_at, JSON.stringify(view)).run()
    await saveCollectorRun(env.DB, 'cloud:usage', started, true, 'public group cells')
  } catch (error) { await saveCollectorRun(env.DB, 'cloud:usage', started, false, 'usage source unavailable or invalid'); throw error }
}
