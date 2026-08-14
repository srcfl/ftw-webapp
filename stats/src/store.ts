import type { AppEnv, FleetDay, FleetDimensions } from './types.ts'

interface GitHubRow {
  repo: string
  captured_hour: string
  captured_at: string
  stars: number
  forks: number
  watchers: number
  open_prs: number
  draft_prs: number
  dependency_prs: number
  open_issues: number
  merged_prs_30d: number
  closed_issues_30d: number
  contributors: number
  pushed_at: string | null
  latest_release: string | null
  latest_release_at: string | null
}

interface GitHubHistoryRow {
  repo: string
  date: string
  stars: number
  forks: number
}

interface TrafficRow {
  repo: string
  date: string
  views: number
  unique_visitors: number
  clones: number
  unique_cloners: number
  observed_at: string
}

interface SiteTrafficRow {
  date: string
  hostname: string
  requests: number
  visits: number
  response_bytes: number
  sample_interval: number
  observed_at: string
}

interface RelayRow {
  observed_at: string
  uptime_seconds: number
  rooms: number
  sockets: number
  frames_routed: number
  bytes_routed: number
}

interface FleetRow {
  date: string
  reports: number
  dimensions_json: string
  observed_at: string
}

interface ReferrerRow {
  repo: string
  date: string
  referrer: string
  visits: number
  unique_visitors: number
}

interface PathRow {
  repo: string
  date: string
  path: string
  title: string
  views: number
  unique_visitors: number
}

interface CollectorRow {
  source: string
  started_at: string
  finished_at: string
  ok: number
  detail: string
}

interface StoredFleetDay extends FleetDay {
  observed_at: string
}

const RELAY_REPORTING_MAX_AGE_MS = 15 * 60_000

export async function dashboardData(
  env: AppEnv,
  privateView: boolean,
  nowMs = Date.now()
): Promise<Record<string, unknown>> {
  const githubCutoff = new Date(nowMs - 90 * 24 * 60 * 60_000).toISOString()
  const trafficCutoff = new Date(nowMs - 30 * 24 * 60 * 60_000).toISOString().slice(0, 10)
  const relayCutoff = new Date(nowMs - 24 * 60 * 60_000).toISOString()
  const fleetCutoff = new Date(nowMs - 90 * 24 * 60 * 60_000).toISOString().slice(0, 10)

  const [latest, history, traffic, siteTraffic, relay, fleet, referrers, paths, collectors] =
    await Promise.all([
    env.DB.prepare(
      `WITH ranked AS (
         SELECT *, ROW_NUMBER() OVER (PARTITION BY repo ORDER BY captured_hour DESC) AS rank
         FROM github_snapshots
       )
       SELECT repo, captured_hour, captured_at, stars, forks, watchers, open_prs,
              draft_prs, dependency_prs, open_issues, merged_prs_30d,
              closed_issues_30d, contributors, pushed_at, latest_release,
              latest_release_at
       FROM ranked WHERE rank = 1`
    ).all<GitHubRow>(),
    env.DB.prepare(
      `WITH ranked AS (
         SELECT repo, substr(captured_hour, 1, 10) AS date, stars, forks,
                ROW_NUMBER() OVER (
                  PARTITION BY repo, substr(captured_hour, 1, 10)
                  ORDER BY captured_hour DESC
                ) AS rank
         FROM github_snapshots
         WHERE captured_hour >= ?
       )
       SELECT repo, date, stars, forks FROM ranked WHERE rank = 1
       ORDER BY date ASC, repo ASC`
    )
      .bind(githubCutoff)
      .all<GitHubHistoryRow>(),
    env.DB.prepare(
      `SELECT repo, date, views, unique_visitors, clones, unique_cloners, observed_at
       FROM github_traffic_daily WHERE date >= ? ORDER BY date ASC, repo ASC`
    )
      .bind(trafficCutoff)
      .all<TrafficRow>(),
    env.DB.prepare(
      `SELECT date, hostname, requests, visits, response_bytes, sample_interval, observed_at
       FROM site_traffic_daily WHERE date >= ? AND hostname = ? ORDER BY date ASC`
    )
      .bind(trafficCutoff, env.SITE_HOSTNAME)
      .all<SiteTrafficRow>(),
    env.DB.prepare(
      `SELECT observed_at, uptime_seconds, rooms, sockets, frames_routed, bytes_routed
       FROM relay_snapshots WHERE observed_at >= ? ORDER BY observed_at DESC LIMIT 300`
    )
      .bind(relayCutoff)
      .all<RelayRow>(),
    env.DB.prepare(
      `SELECT date, reports, dimensions_json, observed_at
       FROM fleet_daily WHERE date >= ? ORDER BY date ASC`
    )
      .bind(fleetCutoff)
      .all<FleetRow>(),
    env.DB.prepare(
      `WITH latest AS (SELECT repo, MAX(date) AS date FROM github_referrers GROUP BY repo)
       SELECT r.repo, r.date, r.referrer, r.visits, r.unique_visitors
       FROM github_referrers r
       JOIN latest l ON l.repo = r.repo AND l.date = r.date
       ORDER BY r.visits DESC`
    ).all<ReferrerRow>(),
    env.DB.prepare(
      `WITH latest AS (SELECT repo, MAX(date) AS date FROM github_paths GROUP BY repo)
       SELECT p.repo, p.date, p.path, p.title, p.views, p.unique_visitors
       FROM github_paths p
       JOIN latest l ON l.repo = p.repo AND l.date = p.date
       ORDER BY p.views DESC`
    ).all<PathRow>(),
    env.DB.prepare(
      `WITH ranked AS (
         SELECT *, ROW_NUMBER() OVER (PARTITION BY source ORDER BY finished_at DESC) AS rank
         FROM collector_runs
       )
       SELECT source, started_at, finished_at, ok, detail
       FROM ranked WHERE rank = 1 ORDER BY source`
    ).all<CollectorRow>(),
    ])

  const repoOrder = env.GITHUB_REPOS.split(',').map((repo) => repo.trim())
  const repositories = [...latest.results]
    .sort((a, b) => repoOrder.indexOf(a.repo) - repoOrder.indexOf(b.repo))
    .map(githubRepository)
  const githubHistory = history.results.map((row) => ({
    repo: row.repo,
    date: row.date,
    stars: row.stars,
    forks: row.forks,
  }))
  const trafficDays = traffic.results.map((row) => ({
    repo: row.repo,
    date: row.date,
    views: row.views,
    unique_visitors: row.unique_visitors,
    clones: row.clones,
    unique_cloners: row.unique_cloners,
  }))
  const fleetDays = fleet.results.map(storedFleetDay)
  const minimum = publicMinimum(env.PUBLIC_MIN_REPORTS)
  const github = {
    repositories,
    totals: githubTotals(repositories, githubHistory, trafficDays, nowMs),
    history: githubHistory,
    traffic: trafficDays,
    traffic_note: 'Unique counts are per repository and may count one person more than once.',
  }
  const fleetView = privateView
    ? {
        state: fleetDays.length > 0 ? 'visible' : 'empty',
        meaning: 'daily reports, not users or unique boxes',
        days: fleetDays,
      }
    : publicFleet(fleetDays, minimum, nowMs)
  const fleetVisible = privateView || fleetView.state === 'visible'
  const freshness: Record<string, string | null> = {
    github: latestTimestamp(latest.results.map((row) => row.captured_at)),
    github_traffic: latestTimestamp(traffic.results.map((row) => row.observed_at)),
    site: latestTimestamp(siteTraffic.results.map((row) => row.observed_at)),
    fleet: fleetVisible ? latestTimestamp(fleet.results.map((row) => row.observed_at)) : null,
  }
  if (privateView) freshness['relay'] = relay.results[0]?.observed_at ?? null

  const result: Record<string, unknown> = {
    schema: 'ftw.project-dashboard/1',
    mode: privateView ? 'private' : 'public',
    generated_at: new Date(nowMs).toISOString(),
    freshness,
    github,
    site: siteSummary(siteTraffic.results, env.SITE_HOSTNAME, nowMs),
    fleet: fleetView,
    relay_status: relayStatus(relay.results, nowMs),
  }

  if (privateView) {
    result['relay'] = relaySummary(relay.results)
    result['discovery'] = {
      referrers: referrers.results,
      paths: paths.results,
    }
    result['collectors'] = collectors.results.map((row) => ({
      source: row.source,
      started_at: row.started_at,
      finished_at: row.finished_at,
      ok: row.ok === 1,
      detail: row.detail,
    }))
  }

  return result
}

function siteSummary(rows: SiteTrafficRow[], hostname: string, nowMs: number): Record<string, unknown> {
  const cutoff = new Date(nowMs - 14 * 24 * 60 * 60_000).toISOString().slice(0, 10)
  const recent = rows.filter((row) => row.date >= cutoff)
  const days = recent.map((row) => ({
    date: row.date,
    requests: row.requests,
    visits: row.visits,
    response_bytes: row.response_bytes,
    sample_interval: row.sample_interval,
  }))
  return {
    state: days.length > 0 ? 'visible' : 'empty',
    hostname,
    meaning: 'Cloudflare visits, not users or unique people',
    sampled: recent.some((row) => row.sample_interval > 1),
    totals:
      days.length > 0
        ? {
            visits_14d: recent.reduce((sum, row) => sum + row.visits, 0),
            requests_14d: recent.reduce((sum, row) => sum + row.requests, 0),
            response_bytes_14d: recent.reduce((sum, row) => sum + row.response_bytes, 0),
          }
        : { visits_14d: null, requests_14d: null, response_bytes_14d: null },
    days,
    note: 'Visits are entry visits, not unique people. Cloudflare may sample these server-side counts.',
  }
}

export function publicFleet(days: StoredFleetDay[], minimum: number, nowMs: number): Record<string, unknown> {
  const cutoff = new Date(nowMs - 30 * 24 * 60 * 60_000).toISOString().slice(0, 10)
  const recent = days.filter((day) => day.date >= cutoff)
  const reports = recent.reduce((total, day) => total + day.reports, 0)
  if (reports < minimum) {
    return {
      state: reports === 0 ? 'empty' : 'withheld',
      meaning: 'daily reports, not users or unique boxes',
      minimum,
      reports_30d: null,
      days: [],
      dimensions: {},
    }
  }

  const aggregate = emptyDimensions()
  for (const day of recent) addDimensions(aggregate, day)
  const safeDimensions = Object.fromEntries(
    Object.entries(aggregate).map(([key, values]) => [key, visibleCounts(values, minimum)])
  )
  return {
    state: 'visible',
    meaning: 'daily reports, not users or unique boxes',
    minimum,
    reports_30d: reports,
    days: recent.map((day) => ({ date: day.date, reports: day.reports >= minimum ? day.reports : null })),
    dimensions: safeDimensions,
  }
}

function githubRepository(row: GitHubRow): Record<string, unknown> {
  return {
    repo: row.repo,
    captured_at: row.captured_at,
    stars: row.stars,
    forks: row.forks,
    watchers: row.watchers,
    open_prs: row.open_prs,
    draft_prs: row.draft_prs,
    dependency_prs: row.dependency_prs,
    open_issues: row.open_issues,
    merged_prs_30d: row.merged_prs_30d,
    closed_issues_30d: row.closed_issues_30d,
    contributors: row.contributors,
    pushed_at: row.pushed_at,
    latest_release: row.latest_release,
    latest_release_at: row.latest_release_at,
  }
}

function githubTotals(
  repositories: Record<string, unknown>[],
  history: GitHubHistoryRow[],
  traffic: Array<{
    date: string
    views: number
    unique_visitors: number
    clones: number
    unique_cloners: number
  }>,
  nowMs: number
): Record<string, unknown> {
  const total = (key: string): number =>
    repositories.reduce((sum, repo) => sum + (typeof repo[key] === 'number' ? (repo[key] as number) : 0), 0)
  const trafficCutoff = new Date(nowMs - 14 * 24 * 60 * 60_000).toISOString().slice(0, 10)
  const recentTraffic = traffic.filter((day) => day.date >= trafficCutoff)
  return {
    stars: total('stars'),
    stars_7d: changeForRepositories(history, repositories, 'stars', nowMs, 7),
    forks: total('forks'),
    forks_30d: changeForRepositories(history, repositories, 'forks', nowMs, 30),
    watchers: total('watchers'),
    open_prs: total('open_prs'),
    draft_prs: total('draft_prs'),
    dependency_prs: total('dependency_prs'),
    open_issues: total('open_issues'),
    merged_prs_30d: total('merged_prs_30d'),
    closed_issues_30d: total('closed_issues_30d'),
    contributor_identities: total('contributors'),
    views_14d: recentTraffic.reduce((sum, day) => sum + day.views, 0),
    unique_visitors_14d: recentTraffic.reduce((sum, day) => sum + day.unique_visitors, 0),
    clones_14d: recentTraffic.reduce((sum, day) => sum + day.clones, 0),
    unique_cloners_14d: recentTraffic.reduce((sum, day) => sum + day.unique_cloners, 0),
  }
}

function changeForRepositories(
  history: GitHubHistoryRow[],
  repositories: Record<string, unknown>[],
  key: 'stars' | 'forks',
  nowMs: number,
  days: number
): number | null {
  const target = new Date(nowMs - days * 24 * 60 * 60_000).toISOString().slice(0, 10)
  let change = 0
  for (const repository of repositories) {
    const repo = repository['repo']
    const current = repository[key]
    if (typeof repo !== 'string' || typeof current !== 'number') return null
    const baseline = history.filter((point) => point.repo === repo && point.date <= target).at(-1)
    if (!baseline) return null
    change += current - baseline[key]
  }
  return change
}

function relaySummary(rows: RelayRow[]): Record<string, unknown> {
  const latest = rows[0]
  if (!latest) return { state: 'empty', latest: null, window: null, series: [] }
  let baseline = latest
  let previous = latest
  for (const row of rows.slice(1)) {
    if (
      row.uptime_seconds > previous.uptime_seconds ||
      row.frames_routed > previous.frames_routed ||
      row.bytes_routed > previous.bytes_routed
    ) {
      break
    }
    baseline = row
    previous = row
  }
  return {
    state: 'visible',
    latest,
    window: {
      from: baseline.observed_at,
      to: latest.observed_at,
      frames: latest.frames_routed - baseline.frames_routed,
      bytes: latest.bytes_routed - baseline.bytes_routed,
    },
    series: [...rows].reverse().map((row) => ({
      observed_at: row.observed_at,
      rooms: row.rooms,
      sockets: row.sockets,
    })),
  }
}

function relayStatus(rows: RelayRow[], nowMs: number): Record<string, unknown> {
  const observedAt = rows[0]?.observed_at ?? null
  if (!observedAt) {
    return {
      state: 'empty',
      observed_at: null,
      meaning: 'export heartbeat only; no relay load or user counts',
    }
  }

  const observedMs = Date.parse(observedAt)
  const reporting = Number.isFinite(observedMs) && Math.max(0, nowMs - observedMs) <= RELAY_REPORTING_MAX_AGE_MS
  return {
    state: reporting ? 'reporting' : 'delayed',
    observed_at: observedAt,
    meaning: 'export heartbeat only; no relay load or user counts',
  }
}

function storedFleetDay(row: FleetRow): StoredFleetDay {
  return {
    date: row.date,
    reports: row.reports,
    ...readDimensions(row.dimensions_json),
    observed_at: row.observed_at,
  }
}

function readDimensions(json: string): FleetDimensions {
  try {
    const raw = JSON.parse(json) as Record<string, unknown>
    return {
      ftw_versions: numberRecord(raw['ftw_versions']),
      channels: numberRecord(raw['channels']),
      drivers: numberRecord(raw['drivers']),
      battery_kwh: numberRecord(raw['battery_kwh']),
      price_zones: numberRecord(raw['price_zones']),
      install_age: numberRecord(raw['install_age']),
    }
  } catch {
    return emptyDimensions()
  }
}

function numberRecord(value: unknown): Record<string, number> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return {}
  return Object.fromEntries(
    Object.entries(value).filter((entry): entry is [string, number] => Number.isSafeInteger(entry[1]) && entry[1] >= 0)
  )
}

function emptyDimensions(): FleetDimensions {
  return {
    ftw_versions: {},
    channels: {},
    drivers: {},
    battery_kwh: {},
    price_zones: {},
    install_age: {},
  }
}

function addDimensions(target: FleetDimensions, source: FleetDimensions): void {
  for (const key of Object.keys(target) as Array<keyof FleetDimensions>) {
    for (const [label, count] of Object.entries(source[key])) {
      target[key][label] = (target[key][label] ?? 0) + count
    }
  }
}

function visibleCounts(values: Record<string, number>, minimum: number): Record<string, number> {
  return Object.fromEntries(
    Object.entries(values)
      .filter(([, count]) => count >= minimum)
      .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
  )
}

function publicMinimum(value: string): number {
  const parsed = Number(value)
  return Number.isSafeInteger(parsed) && parsed >= 10 && parsed <= 1000 ? parsed : 10
}

function latestTimestamp(values: Array<string | null>): string | null {
  return values.filter((value): value is string => value !== null).sort().at(-1) ?? null
}
