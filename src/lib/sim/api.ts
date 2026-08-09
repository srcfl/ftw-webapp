/* The box's own HTTP API, as the simulator serves it.
 *
 * A peer, not a mock. It carries the box's own prices for the routes it knows,
 * refuses in the box's order, and answers with the same JSON the box's
 * handlers produce — so a test passing against this means the app can talk to
 * a box, not that a stub agreed with itself.
 *
 * THE ROUTE TABLE BELOW BELONGS TO THE BOX AND MUST NEVER BE COPIED INTO THE
 * APP. The app carries no list of tiers: it asks, is refused, and acts on the
 * refusal. That is what makes a route which gains an actuating side effect
 * next year fail loudly here instead of quietly dispatching a stale order.
 *
 * It is a mirror of `api.routes` in srcfl/ftw, not the whole of it — the box
 * prices 132 routes and this serves the handful the app calls, plus the ones
 * that make each tier's refusal provable. A route missing from this table is
 * refused exactly as an unpriced route is on the box, so adding a call to the
 * app means adding its line here: the same one-line cost the box pays, in the
 * same wrong-safe direction.
 *
 * The tier used to be read off the METHOD here, because that is what the app's
 * own protocol note said the box did. It is not. The box decides per route,
 * beside the handler, and it settled that after the method rule was wrong
 * twice in one review: GET /api/caldav/credentials hands out a password that
 * is a write channel into dispatch, and POST /api/self_tune/start drives every
 * battery in the house through ±3000 W for minutes. A verb knows neither. A
 * simulator that shared the app's misreading is worse than no simulator: every
 * test here passed while a real box refused what the app had drawn.
 */

import { DAY_ANCHOR_PERMILLE, sample, stepSoc, type HouseConfig } from './energy'
import { OP_SET_MODE, ROLE_OWNER, ROLE_VIEWER, type Role } from '$lib/protocol/messages'
import { roleHasScope } from '$lib/protocol/contract'
import { wireBytes } from '$lib/protocol/frame'
import { buildEnrollmentUrl } from '$lib/identity/enrollment'

/**
 * How much a route costs before it runs. Four, not three.
 *
 * read      answers a question, changes nothing, and hands back nothing that
 *           could be replayed as authority. A shared viewer may ask for it.
 * configure changes a setting. Owner, with a step-up. A late execution is the
 *           same instruction, only later.
 * actuate   moves energy, or takes control of what is moving it. Refused
 *           through the passthrough for everybody: an HTTP request carries no
 *           expiry, and a request with no expiry must not move energy.
 * local     served only on the box's own page, at home. Its answer holds a
 *           credential or a whole file, or doing it needs somebody standing at
 *           the box. Not a permission an owner is missing, which is why it is
 *           a tier and not a role check.
 */
export type ApiTier = 'read' | 'configure' | 'actuate' | 'local'

/** What the box knows about a route before it runs it. */
export interface RouteFacts {
  tier: ApiTier
  /**
   * The command that does this instead, when one exists. Absent means the box
   * has no command for it yet, and the honest reading of an absent op is that
   * the control is not available over the session at all.
   */
  cmdOp?: string
  /**
   * The body replaces a whole document rather than editing part of one, so a
   * sender working from an older idea of it drops every field it never knew.
   */
  replacesAll?: boolean
}

/**
 * The box's prices, route by route, in the box's own words.
 *
 * `{id}` is a path parameter, matched a segment at a time exactly as the box's
 * router matches it.
 */
const ROUTES: Record<string, RouteFacts> = {
  // Reads the app makes, and one it never will.
  'GET /api/status': { tier: 'read' },
  'GET /api/energy/daily': { tier: 'read' },
  'GET /api/app-link/devices': { tier: 'read' },
  // A read that answers with a gzipped archive. Priced read because it hands
  // back nothing replayable — the session refuses it later, at the status
  // line, by what it is rather than by which path asked.
  'GET /api/research/load/dump': { tier: 'read' },

  // Settings. A late execution is the same instruction, only later.
  'POST /api/app-link/pairing': { tier: 'configure' },
  'DELETE /api/app-link/devices/{id}': { tier: 'configure' },
  'PATCH /api/app-link/devices/{id}': { tier: 'configure' },
  // Both are GETs, and neither is a read: one sweeps the home network, the
  // other goes out to the update server.
  'GET /api/scan': { tier: 'configure' },
  'GET /api/version/check': { tier: 'configure' },
  'POST /api/config': { tier: 'configure', replacesAll: true },

  // Energy, or control of what moves it.
  'POST /api/mode': { tier: 'actuate', cmdOp: OP_SET_MODE },
  'POST /api/self_tune/start': { tier: 'actuate' },
  'POST /api/battery/manual_hold': { tier: 'actuate' },
  'DELETE /api/battery/manual_hold': { tier: 'actuate' },

  // The charger. Reads are reads; everything that starts, stops or redirects
  // charging is actuation, priced exactly as the box prices it — including
  // the schedule, which today rides the target route and is therefore out of
  // reach from here. That refusal is a fact the app must meet in tests, not
  // a gap this simulator smooths over.
  'GET /api/loadpoints': { tier: 'read' },
  'GET /api/mpc/plan': { tier: 'read' },
  'GET /api/loadpoints/{id}/manual_hold': { tier: 'read' },
  'GET /api/loadpoints/{id}/battery_boost': { tier: 'read' },
  'POST /api/loadpoints/{id}/target': { tier: 'actuate' },
  'POST /api/loadpoints/{id}/soc': { tier: 'actuate' },
  'POST /api/loadpoints/{id}/force_start': { tier: 'actuate' },
  'POST /api/loadpoints/{id}/manual_hold': { tier: 'actuate' },
  'DELETE /api/loadpoints/{id}/manual_hold': { tier: 'actuate' },
  'POST /api/loadpoints/{id}/battery_boost': { tier: 'actuate' },
  'DELETE /api/loadpoints/{id}/battery_boost': { tier: 'actuate' },

  // At the box, in the house. A credential, a whole file, or a person needed
  // in the room.
  'GET /api/config': { tier: 'local' },
  'GET /api/caldav/credentials': { tier: 'local' },
  'GET /api/logs': { tier: 'local' },
  'GET /api/support/dump': { tier: 'local' },
  'GET /api/backups/{id}': { tier: 'local' },
  'GET /api/oauth/myuplink/start': { tier: 'local' },
}

/** A route the box's router claims: which pattern matched, and its price. */
export interface Matched {
  pattern: string
  facts: RouteFacts
  /** Path parameters, by the name the pattern gave them. */
  params: Record<string, string>
}

/**
 * What the box's router says about a request, or null when nothing claims it.
 *
 * Null is the box's static catch-all. Its router matches method and path
 * together, so a path no route claims AND a method a route was never
 * registered for both land on the file server that serves the box's own web
 * page — and the session does not carry that page, because the box being a
 * second origin under another name is the thing the architecture rejected.
 *
 * The gate and the handler read the same answer, deliberately. A route marked
 * actuate that a second hand-rolled matcher failed to recognise would be an
 * actuation the passthrough let through.
 */
export function matchRoute(method: string, path: string): Matched | null {
  const asked = path.split('/')

  for (const [route, facts] of Object.entries(ROUTES)) {
    const [routeMethod, routePath] = route.split(' ') as [string, string]
    if (routeMethod !== method) continue

    const pattern = routePath.split('/')
    if (pattern.length !== asked.length) continue

    const params: Record<string, string> = {}
    const hit = pattern.every((seg, i) => {
      const got = asked[i] ?? ''
      if (seg.startsWith('{') && seg.endsWith('}')) {
        if (got === '') return false
        params[seg.slice(1, -1)] = got
        return true
      }
      return seg === got
    })
    if (hit) return { pattern: route, facts, params }
  }
  return null
}

/** A refusal: no handler ran, and the app hears an `error` on the request id. */
export interface ApiRefusal {
  code: string
  args?: Record<string, unknown>
}

/** An answer: a handler ran, and the status is what it said. */
export interface ApiAnswer {
  status: number
  contentType: string
  body: Uint8Array
}

export interface SimDevice {
  id: string
  role: Role
  addedAtMs: number
  lastSeenMs: number
}

export interface SimApiOptions {
  house: HouseConfig
  now: () => number
  ceilingW: number
  /** This session's own device id, so its row can be marked. */
  deviceId?: string
}

const DAY_MS = 86_400_000

/** The box's own word for a code somebody reads aloud, and its own TTL. */
const appPairingKindSpoken = 'spoken'
const PAIRING_TTL_MS = 10 * 60_000

/** How finely a replayed day is integrated. 96 samples is a quarter-hour. */
const DAILY_STEP_MS = 15 * 60_000

const text = new TextEncoder()

function forbidden(): ApiAnswer {
  return json(403, { error: 'this phone is not allowed to see that' })
}

function json(status: number, value: unknown): ApiAnswer {
  return {
    status,
    contentType: 'application/json',
    body: wireBytes(text.encode(JSON.stringify(value))),
  }
}

export class SimApi {
  #opts: SimApiOptions
  #devices: SimDevice[]
  #pairing: { code: string; role: Role; expiresAtMs: number } | null = null

  constructor(opts: SimApiOptions) {
    this.#opts = opts
    const now = opts.now()
    this.#devices = [
      {
        id: opts.deviceId ?? 'a1b2c3d4',
        role: ROLE_OWNER,
        addedAtMs: now - 40 * DAY_MS,
        lastSeenMs: now,
      },
      {
        id: 'f7e6d5c4',
        role: ROLE_VIEWER,
        addedAtMs: now - 6 * DAY_MS,
        lastSeenMs: now - 3 * 3_600_000,
      },
    ]
  }

  get devices(): readonly SimDevice[] {
    return this.#devices
  }

  /**
   * Serve one request, or refuse it.
   *
   * The order is the box's: what the path is, then whether any route claims
   * it, then what that route costs, then who is asking, then whether the
   * ceremony happened. A handler runs only once all of it has passed, which is
   * what makes "an `error` on this id means no handler ran" true rather than
   * merely intended.
   *
   * Every tier has a branch, including read, and the default is closed. That
   * shape is the fix for how a credential once got out of the box: a gate
   * written as a chain of cases with no read branch let a route the router
   * happened to call a read meet no check at all.
   */
  serve(req: {
    method: string
    path: string
    query: Record<string, string>
    body: Uint8Array | null
    stepUp: boolean
    role: Role
    /**
     * The box is still starting. The API is bound to the session a moment
     * after the session exists, so every route answers 503 until it is.
     */
    booting?: boolean
  }): ApiRefusal | ApiAnswer {
    if (badPath(req.path)) return { code: 'E_UNKNOWN_OP', args: { t: 'api.req', field: 'path' } }

    const matched = matchRoute(req.method, req.path)
    // The box's own file server, which this session does not carry.
    if (!matched) return { code: 'E_UNKNOWN_OP', args: { t: 'api.req', field: 'path' } }

    const { tier, cmdOp, replacesAll } = matched.facts

    switch (tier) {
      case 'read':
        // Nothing to check, and that is a claim about the tier rather than an
        // absence. Anything handing back a credential is local and never
        // arrives here.
        break

      case 'configure':
        if (replacesAll) return { code: 'E_WHOLE_DOCUMENT', args: { path: req.path } }
        // The role gate comes before the ceremony gate on purpose: telling a
        // viewer to hold up their face and then refusing them anyway would be
        // asking someone to prove something that changes nothing.
        if (req.role !== ROLE_OWNER) {
          return { code: 'E_SCOPE_DENIED', args: { needRole: ROLE_OWNER, role: req.role } }
        }
        if (!req.stepUp) return { code: 'E_NEEDS_STEP_UP', args: { tier } }
        break

      case 'actuate':
        // No role check and no ceremony check above it: the tier is refused
        // for everybody, so a stronger caller would only reach the same answer
        // by a longer route. The op is named only when a command exists.
        return {
          code: 'E_USE_CMD',
          args: { path: req.path, ...(cmdOp ? { op: cmdOp } : {}) },
        }

      default:
        // Local, and anything this gate has no branch for. Neither the role
        // nor the ceremony is consulted: asking again as somebody else gets
        // the same answer.
        return { code: 'E_LOCAL_ONLY', args: { path: req.path } }
    }

    // The API is bound to the session after the session exists, so a phone
    // that connects in those seconds meets a handler saying so. An answer,
    // not a refusal — and the box's own body, because the app reads a status
    // here and nothing else.
    if (req.booting) return json(503, { error: 'the box is still starting' })

    return this.#route(req, matched)
  }

  #route(
    req: {
      method: string
      path: string
      query: Record<string, string>
      body: Uint8Array | null
      role: Role
    },
    matched: Matched
  ): ApiAnswer {
    const route = matched.pattern

    if (route === 'GET /api/energy/daily') return this.#energyDaily(req.query)
    if (route === 'GET /api/loadpoints') return this.#loadpoints()
    if (route === 'GET /api/mpc/plan') return this.#mpcPlan()

    // A real read whose answer this session cannot carry. Refused by class at
    // the status line, never by a list of paths, so a route added next year
    // that streams an archive meets it without anyone remembering.
    if (route === 'GET /api/research/load/dump') {
      return { status: 200, contentType: 'application/gzip', body: new Uint8Array(4096) }
    }

    // The members endpoints check a scope inside the handler, and this is the
    // one place the nine registry scopes still govern an HTTP path. They are
    // not stretched across 124 routes — that map is exactly the list that
    // rots — but who may see and change a household's roster is a question
    // the roster's own handler is entitled to ask.
    //
    // A refusal here is a STATUS, not an error code, because a handler ran.
    // That is the app's whole rule for telling the two apart.
    if (route === 'GET /api/app-link/devices') {
      if (!roleHasScope(req.role, 'ftw.members.read')) return forbidden()
      // The box's own field names, not this file's. `appenroll.DeviceInfo`
      // marshals snake_case, and an app built against camelCase here would
      // render "not seen yet" against every row of a real box while every
      // test in this tree passed.
      return json(200, {
        devices: this.#devices.map((d) => ({
          id: d.id,
          role: d.role,
          added_at_ms: d.addedAtMs,
          last_seen_ms: d.lastSeenMs,
        })),
      })
    }
    if (route === 'POST /api/app-link/pairing') {
      if (!roleHasScope(req.role, 'ftw.members.write')) return forbidden()
      return this.#mintPairing(req.body)
    }

    if (route === 'DELETE /api/app-link/devices/{id}') {
      if (!roleHasScope(req.role, 'ftw.members.write')) return forbidden()
      return this.#revoke(matched.params['id'] ?? '')
    }

    // A route this simulator prices but does not implement. It cannot happen
    // on a box, where a tier is written on the same line as the handler, and
    // no test should lean on it.
    return json(404, { error: 'not found' })
  }

  /**
   * The charger, from the same house the live view samples.
   *
   * Same generator, same seed, same minute — the panel's "charging at
   * 7.3 kW" and the hero's EV bubble must read as one household. The car
   * plugs in after the commute and charges 17:00–19:30, exactly the window
   * `sample` gives `evW` to, and the session meter integrates that window.
   *
   * Field names are the box's own: `loadpoint.State` marshals snake_case,
   * and an app built against camelCase here would render blanks against
   * every real box while this tree stayed green. No `current_soc_pct` on
   * purpose — an easee without a car API genuinely does not know it, and
   * the honest absence is a case the panel has to carry.
   */
  #loadpoints(): ApiAnswer {
    const now = this.#opts.now()
    const r = sample(this.#opts.house, now, 500, this.#opts.ceilingW)
    const d = new Date(now)
    const hourOfDay = d.getUTCHours() + d.getUTCMinutes() / 60

    // Plugged in from the evening commute until the morning departure.
    const pluggedIn = hourOfDay >= 17 || hourOfDay < 7

    // What the session has delivered so far: the charging window is flat
    // ~7.2 kW, so the meter is minutes-into-window times that rate.
    const windowStartMs = new Date(now).setUTCHours(17, 0, 0, 0)
    const chargedMinutes =
      hourOfDay >= 17
        ? Math.min(now - windowStartMs, 2.5 * 3_600_000) / 60_000
        : hourOfDay < 7
          ? 150
          : 0
    const sessionWh = Math.round((chargedMinutes / 60) * 7200)

    return json(200, {
      enabled: true,
      loadpoints: [
        {
          id: 'carport',
          driver_name: 'easee',
          plugged_in: pluggedIn,
          current_power_w: r.evW,
          delivered_wh_session: pluggedIn ? sessionWh : 0,
          target_soc_pct: 84,
          updated_at_ms: now,
          soc_source: 'none',
          min_charge_w: 4140,
          max_charge_w: 11000,
          phases: 3,
          voltage_v: 230,
          manual_active: false,
          battery_boost: { state: 'inactive', active: false },
          surplus_only: false,
          schedule: { soc_pct: 84, time_of_day_min_utc: 360, recurring: true },
        },
      ],
    })
  }

  /**
   * The optimiser's plan for the charger, derived from the same window.
   *
   * Quarter-hour slots over the next day, with `loadpoint_power_w` set in
   * the slots the house's own generator would charge in. The box's real
   * planner prices every slot; this one carries only what the app draws —
   * a slot missing a price is a case the store must already survive,
   * because a box mid-replan serves exactly that.
   */
  #mpcPlan(): ApiAnswer {
    const now = this.#opts.now()
    const slotMs = 15 * 60_000
    const first = Math.floor(now / slotMs) * slotMs

    const actions = []
    for (let i = 0; i < 96; i++) {
      const startMs = first + i * slotMs
      const h = new Date(startMs).getUTCHours() + new Date(startMs).getUTCMinutes() / 60
      const charging = h >= 17 && h < 19.5
      actions.push({
        slot_start_ms: startMs,
        slot_len_min: 15,
        ems_mode: charging ? 'charge' : 'idle',
        reason: charging ? 'charge from cheap grid' : 'hold',
        loadpoint_power_w: { carport: charging ? 7200 : 0 },
        loadpoint_soc_pct_by_id: {},
      })
    }

    return json(200, {
      enabled: true,
      plan: {
        generated_at_ms: now,
        horizon_slots: actions.length,
        actions,
      },
    })
  }

  /**
   * Daily energy, integrated from the same house the live view samples.
   *
   * Same generator, same seed, same minute — so the figure under "used at
   * home" for yesterday is the area under yesterday's line on the chart. A
   * separate history generator would drift, and the first person to notice
   * would be someone comparing two screens of their own home.
   *
   * Every figure is a positive magnitude in watt-hours, as the box's own
   * `DailyEnergy` produces them: import is grid above zero, export is the
   * size of grid below zero, and solar is the size of a PV reading that is
   * never positive. The wire's sign convention is right for the wire; a
   * household reads "bought" and "sold".
   */
  #energyDaily(query: Record<string, string>): ApiAnswer {
    let days = 7
    const asked = Number.parseInt(query['days'] ?? '', 10)
    if (Number.isFinite(asked) && asked > 0) days = asked
    if (days > 90) days = 90

    const nowMs = this.#opts.now()
    const todayMidnight = new Date(nowMs).setHours(0, 0, 0, 0)

    const out = []
    for (let i = days - 1; i >= 0; i--) {
      const dayStart = new Date(todayMidnight).setDate(new Date(todayMidnight).getDate() - i)
      const dayEnd = Math.min(new Date(dayStart).setDate(new Date(dayStart).getDate() + 1), nowMs)
      out.push({ day: dayKey(dayStart), ...this.#integrate(dayStart, dayEnd) })
    }

    return json(200, { days: out, tz: 'Local' })
  }

  #integrate(fromMs: number, toMs: number) {
    let importWh = 0
    let exportWh = 0
    let pvWh = 0
    let chargedWh = 0
    let dischargedWh = 0
    let loadWh = 0

    // Re-anchored at each UTC midnight, exactly as the history tiles are, and
    // replayed from that midnight so the state of charge arrives at `fromMs`
    // the same way whichever window is asked for.
    let soc = DAY_ANCHOR_PERMILLE
    let day = Math.floor(fromMs / DAY_MS)
    const hours = DAILY_STEP_MS / 3_600_000

    for (let t = day * DAY_MS; t < toMs; t += DAILY_STEP_MS) {
      const d = Math.floor(t / DAY_MS)
      if (d !== day) {
        day = d
        soc = DAY_ANCHOR_PERMILLE
      }

      const r = sample(this.#opts.house, t, soc, this.#opts.ceilingW)
      soc = stepSoc(this.#opts.house, soc, r.batteryW, DAILY_STEP_MS)
      if (t < fromMs) continue

      if (r.gridW > 0) importWh += r.gridW * hours
      else exportWh += -r.gridW * hours
      pvWh += -r.pvW * hours
      if (r.batteryW > 0) chargedWh += r.batteryW * hours
      else dischargedWh += -r.batteryW * hours
      loadWh += (r.loadW + r.evW) * hours
    }

    return {
      import_wh: importWh,
      export_wh: exportWh,
      pv_wh: pvWh,
      bat_charged_wh: chargedWh,
      bat_discharged_wh: dischargedWh,
      load_wh: loadWh,
    }
  }

  /**
   * Mint a pairing code, with the role it will stamp on whoever spends it.
   *
   * One live code at a time, which is already the box's rule: minting an
   * invite cancels a pending owner code and the reverse. The role is the
   * box's memory, never a field in the payload — a role the holder could edit
   * is not a role.
   *
   * READ FROM THE BODY, AND NEVER DEFAULTED. Both of those are the box's, and
   * this file got both wrong in the same way the app did — it read the role
   * out of the query string and fell back to owner. So the app asked for a
   * viewer in a place the box does not read, this simulator agreed, every test
   * here passed, and against a real box the same request minted an owner. A
   * peer that shares the app's misreading is worse than no peer at all.
   *
   * Over a session the box grants a viewer and nothing else; an owner is
   * admitted at the box, in the house. This is a session, so that is the only
   * role this endpoint can produce here.
   */
  #mintPairing(body: Uint8Array | null): ApiAnswer {
    const asked = jsonBody(body)
    const role = typeof asked['role'] === 'string' ? asked['role'] : ''
    if (role === '') {
      return json(400, { error: 'say which kind of access this is for' })
    }
    if (role !== ROLE_VIEWER) {
      return json(403, {
        error:
          'from the app you can let someone view this home. ' +
          'Making another owner is done on the box, at home.',
      })
    }
    // A code to read down a phone line is minted at the box and nowhere else.
    //
    // Forty bits are safe to say out loud because of what surrounds them, and
    // the load-bearing part is that every minting costs somebody a walk to the
    // box: five wrong guesses burn a code, and asking for another needs a
    // person in the room. One mintable from a phone anywhere in the world
    // takes that argument away, and buys nothing — a typed code carries the
    // pairing code alone, so it re-admits a phone that already holds the box's
    // key and cannot let a guest's phone in.
    //
    // Every request this file sees arrived over a session; there is no LAN
    // door in a simulator. So this is refused here always, exactly as the box
    // refuses it whenever the caller came in this way. It used to be minted,
    // and a spoken-code screen built against that would have met a 403 on
    // every real box with every test in this tree green.
    if (asked['kind'] === appPairingKindSpoken) {
      return json(403, { error: 'a code to read aloud is made on the box, at home.' })
    }

    this.#pairing = { code: randomHex(32), role, expiresAtMs: this.#opts.now() + PAIRING_TTL_MS }

    // Built with the app's own encoder rather than assembled from a template.
    // A payload this app's parser would reject is a payload no phone could
    // scan off the screen showing it, and the whole of what the sharing
    // screen does is put one on a screen to be scanned.
    //
    // `code` is absent, not empty: the box marks it omitempty and a QR
    // payload must never be offered as text.
    return json(200, {
      url: buildEnrollmentUrl({
        boxStaticPublic: crypto.getRandomValues(new Uint8Array(32)),
        pairingCode: crypto.getRandomValues(new Uint8Array(16)),
        rendezvousSecret: crypto.getRandomValues(new Uint8Array(32)),
        lanHint: '',
      }),
      role,
      expires_at_ms: this.#pairing.expiresAtMs,
    })
  }

  #revoke(id: string): ApiAnswer {
    const row = this.#devices.find((d) => d.id === id)
    if (!row) return json(404, { error: 'that phone is no longer paired' })

    // Refused in the enrolment layer rather than at the API, so the box's own
    // web page cannot do what the app cannot.
    //
    // Two keys, exactly as the box writes them: a sentence for the box's own
    // page, which has nobody else to write one, and a NAME for the app, which
    // owns all of its own prose. The name is the only part the app may read.
    const owners = this.#devices.filter((d) => d.role === ROLE_OWNER)
    if (row.role === ROLE_OWNER && owners.length === 1) {
      return json(409, {
        error:
          'that is the only phone that can change anything here. ' +
          'Pair another owner first, then remove this one.',
        code: 'E_LAST_OWNER_PROTECTED',
      })
    }

    this.#devices = this.#devices.filter((d) => d.id !== id)
    return json(200, { status: 'removed' })
  }
}

/**
 * Whether a path is one the passthrough will carry at all.
 *
 * Refused before anything else looks at it. A traversal or a second query
 * string is not a path the box would have routed — and a tier decided over a
 * string that can still carry a `?` is a parser bug that becomes a privilege
 * bug.
 */
export function badPath(path: string): boolean {
  if (!path.startsWith('/api/')) return true
  if (path.includes('..') || path.includes('//')) return true
  if (path.includes('?') || path.includes('#')) return true
  return false
}

/**
 * A request body, read as JSON.
 *
 * A body that will not parse says nothing about what was asked for, which is
 * the same position as a body that named nothing — and the box treats them the
 * same way for the same reason: what a caller did not say is a question, not a
 * blank to fill in on their behalf.
 */
function jsonBody(body: Uint8Array | null): Record<string, unknown> {
  if (!body || body.length === 0) return {}
  try {
    const parsed: unknown = JSON.parse(new TextDecoder().decode(body))
    return typeof parsed === 'object' && parsed !== null ? (parsed as Record<string, unknown>) : {}
  } catch {
    return {}
  }
}

function dayKey(atMs: number): string {
  const d = new Date(atMs)
  const mm = String(d.getMonth() + 1).padStart(2, '0')
  const dd = String(d.getDate()).padStart(2, '0')
  return `${d.getFullYear()}-${mm}-${dd}`
}

function randomHex(chars: number): string {
  const bytes = crypto.getRandomValues(new Uint8Array(Math.ceil(chars / 2)))
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0'))
    .join('')
    .slice(0, chars)
}
