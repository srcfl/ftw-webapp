/* Pairing: from a scanned code to a working session.
 *
 * Two taps is the whole budget. Scan, Face ID, done — no fields, no code to
 * type, no email, no account, and nothing to choose. Everything below exists
 * to keep it that way while still ending up with a pinned box key and a
 * device key that only this passkey can unwrap.
 *
 * The order matters and is not arbitrary:
 *
 *   1. Parse the QR. Cheap, and a bad code should fail before we prompt for
 *      anything — asking for Face ID and then saying "that was the wrong code"
 *      is the sort of thing that makes people distrust the whole flow.
 *   2. Ask for the passkey. One prompt, and it is the only one.
 *   3. Unwrap or create the device key.
 *   4. Store the site, pinned to the box key from the fragment.
 *
 * Only then does anything touch the network.
 */

import { parseEnrollmentUrl, parseEnrollmentFragment, EnrollmentError, type Enrollment } from './enrollment'
import { openVaultStore, enrollWrappingKey, unlockWrappingKey, deviceKey, isEnrolled, type VaultStore } from './vault'
import type { KeyPair } from '$lib/crypto/noise'
import { db, requestPersistence, type StoredSite } from '$lib/store/db'

export interface PairedSite {
  siteId: string
  label: string
  /** Pinned optically. This is what stops the relay impersonating a box. */
  boxStaticKey: Uint8Array
  /** Single use. Goes in handshake message 1 so the box can accept us. */
  pairingCode: Uint8Array
  /** Long-lived. The rotating relay handle is derived from it, and only from it. */
  rendezvousSecret: Uint8Array
  lanHint: string | null
}

export type PairPhase =
  | 'idle'
  | 'reading'
  | 'authenticating'
  | 'storing'
  | 'done'
  | 'failed'

/**
 * A site id derived from the box's public key.
 *
 * Local only — it never crosses the wire, where the rendezvous handle is used
 * instead precisely so the relay cannot correlate a household over time.
 */
export async function siteIdFor(boxStaticKey: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', boxStaticKey as BufferSource)
  return Array.from(new Uint8Array(digest).subarray(0, 8))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('')
}

export interface PairResult {
  site: PairedSite
  deviceStatic: KeyPair
}

export interface PairOptions {
  /** Injected by tests. */
  store?: VaultStore
  /** Shown on the passkey prompt. */
  label?: string
}

/**
 * Pair with a box from a scanned URL or a fragment.
 *
 * Throws EnrollmentError with a sentence the user can act on. Everything that
 * can fail before the passkey prompt does fail before it.
 */
export async function pairWithBox(
  scanned: string,
  opts: PairOptions = {}
): Promise<PairResult> {
  const enrollment = parseScanned(scanned)
  const store = opts.store ?? openVaultStore()

  // One prompt. A device that already has a passkey unlocks; a new one enrolls.
  const wrapping = (await isEnrolled(store))
    ? await unlockWrappingKey(store, opts.label ? { label: opts.label } : {})
    : await enrollWrappingKey(store, opts.label ? { label: opts.label } : {})

  const device = await deviceKey(store, wrapping)

  const siteId = await siteIdFor(enrollment.boxStaticPublic)
  const site: PairedSite = {
    siteId,
    label: 'Home',
    boxStaticKey: enrollment.boxStaticPublic,
    pairingCode: enrollment.pairingCode,
    rendezvousSecret: enrollment.rendezvousSecret,
    lanHint: enrollment.lanHint || null,
  }

  await storeSite(site)

  // Asked for only once there is something worth keeping. Prompting on a
  // first launch that has no data yet is a question about nothing.
  void requestPersistence()

  return {
    site,
    deviceStatic: { secretKey: new Uint8Array(0), publicKey: device.publicKey },
  }
}

function parseScanned(scanned: string): Enrollment {
  const text = scanned.trim()
  if (text === '') {
    throw new EnrollmentError('nothing scanned', 'E_QR_NOT_FTW', 'That code did not scan. Try again.')
  }
  // Cameras hand back a full URL; a deep link hands back only the fragment.
  return text.startsWith('#') ? parseEnrollmentFragment(text) : parseEnrollmentUrl(text)
}

async function storeSite(site: PairedSite): Promise<void> {
  const database = await db()
  const row: StoredSite = {
    siteId: site.siteId,
    label: site.label,
    boxStaticKey: site.boxStaticKey,
    // Kept because the handle has to keep rotating long after the pairing
    // code is spent. The QR is the only place it ever appears.
    rendezvousSecret: site.rendezvousSecret,
    // Kept because the box wants it in handshake message 1, and the first
    // handshake happens after this function has returned.
    pairingCode: site.pairingCode,
    addedAtMs: Date.now(),
    lastSeenAtMs: Date.now(),
  }
  await database.put('sites', row)

  // The inline boot script reads this before the bundle is parsed, which is
  // what lets a cold start paint cached readings in the first frame.
  try {
    localStorage.setItem('ftw.site', site.siteId)
  } catch {
    // Blocked storage costs a slower start, not a broken pairing.
  }
}

export async function pairedSites(): Promise<StoredSite[]> {
  const database = await db()
  return database.getAll('sites')
}

export async function currentSiteId(): Promise<string | null> {
  try {
    const stored = localStorage.getItem('ftw.site')
    if (stored) return stored
  } catch {
    /* fall through to the database */
  }
  const sites = await pairedSites()
  return sites[0]?.siteId ?? null
}
