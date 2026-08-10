/* The sealed copy Sourceful holds, so a fresh install is not a dead end.
 *
 * Adding this app to the home screen gives it storage of its own, so it
 * launches with an empty vault and an empty site list. The passkey survives —
 * it syncs through the platform's own keychain — but what the passkey
 * protected did not, so the only offer that screen could make was "scan the
 * code on your box", for a box the phone was already paired to.
 *
 * So a household may ask Sourceful to hold one sealed copy. The claim, and
 * every word of it has to be literally true:
 *
 *   "Sourceful holds a sealed copy it cannot open, with an opaque id and
 *    nothing beside it."
 *
 *   Sealed — AES-GCM under a key derived from PRF output. The service holds
 *     ciphertext; there is no key in it and no path by which one arrives.
 *   Opaque id — 32 bytes from the same PRF output under its own info string,
 *     so a fresh device derives it from the passkey alone and the id says
 *     nothing about the key. See PRF_SALTS.escrow in ./prf.
 *   Nothing beside it — four fields in a fixed slot and no created-at, in a
 *     file whose bytes are a function of what is stored and never of when. That
 *     second half is not a detail: on a managed database with point-in-time
 *     recovery the write times are kept for you, outside the schema's reach,
 *     and on a b-tree the arrival order is in the page layout. The sentence
 *     above was false six times before it was true — four in the service, once
 *     in the document of record, which went on describing a store nobody ran,
 *     and once on the clock, where it still is. An accepted write pays two
 *     fsyncs and a read pays none, so anybody who can send a request can tell
 *     that a write landed and about when. That sixth one names no household —
 *     no id, no order, nothing but a count of writes over time — and it is
 *     left open deliberately, priced in escrow/README.md under "what it still
 *     knows" rather than paid for by putting two fsyncs on every read. See
 *     escrow/README.md, escrow/layout.md and escrow/deploy/README.md, which
 *     are what an outsider checks.
 *
 * A WRITE IS SIGNED, AND A READ IS NOT. Knowing an id used to be the whole
 * authorisation, so anyone who learned one could overwrite a household's spare
 * copy. Every write now carries an Ed25519 key and a signature; the service
 * pins the key the first time and takes no other afterwards. Reading stays
 * behind the id alone, because a fresh install has a passkey and nothing else
 * and the whole feature is that it can still read.
 *
 * WHAT IT COSTS, named here because the opt-in screen has to say it and
 * nothing on a screen may promise more than this file delivers:
 *
 *   THE ID IS PERMANENT. It is a function of the credential and a fixed salt.
 *   It cannot be rotated without registering a new passkey, and a new passkey
 *   cannot open the old copy. Rotating means a new passkey, a new copy, a
 *   write under the new id and a clear of the old copy — a deliberate act with
 *   a screen in front of it, never something that happens quietly.
 *
 *   IT IS A STABLE PSEUDONYM. Sourceful sees the same 32 bytes every time,
 *   beside whatever the network reveals. The mitigation is the shape of the
 *   traffic rather than a policy: this is touched twice in a device's life,
 *   once on a write and once on a recovery. Two requests, not a stream.
 *
 *   A RECOVERY IS INVISIBLE TO THE HOUSEHOLD. Restoring puts back the same
 *   device scalar, so the box takes its already-authorised branch and cannot
 *   tell a recovery from a reconnect — by design, because that is what makes
 *   recovery need no pairing code. The only counter-measure is the one that
 *   already exists: the box can revoke the device.
 *
 * WHAT LOSING THE DATABASE COSTS: a QR scan. Worst case is exactly today's
 * behaviour, which is what makes this safe to operate. Nothing depends on it
 * and nothing is lost with it.
 */

import { sha256 } from '@noble/hashes/sha2.js'
import { db, requestPersistence, type StoredSite } from '$lib/store/db'
import { encodeBase64url } from './base64url'
import { boxFingerprint } from './pairing'
import { currentRpId } from './origin'
import {
  PRF_SALTS,
  toWrappingKey,
  webAuthnAvailable,
  type EscrowKeys,
  type WrappingKey,
} from './prf'
import {
  openRecoveryBlob,
  RecoveryBlobError,
  RECOVERY_BLOB_MAX_BYTES,
  sealRecoveryBlob,
  type RecoverableHome,
} from './recovery-blob'
import {
  addCredential,
  exportDeviceSecret,
  localWrappingKey,
  openVaultStore,
  restoreDeviceKey,
  unlockWrappingKey,
  type VaultStore,
} from './vault'

/**
 * Its own hostname, and neither of the two it sits beside.
 *
 * Not the relay's: the relay's claim is that it stores nothing. Not the app's:
 * that origin serves static files with no Worker in front of them, and putting
 * one back is what once stopped the service worker installing.
 */
export const ESCROW_ORIGIN = 'https://escrow.ftw.energy'

export interface EscrowOptions {
  /** Injected by tests, and by nothing else. */
  origin?: string
  fetch?: typeof fetch
  rpId?: string
  signal?: AbortSignal
}

export type EscrowErrorCode = 'E_ESCROW_UNREACHABLE' | 'E_ESCROW_REFUSED'

export class EscrowError extends Error {
  constructor(
    message: string,
    readonly code: EscrowErrorCode,
    readonly help: string
  ) {
    super(message)
    this.name = 'EscrowError'
  }
}

// ---------------------------------------------------------------------------
// Which homes are in it
// ---------------------------------------------------------------------------

/** The homes this household asked to be held. Never every home on the phone. */
export async function escrowedHomes(): Promise<RecoverableHome[]> {
  const database = await db()
  const rows = (await database.getAll('sites')) as StoredSite[]
  return rows
    .filter(
      (row): row is StoredSite & { rendezvousSecret: Uint8Array } =>
        row.escrow === true &&
        // A row paired before the v2 payload has no rendezvous secret, so it
        // could not be reached after a restore either. It is re-paired, not
        // saved.
        Boolean(row.rendezvousSecret)
    )
    .sort((a, b) => a.addedAtMs - b.addedAtMs)
    .map((row) => ({
      siteId: row.siteId,
      label: row.label,
      boxStaticKey: row.boxStaticKey,
      rendezvousSecret: row.rendezvousSecret,
    }))
}

/** Mark, or unmark, one household. Writing the copy is a separate step. */
export async function markEscrowed(siteId: string, on: boolean): Promise<void> {
  const database = await db()
  const row = await database.get('sites', siteId)
  if (!row) return
  await database.put('sites', { ...row, escrow: on })
}

export async function isEscrowed(siteId: string): Promise<boolean> {
  const database = await db()
  return (await database.get('sites', siteId))?.escrow === true
}

// ---------------------------------------------------------------------------
// Writing the copy
// ---------------------------------------------------------------------------

export type SaveOutcome =
  /** Written, and the service confirmed the version. */
  | 'saved'
  /** No home is marked any more, so what was held has been taken away. */
  | 'cleared'
  /** No PRF on this passkey, so there is no id and no key. Nothing was sent. */
  | 'unsupported'
  /** The service could not be reached, or answered something unusable. */
  | 'unreachable'
  /** Something on this device went wrong — the vault, the disk. Not the network. */
  | 'failed'
  /**
   * Two devices wrote at once and this one lost twice. Reported rather than
   * retried forever: the other device's copy is a good copy, and the next save
   * on this one catches up.
   */
  | 'conflict'

/**
 * Put the marked homes into the escrow, replacing whatever was there.
 *
 * It reports rather than throws, for anything at all. A device with no sealed
 * copy is the device everyone had yesterday, and a pairing undone because a
 * spare copy could not be written would be worse than no spare.
 *
 * `wrapping` must have come from a passkey — the local fallback key derives no
 * escrow id, on purpose, because a copy sealed under a key that sits unwrapped
 * in IndexedDB is a copy anyone holding the phone could upload and later open.
 */
export async function saveEscrowCopy(
  store: VaultStore,
  wrapping: WrappingKey,
  opts: EscrowOptions = {},
  pendingHome?: RecoverableHome
): Promise<SaveOutcome> {
  const keys = wrapping.escrow
  if (!keys) return 'unsupported'

  try {
    const marked = await escrowedHomes()
    // Pairing has not marked its new home yet. Include it in this one write,
    // then let the caller mark it only after the service confirms the copy.
    // A crash can therefore leave a copy unmarked, but can never make the UI
    // claim Sourceful holds one that did not land.
    const homes = pendingHome
      ? [...marked.filter((home) => home.siteId !== pendingHome.siteId), pendingHome]
      : marked
    if (homes.length === 0) {
      // Every marked home is gone but the device key is still here. Leaving a
      // copy that opens nothing would offer the next fresh install an empty
      // house.
      return (await clearAt(keys, opts)) ? 'cleared' : 'conflict'
    }

    const scalar = await exportDeviceSecret(store, wrapping)
    try {
      // Written twice at most. The version is bound into the seal, so losing a
      // race means sealing again under the new number rather than resending
      // the same bytes with a different one — which is exactly the swap the
      // binding exists to refuse.
      for (let attempt = 0; attempt < 2; attempt++) {
        const held = await readHeld(keys.lookupId, opts)
        const version = (held?.version ?? 0) + 1
        const sealed = await sealRecoveryBlob(keys.sealKey, { deviceScalar: scalar, homes }, version)
        if (await put(keys, version, sealed, opts)) return 'saved'
      }
      return 'conflict'
    } finally {
      scalar.fill(0)
    }
  } catch (err) {
    // Told apart because the screen has to. "Try again when you are online" is
    // wrong and unanswerable for a vault this device cannot open, and that is
    // the failure that means the copy will never be written.
    return err instanceof EscrowError ? 'unreachable' : 'failed'
  }
}

export type RemoveOutcome =
  /**
   * There is nothing sealed under this id any more.
   *
   * Not "the row is gone": an id and a version number stay behind, because a
   * row that could be created again from scratch is a rollback guard with a
   * door in it. See clearAt below, and the residue named in escrow/README.md.
   */
  | 'removed'
  /** No household on this phone had asked for a copy. Nothing was asked of anyone. */
  | 'nothing-to-remove'
  /** The passkey prompt was declined. Asking again may get a different answer. */
  | 'declined'
  /** There is a copy out there and this phone could not reach it. */
  | 'kept'

/**
 * Take the copy away, the first thing a sign-out does.
 *
 * A copy that outlives a sign-out offers the next launch the home its owner
 * just left, which would make signing out a lie. So it goes first — and it
 * reports rather than throws, because a sign-out is the one thing in the app
 * that must never become impossible.
 *
 * It costs nothing at all when no household opted in: no passkey prompt, no
 * request, no import of anything. Someone who never turned this on is exactly
 * where they were before it existed, and a test holds it to that.
 */
export async function removeEscrowCopy(
  opts: EscrowOptions & { store?: VaultStore } = {}
): Promise<RemoveOutcome> {
  if ((await escrowedHomes()).length === 0) return 'nothing-to-remove'

  let wrapping: WrappingKey
  try {
    wrapping = await unlockWrappingKey(opts.store ?? openVaultStore())
  } catch (err) {
    // A decline is a choice; anything else is this phone unable to reach the
    // key, and both leave the copy where it is.
    return err instanceof DOMException &&
      (err.name === 'NotAllowedError' || err.name === 'AbortError')
      ? 'declined'
      : 'kept'
  }

  if (!wrapping.escrow) return 'kept'

  try {
    return (await clearAt(wrapping.escrow, opts)) ? 'removed' : 'kept'
  } catch {
    return 'kept'
  }
}

/**
 * Empty the copy, rather than delete the row.
 *
 * A delete would restart the version at 1, and an earlier blob really was
 * sealed under version 1 — so whoever kept one could write it straight back
 * and a household would be offered a home it had removed. Emptying keeps the
 * count going, which is what makes the guard hold at exactly the moment it
 * matters. escrow/src/escrow.ts carries the same argument from the other side.
 *
 * A row that was never written stays absent: there is nothing to roll back to,
 * and a household that never saved anything should leave nothing behind.
 */
async function clearAt(keys: EscrowKeys, opts: EscrowOptions): Promise<boolean> {
  for (let attempt = 0; attempt < 2; attempt++) {
    const held = await readHeld(keys.lookupId, opts)
    if (!held) return true
    if (held.blob.length === 0) return true
    if (await put(keys, held.version + 1, new Uint8Array(0), opts)) return true
  }
  return false
}

// ---------------------------------------------------------------------------
// Bringing a home back
// ---------------------------------------------------------------------------

/** A home the escrow was holding. `restore` is opaque to whatever shows it. */
export interface RecoveredHome {
  siteId: string
  label: string
  /** Six hex characters of the box key's digest, so two boxes look different. */
  fingerprint: string
  readonly restore: Restorable
}

interface Restorable {
  deviceScalar: Uint8Array
  /** From the same assertion, so adopting costs no second prompt. */
  wrapping: WrappingKey
  /**
   * Every home the copy was carrying, this one included.
   *
   * Adopting writes all of them. It looks like more than was asked for and it
   * is the opposite: the next write of the copy carries the homes on this
   * device, so a home left unwritten here is a box key and a rendezvous secret
   * that exist nowhere else and are gone the next time anything saves.
   */
  everyHome: readonly RecoverableHome[]
}

/**
 * One ceremony: one prompt, and it yields the id and the key at once.
 *
 * An empty array is the ordinary answer for a phone whose passkey has never
 * escrowed anything. It is not an error and must not be shown as one. A
 * decline throws, and `isUserCancelled` in ./prf tells the two apart.
 *
 * A copy that is there and will not open throws too, rather than joining the
 * empty case. The two look alike from here and are nothing alike on screen:
 * nothing held means scan the code, and a copy that will not open means
 * something replaced it — which is the residual risk this design accepts and
 * names.
 */
export async function recoverFromEscrow(opts: EscrowOptions = {}): Promise<RecoveredHome[]> {
  if (!webAuthnAvailable()) return []

  const assertion = (await navigator.credentials.get({
    publicKey: {
      challenge: crypto.getRandomValues(new Uint8Array(32)),
      rpId: opts.rpId ?? currentRpId(),
      // Empty on purpose. A fresh install knows no credential id, and the spec
      // allows an assertion without one.
      allowCredentials: [],
      userVerification: 'required',
      // One salt. The escrow's id and key are HKDF siblings of the vault key,
      // so a second evaluation here would separate them no better and would be
      // one more thing a platform can leave unanswered.
      extensions: { prf: { eval: { first: new TextEncoder().encode(PRF_SALTS.vault) } } },
    },
    ...(opts.signal ? { signal: opts.signal } : {}),
  })) as PublicKeyCredential | null

  if (!assertion) return []

  const prf = assertion.getClientExtensionResults().prf?.results?.first
  if (!prf) {
    throw new RecoveryBlobError(
      'the credential answered with no PRF output',
      'E_BLOB_LOCKED',
      "This browser cannot unlock what your passkey saved. Try opening the app in Safari, or open your box's local dashboard and use Settings → FTW app → Show pairing code."
    )
  }

  const credentialId = encodeBase64url(new Uint8Array(assertion.rawId))
  const wrapping = await toWrappingKey(credentialId, prf, 'vault')
  const keys = wrapping.escrow
  if (!keys) return []

  const held = await readHeld(keys.lookupId, opts)
  // Nothing held, and an emptied copy, are the same answer: there is no home
  // here and the code on the box is what comes next.
  if (!held || held.blob.length === 0) return []

  // The version the service reported is bound into the seal. A service that
  // handed back an older blob under a newer number gets a refusal here rather
  // than a household getting back a home it had removed.
  const blob = await openRecoveryBlob(keys.sealKey, held.blob, held.version)

  return Promise.all(
    blob.homes.map(async (home) => ({
      siteId: home.siteId,
      label: home.label,
      fingerprint: await boxFingerprint(home.boxStaticKey),
      restore: { deviceScalar: blob.deviceScalar, wrapping, everyHome: blob.homes },
    }))
  )
}

/**
 * Write a recovered home down, so the app can open it like any paired one.
 *
 * The device key is put back rather than minted: it is the Noise static the
 * box already trusts, which is why no pairing code is needed and none is
 * stored. It is wrapped under the local copy so that connecting stays silent,
 * and under the passkey that just answered so a privileged command still has a
 * PRF copy to unlock — both out of the one assertion.
 *
 * Every home in the copy is written and every one keeps its mark, because they
 * were all in the copy and the next save rebuilds it from what is on the disk.
 */
export async function adoptRecoveredHome(home: RecoveredHome): Promise<string> {
  const vault = openVaultStore()
  const local = await localWrappingKey(vault)
  await restoreDeviceKey(vault, local, home.restore.deviceScalar)
  await addCredential(vault, local, home.restore.wrapping)

  const database = await db()
  const now = Date.now()
  for (const each of home.restore.everyHome) {
    await database.put('sites', {
      siteId: each.siteId,
      label: each.label,
      boxStaticKey: each.boxStaticKey,
      rendezvousSecret: each.rendezvousSecret,
      escrow: true,
      addedAtMs: now,
      lastSeenAtMs: now,
    } satisfies StoredSite)
  }

  void requestPersistence()
  return home.siteId
}

// ---------------------------------------------------------------------------
// The wire
// ---------------------------------------------------------------------------

interface HeldBlob {
  version: number
  blob: Uint8Array
}

async function readHeld(lookupId: string, opts: EscrowOptions): Promise<HeldBlob | null> {
  const response = await request({ op: 'get', id: lookupId }, opts)
  if (response.status === 404) return null
  if (response.status !== 200) throw refused(response.status)

  const body = (await response.json()) as { version?: unknown; blob?: unknown }
  const blob = typeof body.blob === 'string' ? fromBase64(body.blob) : null
  // A sealed copy or an emptied one, and nothing in between. A short blob is
  // either a service that lost bytes or one that never padded, and reading a
  // home out of either is what the format's strictness exists to refuse.
  if (
    !Number.isInteger(body.version) ||
    !blob ||
    (blob.length !== RECOVERY_BLOB_MAX_BYTES && blob.length !== 0)
  ) {
    throw refused(response.status)
  }
  return { version: body.version as number, blob }
}

/**
 * The bytes a write is signed over.
 *
 * The escrow's copy is `writeMessage` in escrow/src/store.ts. It is spelled
 * again here rather than imported, because the app must not pull service code
 * into its bundle, and tests/escrow-e2e.test.ts drives one through the other so
 * the two spellings cannot drift into a household that can no longer save.
 *
 * The blob travels as a digest rather than as bytes, so the message is short
 * and the same shape whether a household is saving a copy or clearing one.
 */
function writeMessage(lookupId: string, version: number, blob: Uint8Array): Uint8Array {
  const digest = sha256(blob)
  let hex = ''
  for (const byte of digest) hex += byte.toString(16).padStart(2, '0')
  return new TextEncoder().encode(`ftw-escrow:v1:${lookupId}:${version}:${hex}`)
}

/**
 * True when it landed. False is a lost race and nothing else.
 *
 * Every write is signed under the passkey's own write key. Reading is the id
 * alone — a fresh install has nothing else — but a write that were the same
 * would let anyone who learned an id destroy that household's spare copy.
 */
async function put(
  keys: EscrowKeys,
  version: number,
  blob: Uint8Array,
  opts: EscrowOptions
): Promise<boolean> {
  const response = await request(
    {
      op: 'put',
      id: keys.lookupId,
      version,
      blob: toBase64(blob),
      pub: encodeBase64url(keys.writeKey),
      sig: encodeBase64url(keys.sign(writeMessage(keys.lookupId, version, blob))),
    },
    opts
  )
  if (response.status === 200) return true
  if (response.status === 409) return false
  throw refused(response.status)
}

/**
 * Every legal request body is exactly this long, and the service refuses any
 * other length.
 *
 * The app's copy of `ESCROW_REQUEST_BYTES`. It is written here rather than
 * imported because the app must not pull service code into its bundle, and
 * tests/escrow-e2e.test.ts pins the two numbers together the way
 * RECOVERY_BLOB_MAX_BYTES is pinned to ESCROW_BLOB_BYTES.
 */
const ESCROW_REQUEST_BYTES = 1024

/**
 * One request shape for all three operations: POST to one path, with the id in
 * the body, and one length for all of them.
 *
 * The id never appears in a URL, which is deliberate rather than tidy — a URL
 * is the part of a request every layer writes down, so an id in a path is an
 * id in somebody's log beside a timestamp, and "nothing beside it" would be
 * false in operation while the table stayed clean.
 *
 * The padding is the same argument about a number rather than a string, and it
 * was learned from a real leak: the proxy in front of the escrow kept a
 * request line with the URI, the headers and both addresses deleted, and the
 * byte counts left behind still said which of the three operations it was — a
 * put read 769 bytes, a read of a copy that was there 63, and one that was not
 * 63 with a 2-byte answer. So a get is padded up to the size of a put.
 * escrow/src/escrow.ts is the other half of the same argument, and
 * escrow/deploy/README.md lists every layer that could keep a time or a size
 * with how each one was checked.
 */
async function request(body: Record<string, unknown>, opts: EscrowOptions): Promise<Response> {
  const call = opts.fetch ?? globalThis.fetch
  try {
    return await call(`${opts.origin ?? ESCROW_ORIGIN}/e`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: pad(body, ESCROW_REQUEST_BYTES),
      // No cookies, no credentials, nothing an origin could be recognised by.
      credentials: 'omit',
      cache: 'no-store',
      ...(opts.signal ? { signal: opts.signal } : {}),
    })
  } catch (err) {
    throw new EscrowError(
      `the escrow could not be reached: ${String(err)}`,
      'E_ESCROW_UNREACHABLE',
      'The saved copy could not be reached. Your home works either way — try again when you are back online.'
    )
  }
}

/**
 * `body` as JSON, with a `pad` member that makes the whole exactly `bytes`.
 *
 * A member rather than trailing whitespace, so it survives anything that
 * re-serialises on the way past. The service's copy is `pad` in
 * escrow/src/escrow.ts and the two are driven through each other in a test.
 */
function pad(body: Record<string, unknown>, bytes: number): string {
  const empty = JSON.stringify({ ...body, pad: '' })
  return JSON.stringify({ ...body, pad: 'A'.repeat(bytes - empty.length) })
}

function refused(status: number): EscrowError {
  return new EscrowError(
    `the escrow answered ${status}`,
    'E_ESCROW_REFUSED',
    "The saved copy could not be read. Open your box's local dashboard, then Settings → FTW app → Show pairing code, and scan a new QR instead."
  )
}

function toBase64(bytes: Uint8Array): string {
  let binary = ''
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return btoa(binary)
}

function fromBase64(text: string): Uint8Array | null {
  try {
    const binary = atob(text)
    const out = new Uint8Array(binary.length)
    for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i)
    return out
  } catch {
    return null
  }
}
