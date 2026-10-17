import { saveCollectorRun } from './collector.ts'
import type { AppEnv } from './types.ts'

const dimensions = ['ftw_versions', 'channels', 'drivers', 'battery_kwh', 'price_zones', 'install_age'] as const
export interface PublicFleetDay { date: string; reports: number | null }
export interface PublicFleetFeed { schema: 'ftw.fleet-public/1'; minimum: number; meaning: string; observed_at: string; days: PublicFleetDay[] }
export function parseFleet(value: unknown, nowMs: number): PublicFleetFeed {
  const v = value as Record<string, unknown>
  if (!v || typeof v !== 'object' || Array.isArray(v) || Object.keys(v).sort().join() !== ['days','meaning','minimum','observed_at','schema'].join() || v['schema'] !== 'ftw.fleet-public/1' || v['minimum'] !== 10 || v['meaning'] !== 'reports, not unique boxes') throw new Error('invalid public fleet')
  const observed = Date.parse(String(v['observed_at']))
  if (!Number.isFinite(observed) || Math.abs(nowMs-observed)>2*3600_000 || !Array.isArray(v['days']) || v['days'].length>90) throw new Error('invalid fleet window')
  const seen = new Set()
  for (const item of v['days']) {
    const d = item as Record<string, unknown>, date = String(d['date'])
    if (!d || Object.keys(d).sort().join() !== ['date','reports',...dimensions].sort().join() || !/^\d{4}-\d{2}-\d{2}$/.test(date) || !Number.isFinite(Date.parse(date)) || new Date(date).toISOString().slice(0,10)!==date || date>new Date(nowMs).toISOString().slice(0,10) || Date.parse(date)<nowMs-91*86400_000 || seen.has(date)) throw new Error('invalid fleet day')
    seen.add(date)
    const reports = d['reports']
    if (reports !== null && (!Number.isSafeInteger(reports) || (reports as number)<10 || (reports as number)>100000)) throw new Error('small fleet count')
    for (const key of dimensions) {
      const labels=d[key] as Record<string,unknown>
      if (!labels || typeof labels!=='object' || Array.isArray(labels) || Object.keys(labels).length>128) throw new Error('invalid fleet labels')
      for (const [name,n] of Object.entries(labels)) if (reports===null || !name || name.length>128 || /[\x00-\x1f\x7f]/.test(name) || !Number.isSafeInteger(n) || (n as number)<10 || (n as number)>(reports as number)) throw new Error('small fleet label')
    }
  }
  return v as unknown as PublicFleetFeed
}
export async function collectFleet(env: AppEnv, nowMs = Date.now()) {
  const started = new Date(nowMs).toISOString()
  try {
    const r=await fetch('https://cloud.ftw.energy/v1/fleet/public',{redirect:'manual',headers:{accept:'application/json'},signal:AbortSignal.timeout(15000)})
    if (!r.ok) {await r.body?.cancel();throw new Error('fleet unavailable')}
    const reader=r.body?.getReader(); if (!reader) throw new Error('empty fleet')
    const parts:Uint8Array[]=[];let size=0
    try {while(true){const {done,value}=await reader.read();if(done)break;size+=value.length;if(size>256*1024)throw new Error('large fleet');parts.push(value)}}finally{await reader.cancel()}
    const bytes=new Uint8Array(size);let offset=0;for(const p of parts){bytes.set(p,offset);offset+=p.length}
    const feed=parseFleet(JSON.parse(new TextDecoder().decode(bytes)),nowMs)
    await env.DB.prepare('INSERT INTO cloud_fleet_view(id,observed_at,view_json) VALUES(1,?,?) ON CONFLICT(id) DO UPDATE SET observed_at=excluded.observed_at,view_json=excluded.view_json').bind(feed.observed_at,JSON.stringify(feed)).run()
    await saveCollectorRun(env.DB,'cloud:fleet',started,true,'public daily cells')
  } catch(e){await saveCollectorRun(env.DB,'cloud:fleet',started,false,'fleet source unavailable or invalid');throw e}
}

// This estimates reporting active installations, not lifetime installs or people.
// Seven complete UTC days dampen the box's 18–30 hour send interval.
export function installationEstimate(days: PublicFleetDay[], nowMs: number, observedAt: string | null, source: string) {
  const end=Date.UTC(new Date(nowMs).getUTCFullYear(),new Date(nowMs).getUTCMonth(),new Date(nowMs).getUTCDate())
  const dates=Array.from({length:7},(_,i)=>new Date(end-(7-i)*86400_000).toISOString().slice(0,10))
  const chosen=dates.map(date=>days.find(d=>d.date===date))
  if (chosen.some(d=>!d || typeof d.reports!=='number')) return {state:'insufficient',value:null,source,meaning:'reporting active installations, not all-time installs or people'}
  const reports=chosen.reduce((n,d)=>n+d!.reports!,0)
  return {state:observedAt && nowMs-Date.parse(observedAt)<=48*3600_000?'estimated':'stale',value:Math.round(reports/7),reports,days:7,window_start:dates[0],window_end:dates.at(-1),observed_at:observedAt,source,
    meaning:'reporting active installations, not all-time installs or people',method:'Reports per complete UTC day, averaged over 7 days. Assumes one successful report per installation per day on average. Opt-outs, offline boxes and failed sends are absent; restarts and test boxes can bias the estimate.'}
}
