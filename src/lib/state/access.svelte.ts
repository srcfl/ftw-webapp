/* Who can see this home, and how to change that.
 *
 * The box's own roster, over the passthrough. Reading it is a GET, so it costs
 * nothing but a round trip; inviting and revoking are writes, so the box asks
 * for a fresh passkey ceremony first and box-api runs one.
 *
 * An invite is not a new cryptographic object. It is the pairing code that
 * already exists, minted with a role and a shorter life — so the guest scans
 * the same square from the owner's screen and pairs exactly as an owner does,
 * and learns what they are from the box at handshake. The role is never in the
 * payload: a role its holder could edit is not a role.
 */

import { callBox, BoxApiError } from './box-api'
import { ROLE_OWNER, ROLE_VIEWER, type Role } from '$lib/protocol/messages'
import { ROLE_LABELS } from '$lib/protocol/contract'
import type { SiteStore } from './site.svelte'

/** One phone on the box's list. */
export interface Member {
  /** The box's name for the row: the first eight characters of its key. */
  id: string
  role: Role
  addedAtMs: number | null
  lastSeenMs: number | null
  /** True for the phone this app is running on. */
  isThisPhone: boolean
}

/** A live invitation, until it is spent or expires. */
export interface Invite {
  /** The whole QR payload. Nothing in it reaches a server. */
  url: string
  role: Role
  expiresAtMs: number
}

interface WireDevice {
  id?: unknown
  role?: unknown
  added_at_ms?: unknown
  last_seen_ms?: unknown
}

export class AccessStore {
  /** Most recently seen first, as the box orders them. */
  members = $state.raw<Member[]>([])

  loading = $state(false)

  /**
   * Whether the box has ever answered with a roster.
   *
   * Separate from `loading` because "no rows yet" and "no rows" are different
   * facts and one flag cannot hold both. Without it an empty list has to be
   * read as an empty house, and a household whose phone is demonstrably paired
   * gets told nobody is — which is this app's own rule about never showing a
   * reading it does not have, applied to a roster.
   */
  loaded = $state(false)

  /** A sentence, never a code. */
  error = $state<string | null>(null)

  /** The live invitation, or null. One at a time — that is the box's rule. */
  invite = $state.raw<Invite | null>(null)

  /** What is happening to the roster right now, for the button to say so. */
  busy = $state<'none' | 'inviting' | 'revoking'>('none')

  #site: SiteStore
  #thisPhone: string | null = null
  #token = 0

  constructor(site: SiteStore) {
    this.#site = site
  }

  /**
   * The name this phone answers to on the box's list.
   *
   * Worked out from this phone's own key rather than asked for, which is what
   * lets its row be marked even when the roster arrived from a box that has
   * since gone quiet.
   */
  async identify(): Promise<void> {
    try {
      const { deviceIdOnBox, openVaultStore } = await import('$lib/identity/vault')
      this.#thisPhone = await deviceIdOnBox(openVaultStore())
      this.members = this.members.map((m) => ({ ...m, isThisPhone: m.id === this.#thisPhone }))
    } catch {
      // Blocked or evicted storage costs one row its "this phone" mark. It
      // must not cost the household the list, and it must not surface as an
      // unhandled rejection in a screen that is otherwise working.
    }
  }

  async load(): Promise<void> {
    const token = ++this.#token
    this.loading = true
    this.error = null

    try {
      const wire = await callBox<{ devices?: WireDevice[] }>(this.#site, {
        method: 'GET',
        path: '/api/app-link/devices',
      })
      if (token !== this.#token) return

      this.members = (wire.devices ?? []).map((d) => this.#toMember(d))
      this.loaded = true
      this.error = null
    } catch (err) {
      if (token !== this.#token) return
      // Whatever was listed stays listed. A roster read a minute ago is still
      // the roster, and taking it off the screen tells nobody anything.
      this.error = err instanceof BoxApiError ? err.help : "Your box didn't answer. Still trying."
      throw err
    } finally {
      if (token === this.#token) this.loading = false
    }
  }

  /**
   * Mint a code that admits someone as a viewer.
   *
   * Minting cancels whatever code was live, which is already the box's rule
   * for pairing codes and is why the screen says so.
   *
   * Settles rather than rejecting, unlike `load`. A failure here is already
   * on screen as a sentence, and there is nothing to heal: nobody asked for
   * this except the person who pressed the button, and if they still want it
   * they will press it again. Rejecting would leave a promise nothing awaits,
   * which the browser reports as an unhandled rejection and which is how a
   * green suite still exits non-zero.
   */
  async inviteViewer(): Promise<boolean> {
    this.busy = 'inviting'
    this.error = null
    try {
      // In the body, because that is where the box reads it. It went in the
      // query string for a while, where the box never looked — and a role
      // that does not arrive used to be read as an owner's, so this button
      // asked to share a view and handed over the house. The box refuses a
      // request that names no role now; this is the app not sending one.
      const wire = await callBox<{ url?: unknown; role?: unknown; expires_at_ms?: unknown }>(
        this.#site,
        {
          method: 'POST',
          path: '/api/app-link/pairing',
          body: { role: ROLE_VIEWER },
        }
      )

      // What the box says it minted, not what this app asked for. The screen
      // beside this square promises the person joining sees the house and can
      // change nothing, and that promise is the box's to keep — so an answer
      // that says anything else is a failure here rather than a square drawn
      // under the wrong sentence.
      if (wire.role !== ROLE_VIEWER) {
        throw new BoxApiError(
          'E_BAD_BODY',
          "Your box didn't make a view-only invitation. Nothing has been shared."
        )
      }

      this.invite = {
        url: typeof wire.url === 'string' ? wire.url : '',
        role: ROLE_VIEWER,
        expiresAtMs: typeof wire.expires_at_ms === 'number' ? wire.expires_at_ms : 0,
      }
      return true
    } catch (err) {
      this.error = err instanceof BoxApiError ? err.help : 'That did not work. Nothing has changed.'
      return false
    } finally {
      this.busy = 'none'
    }
  }

  /**
   * Withdraw a phone's access. Its session dies at the box.
   *
   * True only when the box agreed. The row goes from the list on that answer
   * alone — dropping it optimistically would show a household one fewer phone
   * than its box actually trusts, which is the opposite of what this screen
   * is for.
   */
  async revoke(id: string): Promise<boolean> {
    this.busy = 'revoking'
    this.error = null
    try {
      await callBox<unknown>(this.#site, {
        method: 'DELETE',
        path: `/api/app-link/devices/${encodeURIComponent(id)}`,
      })
      this.members = this.members.filter((m) => m.id !== id)
      return true
    } catch (err) {
      // A 404 is the box saying that phone is no longer paired, which is what
      // was asked for. Two owners and one slightly old roster is all it takes,
      // and reporting a done thing as a failure leaves the row on screen
      // against a box that has not had it for a minute.
      if (err instanceof BoxApiError && err.status === 404) {
        this.members = this.members.filter((m) => m.id !== id)
        return true
      }
      this.error = err instanceof BoxApiError ? err.help : 'That did not work. Nothing has changed.'
      return false
    } finally {
      this.busy = 'none'
    }
  }

  #toMember(d: WireDevice): Member {
    const id = typeof d.id === 'string' ? d.id : ''
    return {
      id,
      // A row from a box that has never heard of roles is an owner. Reading
      // it as a viewer would show a household its own phones demoted on the
      // morning it updated this app, which is the migration rule the box
      // itself keeps and the app has no business contradicting.
      role: typeof d.role === 'string' && d.role !== '' ? d.role : ROLE_OWNER,
      addedAtMs: typeof d.added_at_ms === 'number' ? d.added_at_ms : null,
      lastSeenMs: typeof d.last_seen_ms === 'number' ? d.last_seen_ms : null,
      isThisPhone: id === this.#thisPhone,
    }
  }
}

/** The registry's own word for a role, or the key when it is one we do not know. */
export function roleLabel(role: Role): string {
  return ROLE_LABELS[role] ?? role
}
