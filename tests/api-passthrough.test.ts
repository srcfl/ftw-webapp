/* The box's own API, over the session, end to end against the simulator.
 *
 * The app could ask its box six things; the box's own page could ask it 132,
 * with no authentication at all, on the home LAN. Reaching the same handlers
 * through a Noise session pinned to an enrolled device is strictly stronger
 * than what households run today — so this is a security improvement, and
 * every gate below is the part that makes that sentence true rather than
 * hopeful.
 *
 * Real everywhere: a Session, a SimBox, the loopback carrier. Nothing here
 * asserts on a stub agreeing with itself.
 */

import { describe, it, expect, vi, afterEach } from 'vitest'
import { Session, ApiError, API_TIMEOUT_MS, HIST_TIMEOUT_MS } from '$lib/protocol/session'
import { LoopbackCarrier } from '$lib/carrier/loopback'
import { CarrierBase, type Carrier, type CarrierStatus } from '$lib/carrier/carrier'
import { encodeFrame, decodeFrame, LANE_BULK, type Envelope } from '$lib/protocol/frame'
import { SimBox } from '$lib/sim/box'
import { ROLE_OWNER, ROLE_VIEWER, OP_SET_MODE, API_CHUNK_BYTES } from '$lib/protocol/messages'

/** Fixed, so the simulated house has the same days behind it every run. */
const NOON = new Date(2026, 6, 15, 12, 0, 0).getTime()

function connect(box: SimBox) {
  const session = new Session({ build: 'test' })
  session.connect(new LoopbackCarrier(box, { latencyMs: 0 }))
  return session
}

async function settle(times = 40) {
  for (let i = 0; i < times; i++) await new Promise((r) => setTimeout(r, 2))
}

function decode(bytes: Uint8Array): unknown {
  return JSON.parse(new TextDecoder().decode(bytes))
}

describe('reading through the passthrough', () => {
  it('carries a whole answer, with the status the handler gave', async () => {
    const box = new SimBox({ now: () => NOON })
    const session = connect(box)
    await settle()

    const res = await session.api({
      method: 'GET',
      path: '/api/energy/daily',
      query: { days: '7' },
    })

    expect(res.status).toBe(200)
    const body = decode(res.body) as { days: { day: string; load_wh: number }[] }
    expect(body.days).toHaveLength(7)
    expect(body.days.at(-1)!.day).toBe('2026-07-15')
  })

  it('reassembles an answer that needs several chunks, in order', async () => {
    const box = new SimBox({ now: () => NOON })
    const session = connect(box)
    await settle()

    const res = await session.api({
      method: 'GET',
      path: '/api/energy/daily',
      query: { days: '90' },
    })

    // The point of the assertion is that this is more than one chunk. A body
    // that fits in one proves nothing about assembling several, and a chunk
    // dropped or reordered would leave JSON that does not parse.
    expect(res.body.length).toBeGreaterThan(API_CHUNK_BYTES)
    const body = decode(res.body) as { days: unknown[] }
    expect(body.days).toHaveLength(90)
  })

  it('names a header the way the box names it', async () => {
    // The box carries three headers and no more — Content-Type, ETag,
    // Last-Modified — under Go's canonical spelling, because a header the app
    // has no use for is a fact about the box's LAN with nowhere to go. The
    // simulator lower-cased them, so a caller reading res.headers would find
    // its answer here and nothing at all against a real box.
    const box = new SimBox({ now: () => NOON })
    const session = connect(box)
    await settle()

    const res = await session.api({ method: 'GET', path: '/api/energy/daily' })
    expect(Object.keys(res.headers)).toContain('Content-Type')
    expect(res.headers['Content-Type']).toMatch(/^application\/json/)
  })

  it('hands a 404 up as an answer, not as a failure', async () => {
    // The rule the app branches on, and it needs no body inspection: a status
    // arrived, so a handler ran and the status IS the answer. What a 404 means
    // belongs to whoever asked, not to this layer.
    //
    // The route is a real one that answers 404 for a phone it has never heard
    // of, because that is the only 404 a box can produce through this session:
    // a path no route claims never reaches a handler at all. This test asked
    // for /api/nothing/here for a release and proved the opposite of what it
    // said — the simulator answered 404 where a box refuses.
    const box = new SimBox({ now: () => NOON, role: ROLE_OWNER })
    const session = connect(box)
    await settle()

    const res = await session.api({
      method: 'DELETE',
      path: '/api/app-link/devices/nosuchphone',
      stepUp: true,
    })
    expect(res.status).toBe(404)
  })
})

/**
 * The tier is a fact about the route, never about the verb.
 *
 * The method decided this once, and it was wrong twice in the same review: a
 * GET that hands out a CalDAV password, which is a write channel into
 * dispatch, and a POST that drives every battery through ±3000 W for minutes.
 * Both read as ordinary from their verb alone; neither is. The box prices each
 * route beside its handler, and this simulator carries the same prices — a
 * peer that shared the app's old reading would pass every test here and refuse
 * a household's request on a real box.
 */
describe('what a route costs', () => {
  /** Owner with a ceremony behind them: everything a session can offer. */
  function fullyPrivileged() {
    const box = new SimBox({ now: () => NOON, role: ROLE_OWNER })
    return { box, session: connect(box) }
  }

  it('refuses a credential served behind a GET', async () => {
    const { session } = fullyPrivileged()
    await settle()

    // Local, not read. The answer carries a password that is a write channel
    // into dispatch, and no role and no ceremony changes that.
    await expect(
      session.api({ method: 'GET', path: '/api/caldav/credentials', stepUp: true })
    ).rejects.toMatchObject({ detail: { code: 'E_LOCAL_ONLY' } })
  })

  it('refuses a GET that sweeps the home network until a ceremony has run', async () => {
    const { session } = fullyPrivileged()
    await settle()

    await expect(session.api({ method: 'GET', path: '/api/scan' })).rejects.toMatchObject({
      detail: { code: 'E_NEEDS_STEP_UP', args: { tier: 'configure' } },
    })
  })

  it('refuses a POST that drives every battery, ceremony or not', async () => {
    const { session } = fullyPrivileged()
    await settle()

    // Actuation has one door and this is not it. No `op`: the box has no
    // command for a self-tune, and an app that assumed one was always named
    // would draw a button leading nowhere.
    const err = await session
      .api({ method: 'POST', path: '/api/self_tune/start', stepUp: true })
      .then(() => null)
      .catch((e: unknown) => e as ApiError)

    expect(err?.detail.code).toBe('E_USE_CMD')
    expect(err?.detail.args).not.toHaveProperty('op')
  })

  it('names the command when the box has one', async () => {
    const { session } = fullyPrivileged()
    await settle()

    await expect(
      session.api({ method: 'POST', path: '/api/mode', stepUp: true })
    ).rejects.toMatchObject({ detail: { code: 'E_USE_CMD', args: { op: OP_SET_MODE } } })
  })

  it('refuses a body that replaces a whole document, even for an owner who stepped up', async () => {
    const { session } = fullyPrivileged()
    await settle()

    // On the LAN the browser had just loaded that document from this box. A
    // phone on a relay, possibly a year behind it, has no such guarantee, so
    // every field it never heard of would be dropped.
    await expect(
      session.api({
        method: 'POST',
        path: '/api/config',
        body: new TextEncoder().encode('{}'),
        stepUp: true,
      })
    ).rejects.toMatchObject({ detail: { code: 'E_WHOLE_DOCUMENT' } })
  })

  it('refuses a path no route on the box claims, rather than answering it', async () => {
    const { session } = fullyPrivileged()
    await settle()

    // A path under /api/ that no handler claims falls through to the box's own
    // file server, and the session does not carry that. Closed by default is
    // the whole cost of pricing routes one at a time: a route nobody has
    // priced is refused, never served.
    await expect(
      session.api({ method: 'GET', path: '/api/a/view/from/next/year', stepUp: true })
    ).rejects.toMatchObject({
      detail: { code: 'E_UNKNOWN_OP', args: { field: 'path' } },
    })
  })

  it('refuses a method the route was never registered for', async () => {
    const { session } = fullyPrivileged()
    await settle()

    // Same refusal and the same reason: the box's router matches method and
    // path together, so DELETE on a route registered for POST claims no
    // pattern and lands on the file server with everything else.
    await expect(
      session.api({ method: 'DELETE', path: '/api/mode', stepUp: true })
    ).rejects.toMatchObject({ detail: { code: 'E_UNKNOWN_OP' } })
  })
})

describe('what the passthrough will not carry', () => {
  it('refuses a path outside /api/, so the box never serves HTML here', async () => {
    // The box is never an origin. Serving its own page through this session
    // would make it a second origin under another name, which is the thing
    // docs/architecture.md rejects outright.
    const box = new SimBox({ now: () => NOON })
    const session = connect(box)
    await settle()

    await expect(session.api({ method: 'GET', path: '/index.html' })).rejects.toMatchObject({
      name: 'ApiError',
      detail: { code: 'E_UNKNOWN_OP', args: { field: 'path' } },
    })
  })

  it('refuses a traversal and a smuggled query string', async () => {
    const box = new SimBox({ now: () => NOON })
    const session = connect(box)
    await settle()

    for (const path of ['/api/../etc/passwd', '/api/energy/daily?days=1', '/api//energy']) {
      await expect(session.api({ method: 'GET', path })).rejects.toBeInstanceOf(ApiError)
    }
  })

  it('refuses an archive by its media type, before a byte streams', async () => {
    const box = new SimBox({ now: () => NOON })
    const session = connect(box)
    await settle()

    // Refused by class rather than by a list of paths, so a route added next
    // year that streams a ZIP meets this without anyone remembering it.
    //
    // The route is the box's one read that answers with an archive. This test
    // used to ask for /api/support/dump, which the box prices local — so it
    // never reaches a handler there and the class rule went unproven.
    await expect(
      session.api({ method: 'GET', path: '/api/research/load/dump' })
    ).rejects.toMatchObject({
      detail: { code: 'E_UNSUPPORTED_MEDIA', args: { contentType: 'application/gzip' } },
    })
  })

  it('refuses a route that is local by nature before any of that', async () => {
    const box = new SimBox({ now: () => NOON })
    const session = connect(box)
    await settle()

    // /api/support/dump is both: an archive AND a route that needs somebody at
    // the box. The tier is the one that answers, because it is decided before
    // a handler runs.
    await expect(session.api({ method: 'GET', path: '/api/support/dump' })).rejects.toMatchObject({
      detail: { code: 'E_LOCAL_ONLY' },
    })
  })

  it('treats a cut-off answer as a failure, never as a short one', async () => {
    const box = new SimBox({ now: () => NOON })
    const session = connect(box)
    await settle()

    // Half a JSON document is wrong in a way no caller above can see.
    await expect(
      session.api({ method: 'GET', path: '/api/energy/daily', query: { days: '30' }, maxBytes: 64 })
    ).rejects.toMatchObject({ detail: { code: 'E_RESPONSE_TOO_LARGE' } })
  })
})

describe('actuation has exactly one door', () => {
  it('refuses an actuating route and names the command to use instead', async () => {
    // An HTTP request has no expiry, and a request with no expiry must never
    // move energy. The app carries no list of which routes those are — it
    // finds out by being refused, which is what makes a route that gains an
    // actuating side effect later fail loudly rather than quietly dispatch.
    const box = new SimBox({ now: () => NOON })
    const session = connect(box)
    await settle()

    await expect(
      session.api({ method: 'POST', path: '/api/mode', body: new TextEncoder().encode('{}') })
    ).rejects.toMatchObject({ detail: { code: 'E_USE_CMD', args: { op: OP_SET_MODE } } })
  })

  it('refuses it for an owner who has just proved themselves, too', async () => {
    const box = new SimBox({ now: () => NOON, role: ROLE_OWNER })
    const session = connect(box)
    await settle()

    await expect(
      session.api({ method: 'POST', path: '/api/mode', stepUp: true })
    ).rejects.toMatchObject({ detail: { code: 'E_USE_CMD' } })
  })
})

describe('a viewer', () => {
  it('cannot change the mode by either door, and the mode does not move', async () => {
    // The assertion that matters is the last one. Checking only the returned
    // error would pass just as well against a box that refused politely and
    // changed the mode anyway, and this project has already lost rounds to
    // exactly that.
    const box = new SimBox({ now: () => NOON, role: ROLE_VIEWER })
    const session = connect(box)
    await settle()

    const before = box.mode

    const viaCmd = await session.command(OP_SET_MODE, { mode: 'charge' }).promise
    const viaApi = await session
      .api({ method: 'POST', path: '/api/mode', stepUp: true })
      .then(() => null)
      .catch((err: unknown) => err)

    // The effect first, and on purpose. A refusal that changed the mode
    // anyway would pass an assertion about the error and fail this one, so
    // this one goes where nothing can abort before it.
    expect(box.mode, 'the mode moved for a viewer').toBe(before)

    expect(viaCmd.state).toBe('rejected')
    expect(viaCmd.error?.code).toBe('E_SCOPE_DENIED')
    expect(viaApi).toBeInstanceOf(ApiError)
  })

  it('is refused configuration with the role it would need', async () => {
    const box = new SimBox({ now: () => NOON, role: ROLE_VIEWER })
    const session = connect(box)
    await settle()

    await expect(
      session.api({ method: 'POST', path: '/api/app-link/pairing', stepUp: true })
    ).rejects.toMatchObject({ detail: { code: 'E_SCOPE_DENIED', args: { needRole: ROLE_OWNER } } })
  })

  it('still reads everything a viewer is meant to see', async () => {
    const box = new SimBox({ now: () => NOON, role: ROLE_VIEWER })
    const session = connect(box)
    await settle()

    const res = await session.api({ method: 'GET', path: '/api/energy/daily' })
    expect(res.status).toBe(200)
  })
})

describe('configuration', () => {
  it('is refused until a ceremony has happened, then goes through', async () => {
    const box = new SimBox({ now: () => NOON, role: ROLE_OWNER })
    const session = connect(box)
    await settle()

    // In the body, which is where the box reads a role. It was in the query
    // string here for a release, and the box does not look there — so this
    // test proved the ceremony and, silently, nothing about the role.
    const asking = new TextEncoder().encode(JSON.stringify({ role: ROLE_VIEWER }))

    await expect(
      session.api({ method: 'POST', path: '/api/app-link/pairing', body: asking })
    ).rejects.toMatchObject({ detail: { code: 'E_NEEDS_STEP_UP', args: { tier: 'configure' } } })

    const res = await session.api({
      method: 'POST',
      path: '/api/app-link/pairing',
      body: asking,
      stepUp: true,
    })
    expect(res.status).toBe(200)
    expect((decode(res.body) as { role: string }).role).toBe(ROLE_VIEWER)
  })

  it('can skip the ceremony only when a simulator opts in for the public demo', async () => {
    const box = new SimBox({
      now: () => NOON,
      role: ROLE_OWNER,
      requireApiStepUp: false,
    })
    const session = connect(box)
    await settle()

    const asking = new TextEncoder().encode(JSON.stringify({ role: ROLE_VIEWER }))
    const res = await session.api({
      method: 'POST',
      path: '/api/app-link/pairing',
      body: asking,
    })

    expect(res.status).toBe(200)
    expect((decode(res.body) as { role: string }).role).toBe(ROLE_VIEWER)
  })

  it('will not mint a code to be read aloud, however privileged the caller', async () => {
    // A code somebody reads down a phone line is forty bits, and what makes
    // forty bits safe is that every minting costs a walk to the box: five
    // wrong guesses burn it, and asking for another needs a person in the
    // room. A code mintable from anywhere in the world takes that argument
    // away, so the box refuses this over a session and mints it only at home.
    //
    // It buys nothing either: a typed code carries the pairing code alone —
    // not the box's static key, not the rendezvous secret — so it re-admits a
    // phone that already holds those and cannot let a guest's phone in.
    //
    // This app never asks for one. The simulator answered it anyway, which is
    // exactly how a screen gets built against a box that would say no.
    const box = new SimBox({ now: () => NOON, role: ROLE_OWNER })
    const session = connect(box)
    await settle()

    const res = await session.api({
      method: 'POST',
      path: '/api/app-link/pairing',
      body: new TextEncoder().encode(JSON.stringify({ role: ROLE_VIEWER, kind: 'spoken' })),
      stepUp: true,
    })
    expect(res.status).toBe(403)
  })

  it('does not stand in front of a read', async () => {
    // A read costs nothing but a round trip: no role, no ceremony. What makes
    // a route a read is the box having priced it one, beside its handler —
    // NOT its verb. This comment claimed the verb decided it, which is the
    // rule the box abandoned after `GET /api/caldav/credentials` and
    // `GET /api/scan` both read as ordinary from theirs.
    const box = new SimBox({ now: () => NOON, role: ROLE_OWNER })
    const session = connect(box)
    await settle()

    const res = await session.api({ method: 'GET', path: '/api/app-link/devices' })
    expect(res.status).toBe(200)
  })
})

describe('a request that cannot finish', () => {
  it('answers two views asking at once, never letting one meet "busy"', async () => {
    // The box serves one call at a time and refuses a second in flight with
    // E_UNAVAILABLE — that refusal is real and still in the simulator, and it
    // costs whichever view loses the race a thirty-second backoff over a
    // collision no view can see. So the session queues instead of racing, and
    // two stores asking together is ordinary, not an error.
    const box = new SimBox({ now: () => NOON })
    const session = connect(box)
    await settle()

    const first = session.api({ method: 'GET', path: '/api/energy/daily', query: { days: '30' } })
    const second = session.api({ method: 'GET', path: '/api/app-link/devices' })

    const [a, b] = await Promise.all([first, second])
    expect(a.status).toBe(200)
    expect(b.status).toBe(200)
  })

  it('lets a refused call hand the wire to the one queued behind it', async () => {
    // Chained on settle, not success: a queue a failure could jam would turn
    // one refusal into every call the app makes after it.
    const box = new SimBox({ now: () => NOON, role: ROLE_OWNER })
    const session = connect(box)
    await settle()

    const refused = session.api({ method: 'GET', path: '/api/caldav/credentials', stepUp: true })
    const after = session.api({ method: 'GET', path: '/api/energy/daily' })

    await expect(refused).rejects.toMatchObject({ detail: { code: 'E_LOCAL_ONLY' } })
    expect((await after).status).toBe(200)
  })

  it('settles when the carrier goes away, rather than waiting out its deadline', async () => {
    // There is no reload button in this app. A promise left hanging is a view
    // that waits until the tab is closed.
    const box = new SimBox({ now: () => NOON })
    const session = new Session({ build: 'test' })
    const carrier = new LoopbackCarrier(box, { latencyMs: 20 })
    session.connect(carrier)
    await settle()

    const inFlight = session.api({ method: 'GET', path: '/api/energy/daily' })
    carrier.drop('wire died')

    await expect(inFlight).rejects.toThrow(/carrier closed/)
  })

  it('is answered 503 while the box is still starting, not refused', async () => {
    // The API is bound after the session is, so a phone that connects during
    // those seconds meets a handler that says the box is starting. It is an
    // answer, not a refusal: E_BOOTING belongs to the stream and the plan,
    // which the box genuinely cannot serve yet, and a simulator that sent it
    // here taught the app to expect a code no box sends on this path.
    const box = new SimBox({ now: () => NOON, faults: { booting: true } })
    const session = connect(box)
    await settle()

    const res = await session.api({ method: 'GET', path: '/api/energy/daily' })
    expect(res.status).toBe(503)
  })
})

/**
 * A wire under the test's own hand.
 *
 * The simulator cannot send a broken stream — it is a box behaving correctly,
 * which is what it is for. What a lost or reordered chunk does to the app is
 * the app's own rule and needs frames nobody would send on purpose.
 */
class ManualCarrier extends CarrierBase implements Carrier {
  readonly kind = 'relay' as const
  readonly rttMs = null
  readonly status: CarrierStatus = { phase: 'open', sinceMs: 0 }
  readonly sent: Envelope[] = []

  send(frame: Uint8Array): void {
    this.sent.push(decodeFrame(frame).envelope)
  }

  close(): void {}

  deliver(envelope: Envelope): void {
    this.emitFrame(encodeFrame({ lane: LANE_BULK, flags: 0, envelope }, 16384))
  }
}

describe('a body that did not all arrive', () => {
  it('is refused rather than handed up as an answer', async () => {
    const carrier = new ManualCarrier()
    const session = new Session({ build: 'test' })
    session.connect(carrier)

    const call = session.api({ method: 'GET', path: '/api/energy/daily' })
    // The queue dispatches on a microtask; let the request reach the wire
    // before reading it back off.
    await Promise.resolve()
    const req = carrier.sent.find((e) => e.t === 'api.req')!
    const id = req.id!

    carrier.deliver({ t: 'api.head', id, b: { status: 200, headers: {}, len: null } })
    carrier.deliver({ t: 'api.chunk', id, b: { seq: 0, data: new Uint8Array([123, 34]) } })
    // Chunk 1 never arrives. JSON built from 0 and 2 would usually fail to
    // parse and occasionally would not, and the second half is the worse one.
    carrier.deliver({ t: 'api.chunk', id, b: { seq: 2, data: new Uint8Array([125]) } })

    await expect(call).rejects.toThrow(/out of order/)
  })
})

/**
 * The deadline measures silence, not total time.
 *
 * A multi-megabyte answer is hundreds of chunks over a relay, and a deadline
 * armed once at dispatch kills it mid-flow while the box keeps streaming into
 * an id nobody holds any more. What the deadline exists for is a wire that
 * has gone quiet — so every sign of life pushes it back, and only silence
 * spends it.
 */
describe('an answer that is large rather than lost', () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  /** Records how a promise settles without ever waiting on it. */
  function watch<T>(promise: Promise<T>): () => string {
    let outcome = 'still waiting'
    void promise.then(
      () => (outcome = 'answered'),
      (err: Error) => (outcome = err.message)
    )
    return () => outcome
  }

  it('completes however long the whole takes, while chunks keep arriving', async () => {
    vi.useFakeTimers()
    const carrier = new ManualCarrier()
    const session = new Session({ build: 'test' })
    session.connect(carrier)

    const call = session.api({ method: 'GET', path: '/api/energy/daily' })
    const outcome = watch(call)
    await vi.advanceTimersByTimeAsync(0)
    const id = carrier.sent.find((e) => e.t === 'api.req')!.id!

    carrier.deliver({ t: 'api.head', id, b: { status: 200, headers: {}, len: null } })

    // Two-thirds of the deadline between chunks, several times the deadline
    // in total: slower than a deadline measuring the whole, faster than one
    // measuring each gap.
    const gap = Math.floor((API_TIMEOUT_MS * 2) / 3)
    for (let seq = 0; seq < 5; seq++) {
      await vi.advanceTimersByTimeAsync(gap)
      carrier.deliver({ t: 'api.chunk', id, b: { seq, data: new Uint8Array([48 + seq]) } })
    }
    carrier.deliver({ t: 'api.end', id, b: { bytes: 5, truncated: false } })
    await vi.advanceTimersByTimeAsync(0)

    expect(outcome()).toBe('answered')
    expect((await call).body.length).toBe(5)
  })

  it('still expires on total silence, even after signs of life', async () => {
    vi.useFakeTimers()
    const carrier = new ManualCarrier()
    const session = new Session({ build: 'test' })
    session.connect(carrier)

    const outcome = watch(session.api({ method: 'GET', path: '/api/energy/daily' }))
    await vi.advanceTimersByTimeAsync(0)
    const id = carrier.sent.find((e) => e.t === 'api.req')!.id!

    // Progress first, so what expires below is quiet-after-progress and not
    // a request nothing ever answered.
    carrier.deliver({ t: 'api.head', id, b: { status: 200, headers: {}, len: null } })
    carrier.deliver({ t: 'api.chunk', id, b: { seq: 0, data: new Uint8Array([48]) } })

    await vi.advanceTimersByTimeAsync(API_TIMEOUT_MS + 1)
    expect(outcome()).toBe('api request timed out')
  })

  it('gives a history window the same patience', async () => {
    vi.useFakeTimers()
    const carrier = new ManualCarrier()
    const session = new Session({ build: 'test' })
    session.connect(carrier)

    let chunks = 0
    const call = session.history(
      { series: ['grid_w'], res: '1h', fromMs: 0, toMs: 4 * 3_600_000 },
      () => {
        chunks += 1
      }
    )
    const outcome = watch(call)
    const id = carrier.sent.find((e) => e.t === 'hist.query')!.id!

    const gap = Math.floor((HIST_TIMEOUT_MS * 2) / 3)
    for (let i = 0; i < 4; i++) {
      await vi.advanceTimersByTimeAsync(gap)
      carrier.deliver({
        t: 'hist.chunk',
        id,
        b: {
          tileId: `t${i}`,
          etag: 'e',
          res: '1h',
          startMs: i * 3_600_000,
          stepMs: 3_600_000,
          series: ['grid_w'],
          data: new Uint8Array(4),
          partial: false,
        },
      })
    }
    carrier.deliver({ t: 'hist.end', id, b: { resActual: '1h', gaps: [] } })
    await vi.advanceTimersByTimeAsync(0)

    expect(outcome()).toBe('answered')
    expect(chunks).toBe(4)
  })
})

describe('a request carrying a body', () => {
  it('reaches the box whole, however the caller encoded it', async () => {
    // A typed array from another realm is written as a list of numbers rather
    // than a byte string — seven times the size — and the frame silently
    // overruns its bucket. Eight kilobytes fits as bytes and does not fit as
    // numbers, which is what makes this ask the question.
    const box = new SimBox({ now: () => NOON })
    const session = connect(box)
    await settle()

    const res = await session.api({
      method: 'POST',
      path: '/api/app-link/pairing',
      // Eight kilobytes that the handler on the other end will also accept,
      // so a 200 here means the bytes arrived AND meant what they said. A
      // body the box refuses would answer 400 for a reason that has nothing
      // to do with encoding, which is the question this asks.
      body: new TextEncoder().encode(
        JSON.stringify({ role: ROLE_VIEWER, pad: 'x'.repeat(8 * 1024) })
      ),
      stepUp: true,
    })

    expect(res.status).toBe(200)
  })

  it('refuses a body too large for the biggest bucket, and moves on', async () => {
    // The refusal is a rejection like any other — nothing registered,
    // nothing armed, and the wire is not jammed behind it.
    const box = new SimBox({ now: () => NOON })
    const session = connect(box)
    await settle()

    await expect(
      session.api({
        method: 'POST',
        path: '/api/app-link/pairing',
        body: new Uint8Array(20 * 1024),
        stepUp: true,
      })
    ).rejects.toThrow(/bucket/)

    const after = await session.api({ method: 'GET', path: '/api/energy/daily' })
    expect(after.status).toBe(200)
  })
})

describe('what the handshake says about this enrolment', () => {
  it('carries the role, so the app knows what to draw', async () => {
    const box = new SimBox({ now: () => NOON, role: ROLE_VIEWER })
    const session = connect(box)
    await settle()

    expect(session.state.role).toBe(ROLE_VIEWER)
    expect(session.state.caps.has('api.passthrough')).toBe(true)
  })

  it('treats a box that says nothing about roles as an owner', async () => {
    // A box updating from a version with no roles must not silently demote
    // every paired phone, and neither must an app meeting one.
    const session = new Session({ build: 'test' })
    expect(session.state.role).toBe(ROLE_OWNER)
  })
})
