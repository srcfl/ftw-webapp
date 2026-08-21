import { saveCollectorRun } from './collector.ts'
import type { AppEnv, GitHubSnapshot } from './types.ts'

const API_ROOT = 'https://api.github.com'
const API_VERSION = '2022-11-28'
const MAX_RESPONSE_BYTES = 2 * 1024 * 1024
const MAX_PAGES = 10
const NAME_RE = /^[A-Za-z0-9_.-]{1,100}$/

type JsonRecord = Record<string, unknown>

interface TrafficPoint {
  timestamp: string
  count: number
  uniques: number
}

interface ReferrerPoint {
  referrer: string
  count: number
  uniques: number
}

interface PathPoint {
  path: string
  title: string
  count: number
  uniques: number
}

interface ReleasePoint {
  tag: string
  publishedAt: string | null
}

export async function collectGitHub(env: AppEnv, daily: boolean, nowMs = Date.now()): Promise<void> {
  const token = env.GITHUB_TOKEN
  if (!token) throw new Error('GITHUB_TOKEN is not configured')

  const owner = checkedName(env.GITHUB_OWNER, 'GitHub owner')
  const repos = parseRepos(env.GITHUB_REPOS)
  const startedAt = new Date(nowMs).toISOString()
  let complete = 0

  for (const repo of repos) {
    try {
      const snapshot = await collectSnapshot(owner, repo, token, nowMs)
      await saveSnapshot(env.DB, snapshot)
      complete += 1
      await saveCollectorRun(env.DB, `github:${repo}`, startedAt, true, 'repository snapshot')
    } catch (error) {
      console.error('stats: GitHub repository collection failed', {
        repo,
        kind: error instanceof Error ? error.name : 'unknown',
      })
      await saveCollectorRun(env.DB, `github:${repo}`, startedAt, false, 'repository request failed')
    }

    if (!daily) continue
    try {
      await collectTraffic(env.DB, owner, repo, token, nowMs)
      await saveCollectorRun(env.DB, `github-traffic:${repo}`, startedAt, true, 'traffic window')
    } catch (error) {
      console.error('stats: GitHub traffic collection failed', {
        repo,
        kind: error instanceof Error ? error.name : 'unknown',
      })
      await saveCollectorRun(env.DB, `github-traffic:${repo}`, startedAt, false, 'traffic request failed')
    }
  }

  if (complete === 0) throw new Error('all GitHub repository requests failed')
}

export function parseRepos(value: string): string[] {
  const repos = [...new Set(value.split(',').map((repo) => repo.trim()).filter(Boolean))]
  if (repos.length === 0 || repos.length > 10) throw new Error('GITHUB_REPOS must name 1 to 10 repositories')
  return repos.map((repo) => checkedName(repo, 'GitHub repository'))
}

async function collectSnapshot(
  owner: string,
  repo: string,
  token: string,
  nowMs: number
): Promise<GitHubSnapshot> {
  const encodedRepo = `${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`
  const cutoff = new Date(nowMs - 30 * 24 * 60 * 60_000).toISOString().slice(0, 10)
  const [rawRepo, pulls, issues, contributors, mergedPrs30d, closedIssues30d, release] =
    await Promise.all([
      githubJson(`/repos/${encodedRepo}`, token),
      githubPages(`/repos/${encodedRepo}/pulls?state=open`, token),
      githubPages(`/repos/${encodedRepo}/issues?state=open`, token),
      githubPages(`/repos/${encodedRepo}/contributors?anon=1`, token),
      githubSearchTotal(`repo:${owner}/${repo} is:pr is:merged merged:>=${cutoff}`, token),
      githubSearchTotal(`repo:${owner}/${repo} is:issue is:closed closed:>=${cutoff}`, token),
      latestRelease(encodedRepo, token),
    ])

  const repoData = record(rawRepo, 'repository')
  const openPulls = pulls.map((pull) => record(pull, 'pull request'))
  const openIssues = issues.map((issue) => record(issue, 'issue')).filter((issue) => !('pull_request' in issue))
  const capturedAt = new Date(nowMs).toISOString()

  return {
    repo,
    capturedHour: `${capturedAt.slice(0, 13)}:00:00.000Z`,
    capturedAt,
    stars: nonNegativeInt(repoData['stargazers_count'], 'stargazers_count'),
    forks: nonNegativeInt(repoData['forks_count'], 'forks_count'),
    watchers: nonNegativeInt(repoData['subscribers_count'], 'subscribers_count'),
    openPrs: openPulls.length,
    draftPrs: openPulls.filter((pull) => pull['draft'] === true).length,
    dependencyPrs: openPulls.filter(isDependencyPull).length,
    openIssues: openIssues.length,
    mergedPrs30d,
    closedIssues30d,
    contributors: contributors.length,
    pushedAt: optionalIso(repoData['pushed_at'], 'pushed_at'),
    latestRelease: release?.tag ?? null,
    latestReleaseAt: release?.publishedAt ?? null,
  }
}

async function collectTraffic(
  db: D1Database,
  owner: string,
  repo: string,
  token: string,
  nowMs: number
): Promise<void> {
  const encodedRepo = `${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`
  const [rawViews, rawClones, rawReferrers, rawPaths] = await Promise.all([
    githubJson(`/repos/${encodedRepo}/traffic/views?per=day`, token),
    githubJson(`/repos/${encodedRepo}/traffic/clones?per=day`, token),
    githubJson(`/repos/${encodedRepo}/traffic/popular/referrers`, token),
    githubJson(`/repos/${encodedRepo}/traffic/popular/paths`, token),
  ])

  const views = trafficPoints(record(rawViews, 'views')['views'], 'views')
  const clones = trafficPoints(record(rawClones, 'clones')['clones'], 'clones')
  const referrers = referrerPoints(rawReferrers)
  const paths = pathPoints(rawPaths)
  const observedAt = new Date(nowMs).toISOString()
  const byDate = new Map<string, { views: number; uniqueVisitors: number; clones: number; uniqueCloners: number }>()

  for (const point of views) {
    byDate.set(point.timestamp.slice(0, 10), {
      views: point.count,
      uniqueVisitors: point.uniques,
      clones: 0,
      uniqueCloners: 0,
    })
  }
  for (const point of clones) {
    const date = point.timestamp.slice(0, 10)
    const day = byDate.get(date) ?? { views: 0, uniqueVisitors: 0, clones: 0, uniqueCloners: 0 }
    day.clones = point.count
    day.uniqueCloners = point.uniques
    byDate.set(date, day)
  }

  const trafficWrites = [...byDate].map(([date, day]) =>
    db
      .prepare(
        `INSERT INTO github_traffic_daily
          (repo, date, views, unique_visitors, clones, unique_cloners, observed_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(repo, date) DO UPDATE SET
          views = excluded.views,
          unique_visitors = excluded.unique_visitors,
          clones = excluded.clones,
          unique_cloners = excluded.unique_cloners,
          observed_at = excluded.observed_at`
      )
      .bind(repo, date, day.views, day.uniqueVisitors, day.clones, day.uniqueCloners, observedAt)
  )
  if (trafficWrites.length > 0) await db.batch(trafficWrites)

  const date = observedAt.slice(0, 10)
  const referrerWrites = [
    db.prepare('DELETE FROM github_referrers WHERE repo = ? AND date = ?').bind(repo, date),
    ...referrers.map((point) =>
      db
        .prepare(
          `INSERT INTO github_referrers
            (repo, date, referrer, visits, unique_visitors)
           VALUES (?, ?, ?, ?, ?)`
        )
        .bind(repo, date, point.referrer, point.count, point.uniques)
    ),
  ]
  await db.batch(referrerWrites)

  const pathWrites = [
    db.prepare('DELETE FROM github_paths WHERE repo = ? AND date = ?').bind(repo, date),
    ...paths.map((point) =>
      db
        .prepare(
          `INSERT INTO github_paths
            (repo, date, path, title, views, unique_visitors)
           VALUES (?, ?, ?, ?, ?, ?)`
        )
        .bind(repo, date, point.path, point.title, point.count, point.uniques)
    ),
  ]
  await db.batch(pathWrites)
}

async function saveSnapshot(db: D1Database, snapshot: GitHubSnapshot): Promise<void> {
  await db
    .prepare(
      `INSERT INTO github_snapshots
        (repo, captured_hour, captured_at, stars, forks, watchers, open_prs, draft_prs,
         dependency_prs, open_issues, merged_prs_30d, closed_issues_30d, contributors,
         pushed_at, latest_release, latest_release_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(repo, captured_hour) DO UPDATE SET
        captured_at = excluded.captured_at,
        stars = excluded.stars,
        forks = excluded.forks,
        watchers = excluded.watchers,
        open_prs = excluded.open_prs,
        draft_prs = excluded.draft_prs,
        dependency_prs = excluded.dependency_prs,
        open_issues = excluded.open_issues,
        merged_prs_30d = excluded.merged_prs_30d,
        closed_issues_30d = excluded.closed_issues_30d,
        contributors = excluded.contributors,
        pushed_at = excluded.pushed_at,
        latest_release = excluded.latest_release,
        latest_release_at = excluded.latest_release_at`
    )
    .bind(
      snapshot.repo,
      snapshot.capturedHour,
      snapshot.capturedAt,
      snapshot.stars,
      snapshot.forks,
      snapshot.watchers,
      snapshot.openPrs,
      snapshot.draftPrs,
      snapshot.dependencyPrs,
      snapshot.openIssues,
      snapshot.mergedPrs30d,
      snapshot.closedIssues30d,
      snapshot.contributors,
      snapshot.pushedAt,
      snapshot.latestRelease,
      snapshot.latestReleaseAt
    )
    .run()
}

async function githubSearchTotal(query: string, token: string): Promise<number> {
  const raw = await githubJson(`/search/issues?q=${encodeURIComponent(query)}&per_page=1`, token)
  return nonNegativeInt(record(raw, 'search result')['total_count'], 'total_count')
}

async function latestRelease(encodedRepo: string, token: string): Promise<ReleasePoint | null> {
  const raw = await githubJson(`/repos/${encodedRepo}/releases/latest`, token, true)
  if (raw === null) return null
  const release = record(raw, 'release')
  const tag = shortString(release['tag_name'], 'tag_name', 128)
  return { tag, publishedAt: optionalIso(release['published_at'], 'published_at') }
}

async function githubPages(path: string, token: string): Promise<unknown[]> {
  const rows: unknown[] = []
  for (let page = 1; page <= MAX_PAGES; page += 1) {
    const url = new URL(path, API_ROOT)
    url.searchParams.set('per_page', '100')
    url.searchParams.set('page', String(page))
    const raw = await githubJson(`${url.pathname}${url.search}`, token)
    if (!Array.isArray(raw)) throw new TypeError('GitHub page was not an array')
    rows.push(...raw)
    if (raw.length < 100) return rows
  }
  throw new RangeError('GitHub result exceeded the page limit')
}

async function githubJson(path: string, token: string, allow404 = false): Promise<unknown | null> {
  const response = await fetch(new URL(path, API_ROOT), {
    headers: {
      accept: 'application/vnd.github+json',
      authorization: `Bearer ${token}`,
      'user-agent': 'ftw-project-stats/1',
      'x-github-api-version': API_VERSION,
    },
  })
  if (allow404 && response.status === 404) {
    await response.body?.cancel()
    return null
  }
  if (!response.ok) {
    await response.body?.cancel()
    throw new GitHubRequestError(response.status)
  }

  const length = Number(response.headers.get('content-length') ?? 0)
  if (Number.isFinite(length) && length > MAX_RESPONSE_BYTES) throw new RangeError('GitHub response was too large')
  const text = await response.text()
  if (new TextEncoder().encode(text).byteLength > MAX_RESPONSE_BYTES) {
    throw new RangeError('GitHub response was too large')
  }
  return JSON.parse(text) as unknown
}

class GitHubRequestError extends Error {
  override name = 'GitHubRequestError'

  constructor(status: number) {
    super(`GitHub returned HTTP ${status}`)
  }
}

function isDependencyPull(pull: JsonRecord): boolean {
  const user = pull['user']
  if (!isRecord(user)) return false
  const login = user['login']
  return typeof login === 'string' && login.toLowerCase().startsWith('dependabot')
}

function trafficPoints(value: unknown, label: string): TrafficPoint[] {
  if (!Array.isArray(value) || value.length > 31) throw new TypeError(`${label} was not a bounded array`)
  return value.map((raw) => {
    const point = record(raw, label)
    return {
      timestamp: isoString(point['timestamp'], 'timestamp'),
      count: nonNegativeInt(point['count'], 'count'),
      uniques: nonNegativeInt(point['uniques'], 'uniques'),
    }
  })
}

function referrerPoints(value: unknown): ReferrerPoint[] {
  if (!Array.isArray(value) || value.length > 20) throw new TypeError('referrers was not a bounded array')
  return value.map((raw) => {
    const point = record(raw, 'referrer')
    return {
      referrer: shortString(point['referrer'], 'referrer', 256),
      count: nonNegativeInt(point['count'], 'count'),
      uniques: nonNegativeInt(point['uniques'], 'uniques'),
    }
  })
}

function pathPoints(value: unknown): PathPoint[] {
  if (!Array.isArray(value) || value.length > 20) throw new TypeError('paths was not a bounded array')
  return value.map((raw) => {
    const point = record(raw, 'path')
    return {
      path: shortString(point['path'], 'path', 512),
      title:
        typeof point['title'] === 'string' && point['title'].length > 0
          ? shortString(point['title'], 'title', 512)
          : shortString(point['path'], 'path', 512),
      count: nonNegativeInt(point['count'], 'count'),
      uniques: nonNegativeInt(point['uniques'], 'uniques'),
    }
  })
}

function checkedName(value: string, label: string): string {
  if (!NAME_RE.test(value)) throw new Error(`${label} is invalid`)
  return value
}

function nonNegativeInt(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) throw new TypeError(`${label} was not a count`)
  return value as number
}

function shortString(value: unknown, label: string, max: number): string {
  if (typeof value !== 'string' || value.length === 0 || value.length > max) {
    throw new TypeError(`${label} was not a short string`)
  }
  return value
}

function optionalIso(value: unknown, label: string): string | null {
  if (value === null) return null
  return isoString(value, label)
}

function isoString(value: unknown, label: string): string {
  if (typeof value !== 'string' || !Number.isFinite(Date.parse(value))) {
    throw new TypeError(`${label} was not a timestamp`)
  }
  return value
}

function record(value: unknown, label: string): JsonRecord {
  if (!isRecord(value)) throw new TypeError(`${label} was not an object`)
  return value
}

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
