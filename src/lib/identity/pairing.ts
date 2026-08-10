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
// Plain, not deferred. The pairing screen is on the launch path by design —
// a phone with nothing paired has no other screen — and it reads the same
// module on every keystroke of a typed code. A dynamic import here bought
// nothing but a build warning saying so.
import { decodeBoxCode, BoxCodeError } from './boxcode'
import {
  openVaultStore,
  enrollWrappingKey,
  unlockWrappingKey,
  ensureLocalCopy,
  deviceKey,
  isEnrolled,
  type VaultStore,
  type WrappingKey,
} from './vault'
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
  /**
   * The background seal of the spare copy. The app never awaits it — the
   * house shows at once and the copy catches up — but a test can, to see
   * that pairing holds a copy by default.
   */
  sealed: Promise<void>
}

export interface PairOptions {
  /** Injected by tests. */
  store?: VaultStore
  /** Shown on the passkey prompt. */
  label?: string
  /** Where the sealed copy goes. Injected by tests; the default is the real
   *  escrow. */
  escrow?: import('./escrow').EscrowOptions
  /** Hold a sealed copy by default. Off only for tests that drive the escrow
   *  by hand and need to start from an empty one. */
  holdCopy?: boolean
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

  // The local copy, so this is the last prompt reading ever costs. The PRF
  // copy stays for enrollment and privileged commands; connecting to look at
  // your own house is not a privilege. See silentWrappingKey.
  await ensureLocalCopy(store, wrapping)

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

  // Hold a sealed copy from the first device, without anyone finding a
  // switch. The way back should exist by default, and for an escrow
  // Sourceful cannot open — opaque id, nothing beside it — holding it costs
  // the household nothing. In the background, so it never delays the house,
  // and self-correcting: a write that does not land leaves the home
  // unmarked rather than claiming a copy that is not there. The BOX screen
  // is the off switch.
  const sealed =
    opts.holdCopy === false
      ? Promise.resolve()
      : holdSealedCopy(store, wrapping, siteId, opts.escrow)

  // Asked for only once there is something worth keeping. Prompting on a
  // first launch that has no data yet is a question about nothing.
  void requestPersistence()

  return {
    site,
    deviceStatic: { secretKey: new Uint8Array(0), publicKey: device.publicKey },
    sealed,
  }
}

/**
 * Put the just-paired home in the escrow, by default.
 *
 * The wrapping key is the one the pairing ceremony already unlocked, so
 * this adds no prompt. A device with no PRF seals nothing — the local
 * fallback derives no escrow id, on purpose, because a copy sealed under a
 * key that sits unwrapped on disk is one anyone holding the phone could
 * upload. Everything is best-effort: pairing has already succeeded, and a
 * spare copy that could not be written is not a reason to undo it. The mark
 * follows the write, so the BOX screen never says a copy is held when it is
 * not. Dynamically imported to keep escrow's crypto out of the pairing
 * chunk, and because escrow imports this file.
 */
async function holdSealedCopy(
  store: VaultStore,
  wrapping: WrappingKey,
  siteId: string,
  escrow?: import('./escrow').EscrowOptions
) {
  if (!wrapping.escrow) return
  try {
    const { markEscrowed, saveEscrowCopy } = await import('./escrow')
    await markEscrowed(siteId, true)
    if ((await saveEscrowCopy(store, wrapping, escrow ?? {})) !== 'saved') {
      await markEscrowed(siteId, false)
    }
  } catch {
    // Offline, a dismissed prompt, a disk that refused — the home stays
    // exactly as it paired, minus a spare copy it can make next time the
    // BOX screen is opened. Never surfaced here: pairing already worked.
    try {
      const { markEscrowed } = await import('./escrow')
      await markEscrowed(siteId, false)
    } catch {
      // The mark is this device's belief about a copy; a stale one costs a
      // wrong word on the BOX screen and is put right by the next attempt.
    }
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

}

/**
 * Take a code read off the box's screen and arm the next handshake with it.
 *
 * The box mints eight characters, shows them on its own page and tells the
 * household to read them out. They decode to the same five bytes a scanned
 * code's payload carries, and they are spent in the same place — message 1 of
 * the Noise handshake — so this writes them where `connectToSite` already
 * looks and there is no second path to the box.
 *
 * It is for a phone that has been here before. A box code carries no box key
 * and no rendezvous secret, so a phone with no row for this home could not
 * find the box or be sure of the one that answered; that phone scans. The
 * caller is what enforces this — an unknown site is refused here rather than
 * quietly writing a row that could never connect.
 *
 * The decode happens before the disk is touched, so a mistyped code costs
 * nothing at all. The box burns a code after five wrong tries, which is what
 * makes forty spoken bits safe, and it is also why the app must never spend
 * one of those tries on something it could read correctly itself.
 */
export async function redeemBoxCode(siteId: string, typed: string): Promise<void> {
  const pairingCode = decodeBoxCode(typed)

  const database = await db()
  const row = await database.get('sites', siteId)
  if (!row) {
    throw new BoxCodeError(
      `no site ${siteId}`,
      'This phone has no record of that home. Scan the code on your box instead.'
    )
  }

  await database.put('sites', { ...row, pairingCode })
}

/**
 * Point the app at a site.
 *
 * Separate from storing it, on purpose. Storing a site is a fact; making it
 * the site the app shows and controls is a decision, and it used to happen as
 * a side effect of the fact — so any link that got as far as storing a row
 * also silently became this phone's home. The caller makes that decision
 * after the user has agreed to it.
 */
export function setCurrentSite(siteId: string): void {
  // The inline boot script reads this before the bundle is parsed, which is
  // what lets a cold start paint cached readings in the first frame.
  try {
    localStorage.setItem(SITE_POINTER, siteId)
  } catch {
    // Blocked storage costs a slower start, not a broken pairing.
  }
}

/**
 * Point the app at nothing.
 *
 * The counterpart of setCurrentSite, and it lives here for the same reason:
 * this file owns which home the app opens. A pointer left behind after the
 * row it names is gone is worse than no pointer at all — the launch path
 * believes this phone is paired, so it opens an empty house instead of the
 * pairing screen, and there is no way out of it.
 */
export function clearCurrentSite(): void {
  try {
    localStorage.removeItem(SITE_POINTER)
  } catch {
    // Storage that cannot be written was never read either.
  }

  // The inline boot script's read, if it is still in flight. It resolves to a
  // sealed blob, and the key that opens it is about to go — but dropping the
  // promise costs nothing and removes the question.
  if (typeof window !== 'undefined') window.__ftwBoot = undefined
}

/** Also spelled in index.html, which runs before any module exists. */
const SITE_POINTER = 'ftw.site'

export async function pairedSites(): Promise<StoredSite[]> {
  const database = await db()
  return database.getAll('sites')
}

export async function currentSiteId(): Promise<string | null> {
  try {
    const stored = localStorage.getItem(SITE_POINTER)
    if (stored) return stored
  } catch {
    /* fall through to the database */
  }
  const sites = await pairedSites()
  return sites[0]?.siteId ?? null
}

/**
 * A short, stable name for a box key: six hex characters of its digest.
 *
 * Not a security control on its own — nobody memorises it — but it makes two
 * different boxes visibly different, which is what a person needs in order to
 * notice that the box being offered is not the one on their wall. It lives
 * here so the screen that offers a box and the screen that names the one you
 * are paired to cannot drift into calling the same box two things.
 */
export async function boxFingerprint(boxStaticKey: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', boxStaticKey as BufferSource)
  return Array.from(new Uint8Array(digest).subarray(0, 3))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('')
    .toUpperCase()
}
