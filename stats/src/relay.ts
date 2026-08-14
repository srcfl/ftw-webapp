import type { AppEnv, FleetDay, FleetDimensions, RelayIngestBody } from './types.ts'

const MAX_BODY_BYTES = 256 * 1024
const MAX_CLOCK_SKEW_SECONDS = 5 * 60
const MAX_OBSERVATION_AGE_MS = 15 * 60_000
const MAX_FLEET_DAYS = 14
const MAX_LABELS = 128
const MAX_LABEL_LENGTH = 128
const MAX_COUNT = 100_000
const DAY_RE = /^\d{4}-\d{2}-\d{2}$/
const encoder = new TextEncoder()

const BODY_KEYS = ['fleet', 'observed_at', 'relay', 'schema'] as const
const RELAY_KEYS = ['bytes_routed', 'frames_routed', 'rooms', 'sockets', 'uptime_seconds'] as const
const FLEET_KEYS = ['days', 'meaning', 'schema'] as const
const DAY_KEYS = [
  'battery_kwh',
  'channels',
  'date',
  'drivers',
  'ftw_versions',
  'install_age',
  'price_zones',
  'reports',
] as const

export async function ingestRelay(
  request: Request,
  env: AppEnv,
  nowMs = Date.now()
): Promise<Response> {
  const secret = env.RELAY_INGEST_SECRET
  if (!secret || encoder.encode(secret).byteLength < 32) {
    return jsonError(503, 'relay ingest is not configured')
  }

  try {
    const bodyText = await readLimitedText(request, MAX_BODY_BYTES)
    await verifySignature(request, bodyText, secret, nowMs)
    const body = relayBody(JSON.parse(bodyText) as unknown, nowMs)
    await saveRelay(env.DB, body, nowMs)
    return new Response(null, { status: 204 })
  } catch (error) {
    if (error instanceof IngestError) return jsonError(error.status, error.message)
    console.error('stats: relay ingest failed', {
      kind: error instanceof Error ? error.name : 'unknown',
    })
    return jsonError(400, 'invalid relay stats')
  }
}

export function relayBody(value: unknown, nowMs: number): RelayIngestBody {
  const body = exactRecord(value, BODY_KEYS, 'body')
  if (body['schema'] !== 'ftw.relay-stats/1') throw new IngestError(400, 'unknown schema')

  const observedAt = exactIso(body['observed_at'], 'observed_at')
  const observedMs = Date.parse(observedAt)
  if (Math.abs(nowMs - observedMs) > MAX_OBSERVATION_AGE_MS) {
    throw new IngestError(400, 'stale observation')
  }

  const relay = exactRecord(body['relay'], RELAY_KEYS, 'relay')
  const fleet = exactRecord(body['fleet'], FLEET_KEYS, 'fleet')
  if (fleet['schema'] !== 'ftw.fleet-stats/1' || fleet['meaning'] !== 'reports, not unique boxes') {
    throw new IngestError(400, 'invalid fleet summary')
  }
  if (!Array.isArray(fleet['days']) || fleet['days'].length > MAX_FLEET_DAYS) {
    throw new IngestError(400, 'too many fleet days')
  }

  const days = fleet['days'].map((day) => fleetDay(day, nowMs))
  if (new Set(days.map((day) => day.date)).size !== days.length) {
    throw new IngestError(400, 'duplicate fleet day')
  }

  return {
    schema: 'ftw.relay-stats/1',
    observed_at: observedAt,
    relay: {
      uptime_seconds: count(relay['uptime_seconds'], 10 * 365 * 24 * 60 * 60, 'uptime_seconds'),
      rooms: count(relay['rooms'], MAX_COUNT, 'rooms'),
      sockets: count(relay['sockets'], MAX_COUNT, 'sockets'),
      frames_routed: count(relay['frames_routed'], Number.MAX_SAFE_INTEGER, 'frames_routed'),
      bytes_routed: count(relay['bytes_routed'], Number.MAX_SAFE_INTEGER, 'bytes_routed'),
    },
    fleet: {
      schema: 'ftw.fleet-stats/1',
      meaning: 'reports, not unique boxes',
      days,
    },
  }
}

async function saveRelay(db: D1Database, body: RelayIngestBody, nowMs: number): Promise<void> {
  const receivedAt = new Date(nowMs).toISOString()
  const statements = [
    db
      .prepare(
        `INSERT INTO relay_snapshots
          (observed_at, received_at, uptime_seconds, rooms, sockets, frames_routed, bytes_routed)
         VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(observed_at) DO UPDATE SET
          received_at = excluded.received_at,
          uptime_seconds = excluded.uptime_seconds,
          rooms = excluded.rooms,
          sockets = excluded.sockets,
          frames_routed = excluded.frames_routed,
          bytes_routed = excluded.bytes_routed`
      )
      .bind(
        body.observed_at,
        receivedAt,
        body.relay.uptime_seconds,
        body.relay.rooms,
        body.relay.sockets,
        body.relay.frames_routed,
        body.relay.bytes_routed
      ),
    ...body.fleet.days.map((day) =>
      db
        .prepare(
          `INSERT INTO fleet_daily (date, reports, dimensions_json, observed_at)
           VALUES (?, ?, ?, ?)
           ON CONFLICT(date) DO UPDATE SET
            reports = excluded.reports,
            dimensions_json = excluded.dimensions_json,
            observed_at = excluded.observed_at`
        )
        .bind(day.date, day.reports, JSON.stringify(dimensions(day)), body.observed_at)
    ),
    db
      .prepare('DELETE FROM relay_snapshots WHERE observed_at < ?')
      .bind(new Date(nowMs - 90 * 24 * 60 * 60_000).toISOString()),
  ]
  await db.batch(statements)
}

async function verifySignature(
  request: Request,
  body: string,
  secret: string,
  nowMs: number
): Promise<void> {
  const rawTimestamp = request.headers.get('x-ftw-timestamp')
  const rawSignature = request.headers.get('x-ftw-signature')
  if (!rawTimestamp || !/^\d{10}$/.test(rawTimestamp) || !rawSignature) {
    throw new IngestError(401, 'missing signature')
  }
  const timestamp = Number(rawTimestamp)
  if (Math.abs(Math.floor(nowMs / 1000) - timestamp) > MAX_CLOCK_SKEW_SECONDS) {
    throw new IngestError(401, 'expired signature')
  }
  const match = /^v1=([0-9a-f]{64})$/i.exec(rawSignature)
  if (!match?.[1]) throw new IngestError(401, 'invalid signature')

  const key = await crypto.subtle.importKey(
    'raw',
    encoder.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['verify']
  )
  const valid = await crypto.subtle.verify(
    'HMAC',
    key,
    hexBytes(match[1]),
    encoder.encode(`${rawTimestamp}.${body}`)
  )
  if (!valid) throw new IngestError(401, 'invalid signature')
}

async function readLimitedText(request: Request, limit: number): Promise<string> {
  const declared = Number(request.headers.get('content-length') ?? 0)
  if (Number.isFinite(declared) && declared > limit) throw new IngestError(413, 'body too large')
  if (!request.body) return ''

  const reader = request.body.getReader()
  const decoder = new TextDecoder('utf-8', { fatal: true })
  let size = 0
  let text = ''
  try {
    while (true) {
      const chunk = await reader.read()
      if (chunk.done) break
      size += chunk.value.byteLength
      if (size > limit) throw new IngestError(413, 'body too large')
      text += decoder.decode(chunk.value, { stream: true })
    }
    text += decoder.decode()
    return text
  } catch (error) {
    await reader.cancel().catch(() => {})
    throw error
  }
}

function fleetDay(value: unknown, nowMs: number): FleetDay {
  const day = exactRecord(value, DAY_KEYS, 'fleet day')
  const date = day['date']
  if (typeof date !== 'string' || !validDay(date)) throw new IngestError(400, 'invalid fleet date')
  const dayMs = Date.parse(`${date}T00:00:00.000Z`)
  if (dayMs > nowMs + 24 * 60 * 60_000 || dayMs < nowMs - 100 * 24 * 60 * 60_000) {
    throw new IngestError(400, 'fleet date outside retention')
  }

  const reports = count(day['reports'], MAX_COUNT, 'reports')
  const result: FleetDay = {
    date,
    reports,
    ftw_versions: counts(day['ftw_versions']),
    channels: counts(day['channels']),
    drivers: counts(day['drivers']),
    battery_kwh: counts(day['battery_kwh']),
    price_zones: counts(day['price_zones']),
    install_age: counts(day['install_age']),
  }
  for (const key of ['ftw_versions', 'channels', 'battery_kwh', 'price_zones', 'install_age'] as const) {
    if (sum(result[key]) !== reports) throw new IngestError(400, `${key} does not match reports`)
  }
  const driverReports = sum(result.drivers)
  if (driverReports < reports || driverReports > reports * 16) {
    throw new IngestError(400, 'drivers does not match reports')
  }
  return result
}

function dimensions(day: FleetDay): FleetDimensions {
  return {
    ftw_versions: day.ftw_versions,
    channels: day.channels,
    drivers: day.drivers,
    battery_kwh: day.battery_kwh,
    price_zones: day.price_zones,
    install_age: day.install_age,
  }
}

function counts(value: unknown): Record<string, number> {
  if (!isRecord(value)) throw new IngestError(400, 'dimension is not an object')
  const entries = Object.entries(value)
  if (entries.length > MAX_LABELS) throw new IngestError(400, 'too many labels')
  const result: Record<string, number> = Object.create(null) as Record<string, number>
  for (const [label, rawCount] of entries) {
    if (label.length === 0 || label.length > MAX_LABEL_LENGTH || /[\u0000-\u001f]/.test(label)) {
      throw new IngestError(400, 'invalid label')
    }
    result[label] = count(rawCount, MAX_COUNT, 'label count')
  }
  return result
}

function count(value: unknown, max: number, label: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0 || (value as number) > max) {
    throw new IngestError(400, `${label} is not a count`)
  }
  return value as number
}

function sum(values: Record<string, number>): number {
  return Object.values(values).reduce((total, value) => total + value, 0)
}

function exactIso(value: unknown, label: string): string {
  if (typeof value !== 'string' || !Number.isFinite(Date.parse(value))) {
    throw new IngestError(400, `${label} is not a timestamp`)
  }
  const normalized = new Date(value).toISOString()
  if (normalized !== value) throw new IngestError(400, `${label} is not canonical`)
  return value
}

function validDay(value: string): boolean {
  if (!DAY_RE.test(value)) return false
  return new Date(`${value}T00:00:00.000Z`).toISOString().slice(0, 10) === value
}

function exactRecord<const T extends readonly string[]>(
  value: unknown,
  keys: T,
  label: string
): Record<T[number], unknown> {
  if (!isRecord(value)) throw new IngestError(400, `${label} is not an object`)
  const actual = Object.keys(value).sort()
  const expected = [...keys].sort()
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
    throw new IngestError(400, `${label} fields do not match schema`)
  }
  return value as Record<T[number], unknown>
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function hexBytes(value: string): Uint8Array<ArrayBuffer> {
  const bytes = new Uint8Array(new ArrayBuffer(value.length / 2))
  for (let index = 0; index < bytes.length; index += 1) {
    bytes[index] = Number.parseInt(value.slice(index * 2, index * 2 + 2), 16)
  }
  return bytes
}

function jsonError(status: number, message: string): Response {
  return Response.json(
    { error: message },
    { status, headers: { 'cache-control': 'no-store' } }
  )
}

class IngestError extends Error {
  override name = 'IngestError'

  constructor(
    readonly status: number,
    message: string
  ) {
    super(message)
  }
}
