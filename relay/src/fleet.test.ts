// @vitest-environment node

import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  FLEET_REPORT_SCHEMA,
  FLEET_STATS_SCHEMA,
  FleetStats,
  fleetReportError,
  type FleetReport,
} from './fleet.ts'

function report(overrides: Partial<FleetReport> = {}): FleetReport {
  return {
    schema: FLEET_REPORT_SCHEMA,
    ftw_version: 'v1.16.1-beta.20',
    channel: 'beta',
    drivers: ['easee_cloud', 'sungrow'],
    battery_kwh: '5-15',
    price_zone: 'SE4',
    install_age: '0-1m',
    ...overrides,
  }
}

describe('fleet report validation', () => {
  it('accepts the exact body FTW sends', () => {
    expect(fleetReportError(report())).toBeNull()
  })

  it('rejects fields that could become an id or timestamp', () => {
    expect(fleetReportError({ ...report(), gateway_id: 'box-7' })).toMatch(/fields/)
    expect(fleetReportError({ ...report(), sent_at: Date.now() })).toMatch(/fields/)
  })

  it('holds versions, channels and drivers to the box contract', () => {
    expect(fleetReportError(report({ ftw_version: 'v1.16.1-fredrik' }))).toMatch(/version/)
    expect(fleetReportError(report({ channel: 'stable' }))).toMatch(/channel/)
    expect(fleetReportError(report({ drivers: ['sungrow', 'easee_cloud'] }))).toMatch(/sorted/)
    expect(fleetReportError(report({ drivers: ['home-at-vasagatan'] }))).toMatch(/invalid/)
  })

  it('accepts property-like driver names without treating them as object state', () => {
    expect(fleetReportError(report({ drivers: ['__proto__', 'constructor'] }))).toBeNull()
  })
})

describe('daily fleet totals', () => {
  it('stores counters only and reloads them', () => {
    const dir = mkdtempSync(join(tmpdir(), 'ftw-fleet-'))
    const path = join(dir, 'fleet-stats.json')
    const now = () => Date.UTC(2026, 7, 12, 12)
    const stats = new FleetStats({ path, now })

    expect(stats.put(report())).toBe(true)
    expect(stats.put(report({ ftw_version: 'v1.16.1', channel: 'stable', drivers: [] }))).toBe(true)

    expect(stats.view()).toEqual({
      schema: FLEET_STATS_SCHEMA,
      meaning: 'reports, not unique boxes',
      days: [
        {
          date: '2026-08-12',
          reports: 2,
          ftw_versions: { 'v1.16.1': 1, 'v1.16.1-beta.20': 1 },
          channels: { beta: 1, stable: 1 },
          drivers: { easee_cloud: 1, none: 1, sungrow: 1 },
          battery_kwh: { '5-15': 2 },
          price_zones: { SE4: 2 },
          install_age: { '0-1m': 2 },
        },
      ],
    })

    const stored = JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>
    expect(stored['schema']).toBe(FLEET_STATS_SCHEMA)
    expect(stored).not.toHaveProperty('reports_raw')
    expect(JSON.stringify(stored)).not.toContain('gateway_id')

    expect(new FleetStats({ path, now }).view()).toEqual(stats.view())
  })

  it('counts object property names as labels and keeps them through a restart', () => {
    const dir = mkdtempSync(join(tmpdir(), 'ftw-fleet-labels-'))
    const path = join(dir, 'fleet-stats.json')
    const now = () => Date.UTC(2026, 7, 12, 12)
    const stats = new FleetStats({ path, now })

    expect(stats.put(report({ drivers: ['__proto__', 'constructor'] }))).toBe(true)
    const drivers = stats.view().days[0]?.drivers ?? {}
    expect(Object.hasOwn(drivers, '__proto__')).toBe(true)
    expect(drivers['__proto__']).toBe(1)
    expect(drivers['constructor']).toBe(1)
    expect(new FleetStats({ path, now }).view()).toEqual(stats.view())
  })

  it('keeps only the latest 90 UTC days', () => {
    let now = Date.UTC(2026, 0, 1, 12)
    const stats = new FleetStats({ path: '', now: () => now })
    for (let day = 0; day < 91; day++) {
      expect(stats.put(report())).toBe(true)
      now += 24 * 60 * 60_000
    }

    const days = stats.view().days
    expect(days).toHaveLength(90)
    expect(days[0]?.date).toBe('2026-04-01')
    expect(days.at(-1)?.date).toBe('2026-01-02')
  })

  it('collapses excess labels instead of growing the stored file without bound', () => {
    const stats = new FleetStats({ path: '', now: () => Date.UTC(2026, 7, 12) })
    for (let patch = 0; patch < 130; patch++) {
      expect(stats.put(report({ ftw_version: `v1.0.${patch}`, channel: 'stable' }))).toBe(true)
    }

    const versions = stats.view().days[0]?.ftw_versions ?? {}
    expect(Object.keys(versions).length).toBeLessThanOrEqual(128)
    expect(versions['other']).toBe(3)
  })
})
