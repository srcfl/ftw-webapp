/* The dead man's switch: the one thing the relay holds.
 *
 * A box can push every notification itself except one — that it is gone.
 * So it leaves a sealed message here: an opaque id, a push endpoint, a
 * ciphertext the box encrypted at home, a deadline, and a pre-signed
 * delivery authorisation. While a socket claims the id, the switch is
 * held. When the claim drops and stays dropped past the deadline, the
 * relay posts the ciphertext to the endpoint, once, and waits for the id
 * to be claimed again before it will ever fire again.
 *
 * This file is the relay's first persisted state, and the shape of the row
 * is the whole privacy budget: four fields and an opaque header. The relay
 * cannot read the message (RFC 8291 ciphertext, keys it never had), cannot
 * name the household (the id is hex the box derived from a secret that
 * never comes here), and cannot sign deliveries (the auth header arrives
 * pre-signed, expiring on its own). What it undeniably learns is that
 * somebody's box exists and which push service they use — the honest cost
 * of the feature, written in the README's claim table.
 *
 * Nothing here touches the routing path. A claim is one text word on the
 * uplink socket; room traffic stays binary, uninterpreted, unpadded and
 * untrimmed exactly as before.
 */

import { readFileSync, writeFileSync, mkdirSync, renameSync } from 'node:fs'
import { dirname } from 'node:path'

export interface DeadmanRow {
  id: string
  endpoint: string
  /** Base64 (standard, padded) of the RFC 8291 aes128gcm ciphertext. */
  ct: string
  deadlineS: number
  /** Pre-signed `Authorization` header value, opaque here. Optional so an
   *  older box's row is stored rather than refused; delivery without it
   *  meets the push service's own refusal. */
  auth?: string
  /** Wall-clock ms of the last firing, so a flapping outage cannot storm
   *  a lock screen even across relay restarts. */
  lastFiredAtMs?: number
}

interface Armed {
  /** Wall-clock ms past which the switch fires. */
  fireAtMs: number
}

/** Fires may not repeat for one id faster than this, claims or not. */
export const REFIRE_FLOOR_MS = 30 * 60_000

/** A decoded ciphertext larger than this is not a push message. */
export const MAX_CT_BYTES = 8192

const MAX_AUTH_CHARS = 512
const ID_RE = /^[0-9a-f]{32}$/

/** Strict row validation. Returns a sentence for the 4xx body, or null. */
export function rowError(body: unknown): string | null {
  if (typeof body !== 'object' || body === null) return 'a JSON object'
  const b = body as Record<string, unknown>
  if (typeof b['id'] !== 'string' || !ID_RE.test(b['id'])) return 'id must be 32 hex chars'
  if (typeof b['endpoint'] !== 'string' || !b['endpoint'].startsWith('https://')) {
    return 'endpoint must be an https url'
  }
  if (typeof b['ct'] !== 'string' || b['ct'].length === 0) return 'ct must be base64'
  let decoded: Buffer
  try {
    decoded = Buffer.from(b['ct'], 'base64')
  } catch {
    return 'ct must be base64'
  }
  if (decoded.length === 0) return 'ct must be base64'
  if (decoded.length > MAX_CT_BYTES) return 'ct too large'
  const deadline = b['deadline_s']
  if (typeof deadline !== 'number' || !Number.isInteger(deadline)) {
    return 'deadline_s must be an integer'
  }
  if (deadline < 60 || deadline > 86_400) return 'deadline_s must be 60..86400'
  if (b['auth'] !== undefined) {
    if (typeof b['auth'] !== 'string' || b['auth'].length > MAX_AUTH_CHARS) {
      return 'auth must be a short string'
    }
  }
  return null
}

export interface DeadmanOptions {
  /** Where the rows live. Empty string disables persistence (tests). */
  path: string
  now?: () => number
  /** Injected for tests; global fetch in production. */
  post?: (
    endpoint: string,
    body: Uint8Array,
    headers: Record<string, string>
  ) => Promise<{ status: number }>
  /** Counts only, like every relay log line. */
  log?: (line: string) => void
}

export class Deadman {
  #rows = new Map<string, DeadmanRow>()
  /** Ids held by at least one live socket. Memory only, by design. */
  #claims = new Map<string, number>()
  #armed = new Map<string, Armed>()
  #opts: Required<DeadmanOptions>

  constructor(opts: DeadmanOptions) {
    this.#opts = {
      path: opts.path,
      now: opts.now ?? (() => Date.now()),
      post: opts.post ?? httpPost,
      log: opts.log ?? (() => {}),
    }
    this.#load()

    // Rows that outlived a restart have no claims and no known drop time.
    // The honest reading is "the box may be gone since before we started":
    // arm each row with a fresh full deadline, so a healthy box has every
    // chance to reconnect first and a dead one still gets its message out.
    const now = this.#opts.now()
    for (const row of this.#rows.values()) {
      this.#armed.set(row.id, { fireAtMs: now + row.deadlineS * 1000 })
    }
  }

  /** Upsert from a validated POST /deadman body. */
  put(body: Record<string, unknown>): void {
    const row: DeadmanRow = {
      id: body['id'] as string,
      endpoint: body['endpoint'] as string,
      ct: body['ct'] as string,
      deadlineS: body['deadline_s'] as number,
      ...(typeof body['auth'] === 'string' ? { auth: body['auth'] } : {}),
    }
    const prior = this.#rows.get(row.id)
    if (prior?.lastFiredAtMs !== undefined) row.lastFiredAtMs = prior.lastFiredAtMs
    this.#rows.set(row.id, row)
    // A fresh row from a live box replaces any restart-armed countdown;
    // if no socket claims it, the countdown restarts from now.
    if ((this.#claims.get(row.id) ?? 0) > 0) this.#armed.delete(row.id)
    else this.#armed.set(row.id, { fireAtMs: this.#opts.now() + row.deadlineS * 1000 })
    this.#save()
  }

  /** DELETE /deadman/{id}. Idempotent. */
  remove(id: string): void {
    this.#rows.delete(id)
    this.#armed.delete(id)
    this.#save()
  }

  /** A live socket spoke for this id. Unknown ids are remembered anyway —
   *  the row's POST may still be in flight beside the socket. */
  claim(id: string): void {
    this.#claims.set(id, (this.#claims.get(id) ?? 0) + 1)
    this.#armed.delete(id)
  }

  /** The claiming socket went away. The countdown starts here. */
  release(id: string): void {
    const n = (this.#claims.get(id) ?? 0) - 1
    if (n > 0) {
      this.#claims.set(id, n)
      return
    }
    this.#claims.delete(id)
    const row = this.#rows.get(id)
    if (row) this.#armed.set(id, { fireAtMs: this.#opts.now() + row.deadlineS * 1000 })
  }

  /** Driven by the relay's one timer. Fires whatever is due. */
  beat(): void {
    const now = this.#opts.now()
    for (const [id, armed] of this.#armed) {
      if (armed.fireAtMs > now) continue
      this.#armed.delete(id)
      const row = this.#rows.get(id)
      if (!row) continue
      if (row.lastFiredAtMs !== undefined && now - row.lastFiredAtMs < REFIRE_FLOOR_MS) {
        // A box that flaps every few minutes is one outage, not many.
        continue
      }
      row.lastFiredAtMs = now
      this.#save()
      void this.#fire(row)
    }
  }

  /** Counts only: the audit surface must show state exists, never whose. */
  inspect(): { rows: number; claimed: number; armed: number } {
    return { rows: this.#rows.size, claimed: this.#claims.size, armed: this.#armed.size }
  }

  async #fire(row: DeadmanRow): Promise<void> {
    const headers: Record<string, string> = {
      TTL: '86400',
      'Content-Encoding': 'aes128gcm',
      'Content-Type': 'application/octet-stream',
      Urgency: 'high',
      ...(row.auth ? { Authorization: row.auth } : {}),
    }
    try {
      const res = await this.#opts.post(row.endpoint, Buffer.from(row.ct, 'base64'), headers)
      // Status only. The endpoint names a push service and a token — the
      // household identifier class this service never writes down.
      this.#opts.log(`relay: deadman fired status=${res.status}`)
      if (res.status === 404 || res.status === 410) {
        // The subscription is gone; the row is now a message to nobody.
        this.#rows.delete(row.id)
        this.#save()
      }
    } catch {
      this.#opts.log('relay: deadman fire failed')
    }
  }

  #load(): void {
    if (!this.#opts.path) return
    try {
      const parsed = JSON.parse(readFileSync(this.#opts.path, 'utf8')) as DeadmanRow[]
      for (const row of parsed) {
        if (typeof row?.id === 'string' && ID_RE.test(row.id)) this.#rows.set(row.id, row)
      }
    } catch {
      // No file yet, or an unreadable one: start empty. The boxes re-POST
      // their rows on every connect, so the state heals itself.
    }
  }

  #save(): void {
    if (!this.#opts.path) return
    try {
      mkdirSync(dirname(this.#opts.path), { recursive: true })
      const tmp = `${this.#opts.path}.tmp`
      writeFileSync(tmp, JSON.stringify([...this.#rows.values()]))
      renameSync(tmp, this.#opts.path)
    } catch {
      this.#opts.log('relay: deadman save failed')
    }
  }
}

async function httpPost(
  endpoint: string,
  body: Uint8Array,
  headers: Record<string, string>
): Promise<{ status: number }> {
  const res = await fetch(endpoint, { method: 'POST', headers, body: body as BodyInit })
  return { status: res.status }
}
