/* Anonymous fleet reports, reduced to daily totals on arrival.
 *
 * The relay needs fleet numbers, not a second household log. A report carries
 * no id and this file never adds one: it validates the fixed FTW payload,
 * increments bounded counters for the current UTC day, then drops the body.
 * The persisted file contains only those counters for the latest 90 days.
 */

import { readFileSync, writeFileSync, mkdirSync, renameSync } from 'node:fs'
import { dirname } from 'node:path'

export const FLEET_REPORT_SCHEMA = 'ftw.fleet/1'
export const FLEET_STATS_SCHEMA = 'ftw.fleet-stats/1'

const REPORT_KEYS = [
  'schema',
  'ftw_version',
  'channel',
  'drivers',
  'battery_kwh',
  'price_zone',
  'install_age',
] as const
const RELEASE_RE = /^v[0-9]{1,4}\.[0-9]{1,4}\.[0-9]{1,4}(-beta\.[0-9]{1,4})?$/
const DRIVER_RE = /^[a-z0-9_]{1,64}$/
const ZONE_RE = /^[A-Z0-9-]{2,16}$/
const DAY_RE = /^\d{4}-\d{2}-\d{2}$/
const BATTERY_BUCKETS = new Set(['none', '0-5', '5-15', '15-30', '30+'])
const AGE_BUCKETS = new Set(['unknown', '0-1m', '1-6m', '6-12m', '1y+'])

const MAX_DRIVERS = 16
const MAX_DAYS = 90
const MAX_LABELS = 128
const MAX_REPORTS_PER_DAY = 100_000

type Counts = Record<string, number>

export interface FleetReport {
  schema: typeof FLEET_REPORT_SCHEMA
  ftw_version: string
  channel: 'stable' | 'beta' | 'unknown'
  drivers: string[]
  battery_kwh: string
  price_zone: string
  install_age: string
}

export interface FleetDay {
  date: string
  reports: number
  ftw_versions: Counts
  channels: Counts
  drivers: Counts
  battery_kwh: Counts
  price_zones: Counts
  install_age: Counts
}

export interface FleetStatsView {
  schema: typeof FLEET_STATS_SCHEMA
  meaning: 'reports, not unique boxes'
  days: FleetDay[]
}

export interface FleetStatsOptions {
  /** Empty keeps totals in memory only, which is useful in tests. */
  path: string
  now?: () => number
  /** Fixed messages only. Never pass a report or label. */
  log?: (line: string) => void
}

/** Strict validation for the only readable household-shaped body on the relay. */
export function fleetReportError(body: unknown): string | null {
  if (!isRecord(body)) return 'a JSON object'
  const keys = Object.keys(body).sort()
  const expected = [...REPORT_KEYS].sort()
  if (keys.length !== expected.length || keys.some((key, i) => key !== expected[i])) {
    return 'fields do not match ftw.fleet/1'
  }
  if (body['schema'] !== FLEET_REPORT_SCHEMA) return 'schema must be ftw.fleet/1'

  const version = body['ftw_version']
  const channel = body['channel']
  if (typeof version !== 'string' || (version !== 'unknown' && !RELEASE_RE.test(version))) {
    return 'ftw_version is not a release version'
  }
  const expectedChannel =
    version === 'unknown' ? 'unknown' : version.includes('-beta.') ? 'beta' : 'stable'
  if (channel !== expectedChannel) return 'channel does not match ftw_version'

  const drivers = body['drivers']
  if (!Array.isArray(drivers) || drivers.length > MAX_DRIVERS) {
    return `drivers must contain at most ${MAX_DRIVERS} names`
  }
  let previous = ''
  for (const driver of drivers) {
    if (typeof driver !== 'string' || !DRIVER_RE.test(driver)) {
      return 'drivers contains an invalid name'
    }
    if (previous !== '' && driver <= previous) return 'drivers must be sorted and unique'
    previous = driver
  }

  if (typeof body['battery_kwh'] !== 'string' || !BATTERY_BUCKETS.has(body['battery_kwh'])) {
    return 'battery_kwh is not a known bucket'
  }
  const zone = body['price_zone']
  if (typeof zone !== 'string' || (zone !== 'unknown' && !ZONE_RE.test(zone))) {
    return 'price_zone is not a known label'
  }
  if (typeof body['install_age'] !== 'string' || !AGE_BUCKETS.has(body['install_age'])) {
    return 'install_age is not a known bucket'
  }
  return null
}

export class FleetStats {
  #days = new Map<string, FleetDay>()
  #opts: Required<FleetStatsOptions>

  constructor(opts: FleetStatsOptions) {
    this.#opts = {
      path: opts.path,
      now: opts.now ?? (() => Date.now()),
      log: opts.log ?? (() => {}),
    }
    this.#load()
  }

  /** Add one validated report. False means the global daily safety cap is full. */
  put(body: FleetReport): boolean {
    const date = utcDate(this.#opts.now())
    const day = this.#days.get(date) ?? emptyDay(date)
    if (day.reports >= MAX_REPORTS_PER_DAY) return false

    day.reports += 1
    increment(day.ftw_versions, body.ftw_version)
    increment(day.channels, body.channel)
    if (body.drivers.length === 0) increment(day.drivers, 'none')
    else for (const driver of body.drivers) increment(day.drivers, driver)
    increment(day.battery_kwh, body.battery_kwh)
    increment(day.price_zones, body.price_zone)
    increment(day.install_age, body.install_age)
    this.#days.set(date, day)
    this.#prune()
    this.#save()
    return true
  }

  /** Full aggregate for the local operator endpoint. */
  view(): FleetStatsView {
    return {
      schema: FLEET_STATS_SCHEMA,
      meaning: 'reports, not unique boxes',
      days: [...this.#days.values()]
        .sort((a, b) => b.date.localeCompare(a.date))
        .map(copyDay),
    }
  }

  /** Counts only for the relay's existing audit and heartbeat surfaces. */
  inspect(): { days: number; reportsToday: number } {
    return {
      days: this.#days.size,
      reportsToday: this.#days.get(utcDate(this.#opts.now()))?.reports ?? 0,
    }
  }

  #prune(): void {
    const keep = [...this.#days.keys()].sort().slice(-MAX_DAYS)
    const allowed = new Set(keep)
    for (const date of this.#days.keys()) {
      if (!allowed.has(date)) this.#days.delete(date)
    }
  }

  #load(): void {
    if (!this.#opts.path) return
    try {
      const parsed = JSON.parse(readFileSync(this.#opts.path, 'utf8')) as unknown
      if (!isRecord(parsed) || parsed['schema'] !== FLEET_STATS_SCHEMA) return
      if (!Array.isArray(parsed['days'])) return
      for (const raw of parsed['days'].slice(0, MAX_DAYS)) {
        const day = readDay(raw)
        if (day) this.#days.set(day.date, day)
      }
      this.#prune()
    } catch {
      // A missing or bad file starts empty. Never include its contents in a log.
    }
  }

  #save(): void {
    if (!this.#opts.path) return
    try {
      mkdirSync(dirname(this.#opts.path), { recursive: true })
      const tmp = `${this.#opts.path}.tmp`
      writeFileSync(tmp, JSON.stringify(this.view()), { mode: 0o600 })
      renameSync(tmp, this.#opts.path)
    } catch {
      this.#opts.log('relay: fleet stats save failed')
    }
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function utcDate(nowMs: number): string {
  return new Date(nowMs).toISOString().slice(0, 10)
}

function emptyDay(date: string): FleetDay {
  return {
    date,
    reports: 0,
    ftw_versions: emptyCounts(),
    channels: emptyCounts(),
    drivers: emptyCounts(),
    battery_kwh: emptyCounts(),
    price_zones: emptyCounts(),
    install_age: emptyCounts(),
  }
}

function increment(counts: Counts, label: string): void {
  if (Object.hasOwn(counts, label)) {
    counts[label] = Math.min(MAX_REPORTS_PER_DAY, counts[label]! + 1)
    return
  }
  if (Object.keys(counts).length < MAX_LABELS - 1) {
    counts[label] = 1
    return
  }
  if (counts['other'] !== undefined || Object.keys(counts).length < MAX_LABELS) {
    counts['other'] = Math.min(MAX_REPORTS_PER_DAY, (counts['other'] ?? 0) + 1)
  }
}

function copyDay(day: FleetDay): FleetDay {
  return {
    date: day.date,
    reports: day.reports,
    ftw_versions: sortedCounts(day.ftw_versions),
    channels: sortedCounts(day.channels),
    drivers: sortedCounts(day.drivers),
    battery_kwh: sortedCounts(day.battery_kwh),
    price_zones: sortedCounts(day.price_zones),
    install_age: sortedCounts(day.install_age),
  }
}

function sortedCounts(counts: Counts): Counts {
  return Object.fromEntries(Object.entries(counts).sort(([a], [b]) => a.localeCompare(b)))
}

function readDay(raw: unknown): FleetDay | null {
  if (!isRecord(raw) || typeof raw['date'] !== 'string' || !validDate(raw['date'])) return null
  const reports = readCount(raw['reports'])
  const versions = readCounts(raw['ftw_versions'])
  const channels = readCounts(raw['channels'])
  const drivers = readCounts(raw['drivers'])
  const battery = readCounts(raw['battery_kwh'])
  const zones = readCounts(raw['price_zones'])
  const ages = readCounts(raw['install_age'])
  if (
    reports === null ||
    versions === null ||
    channels === null ||
    drivers === null ||
    battery === null ||
    zones === null ||
    ages === null
  ) {
    return null
  }
  return {
    date: raw['date'],
    reports,
    ftw_versions: versions,
    channels,
    drivers,
    battery_kwh: battery,
    price_zones: zones,
    install_age: ages,
  }
}

function validDate(date: string): boolean {
  if (!DAY_RE.test(date)) return false
  const parsed = Date.parse(`${date}T00:00:00Z`)
  return Number.isFinite(parsed) && utcDate(parsed) === date
}

function readCount(value: unknown): number | null {
  if (typeof value !== 'number' || !Number.isInteger(value)) return null
  if (value < 0 || value > MAX_REPORTS_PER_DAY) return null
  return value
}

function readCounts(value: unknown): Counts | null {
  if (!isRecord(value)) return null
  const entries = Object.entries(value)
  if (entries.length > MAX_LABELS) return null
  const out = emptyCounts()
  for (const [label, raw] of entries) {
    if (label.length === 0 || label.length > 64) return null
    const count = readCount(raw)
    if (count === null) return null
    out[label] = count
  }
  return out
}

/** Public labels must never reach Object.prototype through a counter lookup. */
function emptyCounts(): Counts {
  return Object.create(null) as Counts
}
