import { saveCollectorRun } from './collector.ts'
import type { AppEnv } from './types.ts'

// FTW Cloud's anonymous daily energy reports: one report per box and closed
// UTC day, sent through an independent relay, so Cloud never learns which
// box sent it. Cloud lists a date only once no report may still name it, and
// a date with fewer than five reports shows null. These are reports, not homes.
export const energyFields = ['pv_generation_kwh', 'grid_import_kwh', 'grid_export_kwh', 'battery_charge_kwh', 'battery_discharge_kwh', 'vehicle_charge_kwh'] as const
const PUBLIC_ENERGY_MINIMUM = 5
// A box names one of the last three closed days, so the newest public date is
// four days back.
const OPEN_DAYS = 4
const MAX_REPORTS = 100_000
const MAX_KWH = 1000
export type EnergyDay = { date: string; reports: number | null } & Record<typeof energyFields[number], number | null>
export interface PublicEnergyFeed { schema: 'ftw.energy-public/1'; minimum: number; meaning: string; observed_at: string; days: EnergyDay[] }

export function parseEnergy(value: unknown, nowMs: number): PublicEnergyFeed {
  const v = value as Record<string, unknown>
  if (!v || typeof v !== 'object' || Array.isArray(v) || Object.keys(v).sort().join() !== ['days','meaning','minimum','observed_at','schema'].join() || v['schema'] !== 'ftw.energy-public/1' || v['minimum'] !== PUBLIC_ENERGY_MINIMUM || v['meaning'] !== 'daily reports, not homes') throw new Error('invalid public energy')
  const observed = Date.parse(String(v['observed_at']))
  if (!Number.isFinite(observed) || Math.abs(nowMs-observed)>2*3600_000 || !Array.isArray(v['days']) || v['days'].length>31) throw new Error('invalid energy window')
  const today = Math.floor(observed/86400_000)*86400_000
  const newest = new Date(today-OPEN_DAYS*86400_000).toISOString().slice(0,10), oldest = new Date(today-30*86400_000).toISOString().slice(0,10)
  const seen = new Set()
  for (const item of v['days']) {
    const d = item as Record<string, unknown>, date = String(d?.['date'])
    if (!d || typeof d !== 'object' || Array.isArray(d) || Object.keys(d).sort().join() !== ['date','reports',...energyFields].sort().join() || !/^\d{4}-\d{2}-\d{2}$/.test(date) || !Number.isFinite(Date.parse(date)) || new Date(date).toISOString().slice(0,10)!==date || date>newest || date<oldest || seen.has(date)) throw new Error('invalid energy day')
    seen.add(date)
    const reports = d['reports']
    if (reports === null) {
      if (energyFields.some(k => d[k] !== null)) throw new Error('small energy count')
      continue
    }
    if (!Number.isSafeInteger(reports) || (reports as number)<PUBLIC_ENERGY_MINIMUM || (reports as number)>MAX_REPORTS) throw new Error('small energy count')
    for (const k of energyFields) if (!Number.isSafeInteger(d[k]) || (d[k] as number)<0 || (d[k] as number)>(reports as number)*MAX_KWH) throw new Error('invalid energy sum')
  }
  return v as unknown as PublicEnergyFeed
}

export async function collectEnergy(env: AppEnv, nowMs = Date.now()) {
  const started = new Date(nowMs).toISOString()
  try {
    const r=await fetch('https://cloud.ftw.energy/v1/energy/public',{redirect:'manual',headers:{accept:'application/json'},signal:AbortSignal.timeout(15000)})
    // A Cloud that does not serve the route yet is a source still to come,
    // not a failed collection.
    if (r.status===404) {await r.body?.cancel();await saveCollectorRun(env.DB,'cloud:energy',started,true,'awaiting source');return}
    if (!r.ok) {await r.body?.cancel();throw new Error('energy unavailable')}
    const reader=r.body?.getReader(); if (!reader) throw new Error('empty energy')
    const parts:Uint8Array[]=[];let size=0
    try {while(true){const {done,value}=await reader.read();if(done)break;size+=value.length;if(size>64*1024)throw new Error('large energy');parts.push(value)}}finally{await reader.cancel()}
    const bytes=new Uint8Array(size);let offset=0;for(const p of parts){bytes.set(p,offset);offset+=p.length}
    const feed=parseEnergy(JSON.parse(new TextDecoder().decode(bytes)),nowMs)
    await env.DB.prepare('INSERT INTO cloud_energy_view(id,observed_at,view_json) VALUES(1,?,?) ON CONFLICT(id) DO UPDATE SET observed_at=excluded.observed_at,view_json=excluded.view_json').bind(feed.observed_at,JSON.stringify(feed)).run()
    await saveCollectorRun(env.DB,'cloud:energy',started,true,'public daily report totals')
  } catch(e){await saveCollectorRun(env.DB,'cloud:energy',started,false,'energy source unavailable or invalid');throw e}
}

// The newest public date with a count, and the sum over the public dates
// that have one. Never a value Cloud did not publish.
export function energySummary(feed: PublicEnergyFeed | null, nowMs: number) {
  const meaning = 'daily reports, not homes'
  if (!feed) return { state: 'pending', meaning, latest: null, window: null }
  const counted = feed.days.filter(d => d.reports !== null).sort((a,b)=>a.date<b.date?1:-1)
  const total = Object.fromEntries(energyFields.map(k => [k, counted.reduce((n,d)=>n+(d[k] as number),0)]))
  return {
    state: nowMs-Date.parse(feed.observed_at) > 48*3600_000 ? 'stale' : counted.length ? 'connected' : 'withheld',
    meaning, minimum: feed.minimum, observed_at: feed.observed_at,
    latest: counted[0] ?? null,
    window: counted.length ? { days: counted.length, first: counted.at(-1)!.date, last: counted[0]!.date, reports: counted.reduce((n,d)=>n+(d.reports as number),0), ...total } : null,
  }
}
