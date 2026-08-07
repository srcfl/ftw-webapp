/* Calling the box's own API from a view, in JSON, with sentences.
 *
 * Three jobs, and nothing else belongs here.
 *
 * It decodes. The session hands up bytes and a status, because a status is an
 * answer and this layer has no business guessing what a 404 means.
 *
 * It runs the step-up. A write is refused with E_NEEDS_STEP_UP until a passkey
 * ceremony has happened, and the honest shape of that is: ask, be refused,
 * prompt, ask again — once per call. The app never knows a route's tier
 * beforehand and never carries a list of them: the box prices each route
 * beside its handler, and a copy of that here would be the list that rots.
 *
 * Every write pays it, not only the first of a session. The box refuses on the
 * flag alone and keeps nothing about a ceremony that already ran, so a second
 * write is refused exactly as the first was. Sending the flag ahead of the
 * ceremony to save the round trip would be this app claiming something that
 * had not happened.
 *
 * It owns the prose. The box sends stable codes; every word a person reads is
 * this app's, and every word says what happens now rather than what broke.
 */

import { ApiError } from '$lib/protocol/session'
import type { ApiMethod } from '$lib/protocol/messages'
import type { SiteStore } from './site.svelte'

/**
 * Something a view can put on screen.
 *
 * `code` is kept beside the sentence because a few callers need to branch —
 * a last-owner refusal is a different screen than a network failure — but no
 * caller ever renders it.
 */
export class BoxApiError extends Error {
  constructor(
    readonly code: string,
    readonly help: string,
    /** The HTTP status, when a handler answered. Null when none ran. */
    readonly status: number | null = null
  ) {
    super(code)
    this.name = 'BoxApiError'
  }
}

export interface Call {
  method: ApiMethod
  path: string
  query?: Record<string, string>
  body?: unknown
}

/**
 * Ask the box, and get JSON back.
 *
 * Rejects with a `BoxApiError` carrying a sentence — including for a status
 * outside 2xx, because by the time a view is asking for a parsed object a 500
 * is a failure to it even though it was an answer to the session.
 */
export async function callBox<T>(site: SiteStore, call: Call): Promise<T> {
  const res = await send(site, call, false)

  if (res.status < 200 || res.status >= 300) {
    const code = codeFromBody(res.body)
    throw new BoxApiError(code ?? `HTTP_${res.status}`, statusHelp(res.status, code), res.status)
  }

  if (res.body.length === 0) return undefined as T

  try {
    return JSON.parse(new TextDecoder().decode(res.body)) as T
  } catch {
    // A body that is not the JSON it claimed to be is a box and an app that
    // disagree about a route. Nothing a person can do, so say the only true
    // thing: this did not work, and it is not their fault.
    throw new BoxApiError('E_BAD_BODY', "Your box sent something this app couldn't read.", res.status)
  }
}

async function send(site: SiteStore, call: Call, stepUp: boolean) {
  const body =
    call.body === undefined ? null : new TextEncoder().encode(JSON.stringify(call.body))

  try {
    return await site.api({
      method: call.method,
      path: call.path,
      ...(call.query ? { query: call.query } : {}),
      ...(body ? { body } : {}),
      ...(stepUp ? { stepUp: true } : {}),
    })
  } catch (err) {
    if (!(err instanceof ApiError)) {
      // No code and no status: the wire went away, or the deadline passed.
      // Both heal on their own, so the sentence says what is happening rather
      // than offering a button that cannot help.
      throw new BoxApiError('E_NO_ANSWER', "Your box didn't answer. Still trying.")
    }

    // The one place a step-up is run, and only ever once. A second refusal
    // after a ceremony is the box saying something else, and repeating the
    // prompt would be this app arguing with it.
    if (err.detail.code === 'E_NEEDS_STEP_UP' && !stepUp) {
      const { stepUp: prove, stepUpHelp } = await import('$lib/identity/stepup')
      const outcome = await prove()
      if (outcome !== 'done') throw new BoxApiError(err.detail.code, stepUpHelp(outcome))
      return send(site, call, true)
    }

    throw new BoxApiError(err.detail.code, refusalHelp(err.detail.code, err.detail.args))
  }
}

/**
 * A stable code the box put in a JSON body, when it did.
 *
 * The box's own handlers answer some refusals with a status and a body rather
 * than through the passthrough's error path — the last-owner rule is one — so
 * a caller that needs to tell those apart has somewhere to read them from.
 */
function codeFromBody(body: Uint8Array): string | null {
  if (body.length === 0) return null
  try {
    const parsed = JSON.parse(new TextDecoder().decode(body)) as { code?: unknown }
    return typeof parsed.code === 'string' && parsed.code.startsWith('E_') ? parsed.code : null
  } catch {
    return null
  }
}

/**
 * What happens now, for a refusal that never reached a handler.
 *
 * No E_BOOTING branch. The box refuses a subscription and a plan while it
 * starts, because it genuinely has neither, but the passthrough sends that
 * code on no path at all: until the API is bound the request meets a handler
 * answering 503, which arrives here as a status. A branch for a code the box
 * cannot send on this path is a sentence nobody will ever read and a claim
 * about the box that is not true — `statusHelp` has the 503 instead.
 */
function refusalHelp(code: string, args?: Record<string, unknown>): string {
  switch (code) {
    case 'E_UNKNOWN_OP':
      // Nothing on the box claims this path, so its router handed the request
      // to the file server and the session does not carry that. This app never
      // invents a path, so from here it means one thing: the box is older than
      // the view asking. It is not a 404 — a route the box does not have never
      // reaches a handler at all.
      return "Your box doesn't have that yet — it may be running older software."
    case 'E_UNAVAILABLE':
      return args?.['reason'] === 'busy'
        ? 'Your box is busy with something else. This will fill in shortly.'
        : "Your box can't answer that right now. Still trying."
    case 'E_SCOPE_DENIED':
      return 'Only the owner of this home can change that.'
    case 'E_GRANT_REVOKED':
      return 'Your access to this home was withdrawn by its owner.'
    case 'E_USE_CMD':
      // Reaching this means the app drew a control it should not have, which
      // is a bug rather than something the household did.
      return 'That has to be done from the controls on the home screen.'
    case 'E_UNSUPPORTED_MEDIA':
    case 'E_WHOLE_DOCUMENT':
    case 'E_LOCAL_ONLY':
      // Three reasons the session will not carry a route: an answer it cannot
      // stream, a body that would overwrite a whole document, and a route that
      // is local by nature. They stay three codes because they are three
      // different facts about the route — but what happens now is the same for
      // all three, and one sentence is the honest way to say it.
      return "That one is only available on your box's own page, from home."
    case 'E_RESPONSE_TOO_LARGE':
      return "That's more than we can send over your connection — narrow the range."
    case 'E_NEEDS_STEP_UP':
      // Reached only when the box asked a second time after a ceremony had
      // already run, which means it wants something this app cannot supply.
      return 'Your box needs more proof than this phone can give. Do it on your box.'
    default:
      return "That didn't work. Nothing on your box has changed."
  }
}

/**
 * What happens now, for a status a handler did answer with.
 *
 * The code comes first where the box sent one. A 409 is a conflict and
 * nothing more specific than that — reading it as the last-owner rule would
 * put that sentence under every other conflict the box will ever have.
 *
 * Every status here is one a handler can produce. A missing ROUTE is not among
 * them: the box's router hands a path nothing claims to its own file server,
 * which the session refuses as E_UNKNOWN_OP before any handler runs. So a 404
 * arriving here always means the handler ran and the THING was not there.
 */
function statusHelp(status: number, code: string | null): string {
  if (code === 'E_LAST_OWNER_PROTECTED') {
    return 'Someone has to own this home, so the last owner cannot be removed.'
  }
  if (status === 404) return "That's no longer on your box."
  if (status === 403) return 'Your box refused that from this phone.'
  if (status === 409) return 'Something changed on your box first. Nothing here was applied.'
  // The API is bound to the session a moment after the session is, so every
  // route answers 503 in the seconds after a restart. That is the commonest
  // 5xx a phone meets, and it is a box that is not ready rather than one that
  // broke — the app is already asking again.
  if (status === 503) return "Your box can't answer that yet. Still trying."
  if (status >= 500) return 'Something went wrong on your box. Nothing has changed.'
  return "Your box couldn't do that."
}
