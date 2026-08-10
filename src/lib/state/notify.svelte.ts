/* Notifications for this phone, and the box's say over them.
 *
 * The subscription is a pair of records that must agree: the browser's — an
 * endpoint at the push service — and the box's copy of it, which is what the
 * box actually sends to. Turning on writes both; turning off removes both.
 * The browser's is read back at every mount, so the switch shows what this
 * phone is rather than what it last remembered.
 *
 * The permission prompt has one hard rule: iOS grants it only inside the tap
 * that asked. So `enable` must be called synchronously from the click
 * handler, and asks for permission before anything awaits — the box is only
 * consulted afterwards, which also means a phone whose box turns out to be
 * too old has said yes to notifications it cannot get yet. That order is
 * forced, and the sentence for an old box owns up to it.
 *
 * Rules are the box's document; this store sends only the kinds it knows and
 * reads the answer tolerantly, so a newer box's kinds survive a save from an
 * older app. What is cached locally — the box's row id, the last rules seen —
 * is a cache, never the original: losing it costs a sentence, not the record.
 */

import { callBox, BoxApiError } from './box-api'
import { decodeBase64url } from '$lib/identity/base64url'
import { RULE_KINDS } from '$lib/notify/kinds'
import type { SiteStore } from './site.svelte'

/** One notification the box has already sent, as the box remembers it. */
export interface SentPush {
  title: string
  atMs: number | null
}

/**
 * One rule as the box's document carries it. The whole entry rides every
 * save because the box replaces a rule wholesale: a partial entry would
 * zero the thresholds the box seeded. Unknown fields survive the round
 * trip untouched for the same reason.
 */
interface WireRule extends Record<string, unknown> {
  type: string
  enabled: boolean
}

interface RulesDoc {
  enabled: boolean
  events: WireRule[]
}

/** The box's row id and the last rules it confirmed. A cache — see above. */
const REMEMBER_KEY = 'ftw.push'

function allOff(): Record<string, boolean> {
  // The box seeds every rule disabled — sparse by design. Until its
  // document has been read, claiming anything else would be a lie.
  return Object.fromEntries(RULE_KINDS.map((k) => [k, false]))
}

function toDoc(wire: unknown): RulesDoc | null {
  if (typeof wire !== 'object' || wire === null) return null
  const w = wire as Record<string, unknown>
  if (!Array.isArray(w['events'])) return null
  const events = w['events'].filter(
    (e): e is WireRule =>
      typeof e === 'object' &&
      e !== null &&
      typeof (e as WireRule).type === 'string' &&
      typeof (e as WireRule).enabled === 'boolean'
  )
  return { enabled: w['enabled'] === true, events }
}

export class NotifyStore {
  /** This phone can do web push at all. On iOS that means installed. */
  supported = $state(false)

  /** The browser holds a live subscription for this app. */
  enabled = $state(false)

  /** The box answered E_UNKNOWN_OP: it has no notification routes yet. */
  oldBox = $state(false)

  busy = $state<'none' | 'enabling' | 'disabling' | 'saving' | 'testing'>('none')

  /** A sentence, never a code. */
  error = $state<string | null>(null)

  /** Whether the last thing that happened was a test going out. */
  testSent = $state(false)

  /** kind -> on, as last confirmed by the box. Unread kinds read as off. */
  rules = $state<Record<string, boolean>>(allOff())

  /** Most recent first, as the box orders them. */
  history = $state.raw<SentPush[]>([])

  #site: SiteStore
  #subId: string | null = null
  /** The box's whole rules document, held so a save can send whole entries. */
  #doc: RulesDoc | null = null

  constructor(site: SiteStore) {
    this.#site = site
  }

  #applyDoc(doc: RulesDoc): void {
    this.#doc = doc
    const next = allOff()
    for (const rule of doc.events) {
      if (rule.type in next) next[rule.type] = rule.enabled
    }
    this.rules = next
  }

  /**
   * What this phone already is. Local reads only, so it never waits on the
   * box — the box's half (an old box, a viewer's role) is met per action.
   */
  async check(): Promise<void> {
    this.supported =
      typeof Notification !== 'undefined' &&
      typeof PushManager !== 'undefined' &&
      'serviceWorker' in navigator
    if (!this.supported) return

    const remembered = this.#remembered()
    this.#subId = typeof remembered['id'] === 'string' ? remembered['id'] : null
    const doc = toDoc(remembered['doc'])
    if (doc) this.#applyDoc(doc)

    try {
      const registration = await navigator.serviceWorker.getRegistration()
      this.enabled = (await registration?.pushManager.getSubscription()) != null
    } catch {
      // A worker that cannot be asked is a phone that is not subscribed.
      this.enabled = false
    }
  }

  /**
   * Turn notifications on: permission, the box's key, a subscription, and
   * the box told where to send.
   *
   * MUST be called synchronously from the tap's own handler. The permission
   * ask is the first thing that runs, before any await settles, because iOS
   * only grants it inside the gesture that asked.
   */
  async enable(): Promise<void> {
    if (this.busy !== 'none') return
    this.busy = 'enabling'
    this.error = null
    this.testSent = false
    try {
      const permission = await Notification.requestPermission()
      if (permission !== 'granted') {
        // A dismissed sheet is an unanswered question, not a fault; said no
        // is an answer, and the only way back is outside this app.
        if (permission === 'denied') {
          this.error =
            'Notifications are switched off for this app on this phone. ' +
            "Turn them on in your browser's settings, then try again here."
        }
        return
      }

      const key = await callBox<{ public_key?: unknown }>(this.#site, {
        method: 'GET',
        path: '/api/notifications/vapid',
      })
      if (typeof key.public_key !== 'string' || key.public_key === '') {
        throw new BoxApiError('E_BAD_BODY', "Your box sent something this app couldn't read.")
      }

      const registration = await navigator.serviceWorker.getRegistration()
      if (!registration) {
        this.error = "This phone isn't ready for notifications yet. Close the app and open it again."
        return
      }
      const subscription = await registration.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: decodeBase64url(key.public_key),
      })

      const wire = subscription.toJSON()
      try {
        const answer = await callBox<{ id?: unknown }>(this.#site, {
          method: 'POST',
          path: '/api/notifications/subscriptions',
          body: {
            endpoint: wire.endpoint,
            keys: { p256dh: wire.keys?.['p256dh'], auth: wire.keys?.['auth'] },
          },
        })
        this.#subId = typeof answer.id === 'string' ? answer.id : null
      } catch (err) {
        // The box never learned the endpoint, so a subscription kept locally
        // would be a switch showing on for notifications that cannot come.
        await subscription.unsubscribe().catch(() => {})
        throw err
      }

      this.#remember()
      this.enabled = true
    } catch (err) {
      this.#fail(err)
    } finally {
      this.busy = 'none'
    }
  }

  /**
   * Turn them off: the box's record first, then the browser's.
   *
   * In that order because the box's copy is the one that sends. A local
   * unsubscribe alone leaves the box posting into a dead endpoint until it
   * prunes it — the switch would be off while the box still believed on.
   */
  async disable(): Promise<void> {
    if (this.busy !== 'none') return
    this.busy = 'disabling'
    this.error = null
    this.testSent = false
    try {
      if (this.#subId !== null) {
        try {
          await callBox<unknown>(this.#site, {
            method: 'DELETE',
            path: `/api/notifications/subscriptions/${encodeURIComponent(this.#subId)}`,
          })
        } catch (err) {
          // Already gone is the outcome that was asked for.
          if (!(err instanceof BoxApiError && err.status === 404)) throw err
        }
      }
      const registration = await navigator.serviceWorker.getRegistration()
      await (await registration?.pushManager.getSubscription())?.unsubscribe()
      this.#subId = null
      this.#remember()
      this.enabled = false
    } catch (err) {
      this.#fail(err)
    } finally {
      this.busy = 'none'
    }
  }

  /**
   * Read the box's rules document. A read, priced Read — looking at the
   * toggles must never cost a ceremony.
   */
  async loadRules(): Promise<void> {
    try {
      const wire = await callBox<unknown>(this.#site, {
        method: 'GET',
        path: '/api/notifications/rules',
      })
      const doc = toDoc(wire)
      if (doc) {
        this.#applyDoc(doc)
        this.#remember()
      }
    } catch (err) {
      if (err instanceof BoxApiError && err.code === 'E_UNKNOWN_OP') {
        this.oldBox = true
        return
      }
      throw err
    }
  }

  /**
   * Save which kinds this phone wants, in one write.
   *
   * One PUT for the whole batch — one ceremony — the schedule editor's rule.
   * Every entry goes out whole, flipped only on `enabled`: the box replaces
   * a rule wholesale, so a partial entry would wipe the thresholds it
   * seeded. Kinds the box's document does not carry are not sent — an older
   * box must not meet a kind it would refuse by name.
   */
  async saveRules(next: Record<string, boolean>): Promise<boolean> {
    if (this.busy !== 'none') return false
    this.busy = 'saving'
    this.error = null
    this.testSent = false
    try {
      if (this.#doc === null) await this.loadRules()
      const doc = this.#doc
      if (doc === null) {
        this.error = "Your box didn't answer. Nothing has changed."
        return false
      }

      const events = doc.events
        .filter((rule) => RULE_KINDS.some((k) => k === rule.type) && rule.type in next)
        .map((rule) => ({ ...rule, enabled: next[rule.type] === true }))

      const wire = await callBox<unknown>(this.#site, {
        method: 'PUT',
        path: '/api/notifications/rules',
        body: { enabled: true, events },
      })
      const stored = toDoc(wire)
      if (stored) this.#applyDoc(stored)
      this.#remember()
      return true
    } catch (err) {
      this.#fail(err)
      return false
    } finally {
      this.busy = 'none'
    }
  }

  /** Ask the box to send one real push through the whole pipe. */
  async sendTest(): Promise<void> {
    if (this.busy !== 'none') return
    this.busy = 'testing'
    this.error = null
    this.testSent = false
    try {
      await callBox<unknown>(this.#site, { method: 'POST', path: '/api/notifications/test' })
      this.testSent = true
    } catch (err) {
      this.#fail(err)
    } finally {
      this.busy = 'none'
    }
  }

  /**
   * What the box has already sent. A read, asked while the session is live —
   * and the probe that finds an old box before any button is drawn for it.
   *
   * Rejects so askWhenLive asks again, except for E_UNKNOWN_OP: a box that
   * does not have these routes will not have them on the next try either,
   * and the sentence for that is terminal rather than a retry.
   */
  async loadHistory(): Promise<void> {
    try {
      const wire = await callBox<{ events?: unknown }>(this.#site, {
        method: 'GET',
        path: '/api/notifications/history',
      })
      this.history = Array.isArray(wire.events) ? wire.events.map(toSentPush) : []
    } catch (err) {
      if (err instanceof BoxApiError && err.code === 'E_UNKNOWN_OP') {
        this.oldBox = true
        return
      }
      throw err
    }
  }

  #fail(err: unknown): void {
    if (err instanceof BoxApiError && err.code === 'E_UNKNOWN_OP') this.oldBox = true
    this.error =
      err instanceof BoxApiError ? err.help : "That didn't work. Nothing has changed."
  }

  #remembered(): Record<string, unknown> {
    try {
      const raw = localStorage.getItem(REMEMBER_KEY)
      const parsed: unknown = raw === null ? null : JSON.parse(raw)
      return typeof parsed === 'object' && parsed !== null
        ? (parsed as Record<string, unknown>)
        : {}
    } catch {
      return {}
    }
  }

  #remember(): void {
    try {
      localStorage.setItem(
        REMEMBER_KEY,
        JSON.stringify({
          ...(this.#subId !== null ? { id: this.#subId } : {}),
          ...(this.#doc !== null ? { doc: this.#doc } : {}),
        })
      )
    } catch {
      // Blocked storage costs the next launch a cached answer, nothing more.
    }
  }
}

function toSentPush(row: unknown): SentPush {
  const r = typeof row === 'object' && row !== null ? (row as Record<string, unknown>) : {}
  return {
    title: typeof r['title'] === 'string' ? r['title'] : '',
    atMs: typeof r['at_ms'] === 'number' ? r['at_ms'] : null,
  }
}
