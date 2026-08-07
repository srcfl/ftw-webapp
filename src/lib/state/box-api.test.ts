/* The sentences this layer owns, for the refusals that never reach a handler.
 *
 * A refusal the app has no sentence for still reaches the user — as the
 * default, which says nothing happened and nothing about what to do next.
 * That is the right answer for a code this app has never heard of and the
 * wrong one for a code the box sends today, so the two have to be told apart
 * by a test rather than by reading the switch.
 */

import { describe, it, expect } from 'vitest'
import { ApiError } from '$lib/protocol/session'
import { callBox, BoxApiError } from './box-api'
import type { SiteStore } from './site.svelte'

/** A box that refuses every call with one code, before any handler runs. */
function boxThatRefuses(code: string, args?: Record<string, unknown>): SiteStore {
  return {
    api: () => Promise.reject(new ApiError({ code, retryable: false, ...(args ? { args } : {}) })),
  } as unknown as SiteStore
}

/** A box whose handler ran and answered. A status is an answer, never a code. */
function boxThatAnswers(status: number, body: unknown = {}): SiteStore {
  return {
    api: () =>
      Promise.resolve({
        status,
        headers: { 'content-type': 'application/json' },
        body: new TextEncoder().encode(JSON.stringify(body)),
      }),
  } as unknown as SiteStore
}

async function answerFrom(status: number, body?: unknown): Promise<BoxApiError> {
  try {
    await callBox(boxThatAnswers(status, body), { method: 'GET', path: '/api/app-link/devices' })
  } catch (err) {
    return err as BoxApiError
  }
  throw new Error(`callBox resolved on ${status}`)
}

async function refusalFrom(code: string, args?: Record<string, unknown>): Promise<BoxApiError> {
  try {
    await callBox(boxThatRefuses(code, args), { method: 'POST', path: '/api/config' })
  } catch (err) {
    return err as BoxApiError
  }
  throw new Error(`callBox resolved on ${code}`)
}

/**
 * What a code this app has never heard of gets.
 *
 * Read from the same function rather than written out here, so this file pins
 * the distinction — "this refusal has an answer of its own" — and not a
 * sentence somebody may legitimately reword.
 */
async function defaultSentence(): Promise<string> {
  return (await refusalFrom('E_A_CODE_FROM_A_BOX_FROM_THE_FUTURE')).help
}

/**
 * The refusals that mean "not over the session, no matter who is asking".
 *
 * Three codes because they are three different facts about the route — an
 * answer the session cannot stream, a body that would overwrite a whole
 * document, a route that is local by nature. One answer to the user, because
 * what happens now is the same in all three.
 */
const NOT_OVER_THE_SESSION = ['E_UNSUPPORTED_MEDIA', 'E_WHOLE_DOCUMENT', 'E_LOCAL_ONLY']

describe('a refusal from the passthrough', () => {
  it.each(NOT_OVER_THE_SESSION)('sends you to the box for %s', async (code) => {
    const err = await refusalFrom(code, { path: '/api/config' })

    expect(err.code).toBe(code)
    expect(err.help, 'a code the box sends today gets the unknown-code shrug').not.toBe(
      await defaultSentence()
    )
    expect(err.help).toMatch(/box/i)
    // Nothing ran, so there is no status. Callers use exactly this to tell a
    // refusal from an answer they did not like.
    expect(err.status).toBeNull()
  })

  it('still shrugs at a code this app has never heard of', async () => {
    // The other half of the pair. A box newer than this app must not be able
    // to make it claim something specific about a refusal it cannot read.
    const err = await refusalFrom('E_A_CODE_FROM_A_BOX_FROM_THE_FUTURE')

    expect(err.help).toBe(await defaultSentence())
    expect(err.help).toMatch(/nothing/i)
  })

  it('names the older box for the refusal a route it lacks actually gets', async () => {
    // E_UNKNOWN_OP is what a box sends when nothing claims the path: its
    // router hands the request to the file server, and the session does not
    // carry that. From this app, which sends no path it made up, that means
    // one thing — the box is older than this view.
    const err = await refusalFrom('E_UNKNOWN_OP', { t: 'api.req', field: 'path' })

    expect(err.help).toMatch(/older software/i)
    expect(err.help).not.toBe(await defaultSentence())
  })
})

/**
 * The other half: a handler ran, and the status is its answer.
 *
 * These sentences were written against statuses a box cannot produce here. A
 * 404 was read as a missing route — but a route the box does not have never
 * reaches a handler, so the only 404 that arrives is a handler saying the
 * THING is not there. Telling a household their box needs updating because a
 * phone they already removed is gone is a sentence about the wrong subject.
 */
describe('an answer the caller cannot use', () => {
  it('reads a 404 as the thing being gone, not the route', async () => {
    const err = await answerFrom(404, { error: 'that phone is no longer paired' })

    expect(err.status).toBe(404)
    expect(err.help).not.toMatch(/older software/i)
    expect(err.help).toMatch(/no longer|gone|gone from/i)
  })

  it('reads a 503 as a box that is not ready, not a box that broke', async () => {
    // The API is bound to the session a moment after the session exists, and
    // until then every route answers 503. It is the status a phone meets most
    // often on a box that has just restarted, and "something went wrong" is
    // both false and frightening.
    const err = await answerFrom(503, { error: 'the box is still starting' })

    expect(err.help).not.toMatch(/went wrong/i)
    expect(err.help).toMatch(/starting|not ready|can't answer/i)
  })

  it('keeps a plain 500 as something that went wrong and changed nothing', async () => {
    const err = await answerFrom(500)

    expect(err.help).toMatch(/went wrong/i)
    expect(err.help).toMatch(/nothing has changed/i)
  })
})
