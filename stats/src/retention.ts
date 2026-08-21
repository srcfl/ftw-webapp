const DAY_MS = 24 * 60 * 60_000

export const RETENTION_DAYS = {
  githubSnapshots: 90,
  githubTraffic: 30,
  githubDiscovery: 30,
  siteTrafficComplete: 7,
  relaySnapshots: 90,
  fleetDaily: 90,
  collectorRuns: 90,
} as const

export interface RetentionCutoffs {
  githubSnapshots: string
  githubTraffic: string
  githubDiscovery: string
  siteTraffic: string
  relaySnapshots: string
  fleetDaily: string
  collectorRuns: string
}

export function retentionCutoffs(nowMs: number): RetentionCutoffs {
  return {
    githubSnapshots: rollingCutoff(nowMs, RETENTION_DAYS.githubSnapshots),
    githubTraffic: utcDayCutoff(nowMs, RETENTION_DAYS.githubTraffic, true),
    githubDiscovery: utcDayCutoff(nowMs, RETENTION_DAYS.githubDiscovery, true),
    siteTraffic: utcDayCutoff(nowMs, RETENTION_DAYS.siteTrafficComplete, false),
    relaySnapshots: rollingCutoff(nowMs, RETENTION_DAYS.relaySnapshots),
    fleetDaily: utcDayCutoff(nowMs, RETENTION_DAYS.fleetDaily, true),
    collectorRuns: rollingCutoff(nowMs, RETENTION_DAYS.collectorRuns),
  }
}

export async function pruneStoredData(db: D1Database, nowMs: number): Promise<void> {
  const cutoff = retentionCutoffs(nowMs)
  await db.batch([
    db.prepare('DELETE FROM github_snapshots WHERE captured_hour < ?').bind(cutoff.githubSnapshots),
    db.prepare('DELETE FROM github_traffic_daily WHERE date < ?').bind(cutoff.githubTraffic),
    db.prepare('DELETE FROM github_referrers WHERE date < ?').bind(cutoff.githubDiscovery),
    db.prepare('DELETE FROM github_paths WHERE date < ?').bind(cutoff.githubDiscovery),
    db.prepare('DELETE FROM site_traffic_daily WHERE date < ?').bind(cutoff.siteTraffic),
    db.prepare('DELETE FROM relay_snapshots WHERE observed_at < ?').bind(cutoff.relaySnapshots),
    db.prepare('DELETE FROM fleet_daily WHERE date < ?').bind(cutoff.fleetDaily),
    db.prepare('DELETE FROM collector_runs WHERE finished_at < ?').bind(cutoff.collectorRuns),
  ])
}

function rollingCutoff(nowMs: number, days: number): string {
  return new Date(nowMs - days * DAY_MS).toISOString()
}

export function utcDayCutoff(nowMs: number, days: number, includeToday: boolean): string {
  const today = new Date(nowMs)
  const todayMs = Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate())
  const offset = includeToday ? days - 1 : days
  return new Date(todayMs - offset * DAY_MS).toISOString().slice(0, 10)
}
