// @vitest-environment node

import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { RelayServer } from '../relay/src/server.ts'

const REPORT = {
  schema: 'ftw.fleet/1',
  ftw_version: 'v1.16.1-beta.20',
  channel: 'beta',
  drivers: ['easee_cloud', 'sungrow'],
  battery_kwh: '5-15',
  price_zone: 'SE4',
  install_age: '0-1m',
}

function httpURL(relay: RelayServer, path: string): string {
  return relay.url.replace(/^ws:/, 'http:') + path
}

async function post(relay: RelayServer, body: unknown, forwarded = '203.0.113.42') {
  return fetch(httpURL(relay, '/fleet'), {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-forwarded-for': forwarded,
    },
    body: JSON.stringify(body),
  })
}

describe('the relay fleet endpoint', () => {
  it('reduces a report to local daily totals without retaining its address', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'ftw-relay-fleet-'))
    const path = join(dir, 'fleet-stats.json')
    const relay = await RelayServer.start({
      heartbeatMs: 60_000,
      trustProxy: true,
      fleetStatsPath: path,
      now: () => Date.UTC(2026, 7, 12, 12),
    })
    try {
      expect((await post(relay, REPORT)).status).toBe(204)
      expect(relay.inspect().fleet).toEqual({ days: 1, reportsToday: 1 })

      const response = await fetch(httpURL(relay, '/fleet/stats'))
      expect(response.status).toBe(200)
      const stats = (await response.json()) as {
        meaning: string
        days: Array<{ reports: number; drivers: Record<string, number> }>
      }
      expect(stats.meaning).toBe('reports, not unique boxes')
      expect(stats.days[0]?.reports).toBe(1)
      expect(stats.days[0]?.drivers).toEqual({ easee_cloud: 1, sungrow: 1 })

      const disk = readFileSync(path, 'utf8')
      expect(disk).not.toContain('203.0.113.42')
      expect(disk).not.toContain('x-forwarded-for')
    } finally {
      await relay.stop()
    }
  })

  it('refuses widened bodies before they reach the totals', async () => {
    const relay = await RelayServer.start({ heartbeatMs: 60_000 })
    try {
      const response = await post(relay, { ...REPORT, gateway_id: 'box-7' })
      expect(response.status).toBe(400)
      expect(relay.inspect().fleet.reportsToday).toBe(0)
    } finally {
      await relay.stop()
    }
  })

  it('rate-limits reports without keeping an address list', async () => {
    const relay = await RelayServer.start({
      heartbeatMs: 60_000,
      trustProxy: true,
      fleetAttemptLimit: 1,
      fleetAttemptWindowMs: 60_000,
    })
    try {
      expect((await post(relay, REPORT)).status).toBe(204)
      expect((await post(relay, REPORT)).status).toBe(429)
      expect(relay.inspect().fleet.reportsToday).toBe(1)
      expect(JSON.stringify(relay.inspect())).not.toContain('203.0.113.42')
    } finally {
      await relay.stop()
    }
  })
})
