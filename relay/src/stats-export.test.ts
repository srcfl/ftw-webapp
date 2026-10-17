// @vitest-environment node

import { createHmac } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { RelayServer, type RelayAggregateStats } from './server.ts'
import { RelayStatsExporter } from './stats-export.ts'

const SECRET = '0123456789abcdef0123456789abcdef'

function snapshot(): RelayAggregateStats {
  return {
    schema: 'ftw.relay-stats/1',
    observed_at: '2026-08-14T12:00:00.000Z',
    relay: {
      uptime_seconds: 300,
      rooms: 2,
      sockets: 3,
      frames_routed: 40,
      bytes_routed: 5000,
    },
    fleet: {
      schema: 'ftw.fleet-stats/1',
      meaning: 'reports, not unique boxes',
      days: [],
    },
  }
}

describe('relay project stats export', () => {
  it('signs the exact bounded body without adding an identity', async () => {
    let sent: { body: string; headers: Headers } | null = null
    const exporter = new RelayStatsExporter({
      url: 'https://stats.ftw.energy/api/ingest/relay',
      secret: SECRET,
      snapshot,
      now: () => Date.UTC(2026, 7, 14, 12),
      post: async (_url, init) => {
        sent = { body: String(init.body), headers: new Headers(init.headers) }
        return { status: 204 }
      },
    })

    expect(await exporter.sendOnce()).toBe(true)
    expect(sent).not.toBeNull()
    const body = sent!.body
    const timestamp = sent!.headers.get('x-ftw-timestamp')
    const expected = createHmac('sha256', SECRET).update(`${timestamp}.${body}`).digest('hex')
    expect(sent!.headers.get('x-ftw-signature')).toBe(`v1=${expected}`)
    expect(JSON.parse(body)).toEqual(snapshot())
    expect(body).not.toMatch(/handle|address|serial|gateway|site_name/)
  })

  it('keeps failures out of the relay path and logs a fixed message', async () => {
    const lines: string[] = []
    const exporter = new RelayStatsExporter({
      url: 'https://stats.ftw.energy/api/ingest/relay',
      secret: SECRET,
      snapshot,
      log: (line) => lines.push(line),
      post: async () => ({ status: 503 }),
    })
    expect(await exporter.sendOnce()).toBe(false)
    expect(lines).toEqual(['relay: stats export rejected'])
  })

  it('builds its snapshot from counts and never from room handles', async () => {
    const now = Date.UTC(2026, 7, 14, 12)
    const relay = await RelayServer.start({ now: () => now })
    try {
      expect(relay.aggregateStats()).toEqual({
        schema: 'ftw.relay-stats/1',
        observed_at: '2026-08-14T12:00:00.000Z',
        relay: {
          uptime_seconds: 0,
          rooms: 0,
          sockets: 0,
          frames_routed: 0,
          bytes_routed: 0,
        },
        fleet: {
          schema: 'ftw.fleet-stats/1',
          meaning: 'reports, not unique boxes',
          days: [],
        },
      })
      expect(JSON.stringify(relay.aggregateStats())).not.toContain('epoch')
    } finally {
      await relay.stop()
    }
  })
})
