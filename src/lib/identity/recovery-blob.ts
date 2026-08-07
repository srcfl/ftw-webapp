/* The sealed copy of a household, and nothing about where it is kept.
 *
 * This file owns one thing: the bytes. What a home costs, how they are laid
 * out, how they are sealed and how strictly they are read back. Where the
 * sealed bytes go afterwards is $lib/identity/escrow's business, and keeping
 * the two apart is deliberate — the format was already right when it was
 * written for a passkey's own storage, and it is the same format now that
 * Sourceful holds the copy instead.
 *
 * WHAT THE SEAL BUYS, PRECISELY.
 *
 *   It resists whoever holds the ciphertext. The payload is AES-GCM under a
 *   key derived from WebAuthn PRF output, and PRF output only exists after an
 *   authenticator ceremony with user verification. Sourceful holds ciphertext
 *   and an opaque id; there is no key in the service and no path by which one
 *   could arrive.
 *
 *   It does not resist anyone who can complete that ceremony. A device signed
 *   into the account with the passkey available, an account recovery at the
 *   platform vendor, an unlocked phone in the wrong hands: each of those
 *   brings the home back. That is the trade this feature is, and the opt-in
 *   screen says it in one sentence rather than burying it here.
 *
 *   And it is the house, not a copy of the house. The blob carries the Noise
 *   static the box authenticates, so restoring it *is* this device rather than
 *   a new one asking to be let in: there is no pairing step for anyone to
 *   notice. Only the box can end that, by revoking the device.
 *
 * WHY THE PADDING IS NOT DECORATION. Unsealed, a payload is exactly as long as
 * the homes inside it, so whoever holds the ciphertext counts a household's
 * homes without opening anything. Every blob is written at exactly
 * RECOVERY_BLOB_MAX_BYTES and the escrow refuses any other length. It is the
 * same leak lane 0 pads against on the wire, for the same reason.
 */

import { BOX_KEY_BYTES, RENDEZVOUS_SECRET_BYTES } from './enrollment'

/** The X25519 scalar. Not a choice — it is what Noise needs to be this device. */
const SCALAR_BYTES = 32

/**
 * The one length every sealed blob is written at.
 *
 * One home costs 66 bytes plus its id and its name — 86 for a site id and
 * "Home". The fixed cost is 33 for the device key and the count, so five homes
 * with ordinary names still fit inside the payload budget below.
 *
 * The escrow refuses a blob of any other length, and a test pins its constant
 * to this one.
 */
export const RECOVERY_BLOB_MAX_BYTES = 512

/**
 * The layout, version 2.
 *
 * Sealed:  [version 1 B][nonce 12 B][ciphertext + tag]
 *
 * Plain:   [device scalar 32 B][home count 1 B]
 *          then per home: [id length 1 B][id][name length 1 B][name]
 *                         [box static key 32 B][rendezvous secret 32 B]
 *          then zeroes, out to RECOVERY_BLOB_PLAIN_BYTES.
 *
 * Additional data: [version 1 B][escrow version 4 B, big-endian]
 *
 *   The format version is outside the seal so a future layout can be
 *   recognised without a key, and bound in as additional data so it cannot be
 *   swapped for one whose rules are looser.
 *
 *   The escrow version is bound in for a different job, and it is the one that
 *   makes the rollback guard worth having. The service has to read the version
 *   with no key, so it travels beside the blob rather than inside it — which
 *   on its own would let the service pair an old blob with a new number and
 *   hand a household back a home it had removed. Bound in as additional data,
 *   that swap fails to decrypt on this side. Version 2 is version 1 plus these
 *   four bytes; a blob that is not escrowed carries zero.
 *
 * The pairing code is deliberately absent: it was spent at the first
 * handshake, and the box remembers this device key instead. Carrying it would
 * put a code the box has already refused into a handshake that does not need
 * one.
 */
export const RECOVERY_BLOB_VERSION = 2

/** No escrow behind this blob. Reserved so a version is never absent. */
export const ESCROW_VERSION_NONE = 0

const NONCE_BYTES = 12
const HEADER_BYTES = 1 + NONCE_BYTES
const TAG_BYTES = 16
const AAD_BYTES = 1 + 4

export const RECOVERY_BLOB_PLAIN_BYTES = RECOVERY_BLOB_MAX_BYTES - HEADER_BYTES - TAG_BYTES

/**
 * How much of a home's name travels.
 *
 * The name is for telling two homes apart on the screen that offers them back,
 * not a record of anything — the box holds that. Cutting it here keeps a long
 * name from quietly costing another home its place in the blob.
 */
export const MAX_NAME_CHARS = 32

export interface RecoverableHome {
  siteId: string
  label: string
  /** The box's static Noise key. The trust anchor, pinned optically once. */
  boxStaticKey: Uint8Array
  /** Long-lived; the rotating relay handle is derived from it and only from it. */
  rendezvousSecret: Uint8Array
}

export interface RecoveryBlob {
  /**
   * The device's Noise static, raw.
   *
   * Live key material, and nothing here takes it back: it lives as long as
   * whatever opened the blob holds on to it, which for a recovery is the
   * screen offering the homes until one is adopted. Said rather than promised
   * away — the fallback path in ./vault keeps the same scalar in JS memory for
   * the life of the device key, so a line here about zeroing it would buy
   * nothing and would not be true of the copies beside it.
   */
  deviceScalar: Uint8Array
  homes: RecoverableHome[]
}

export type RecoveryBlobErrorCode = 'E_BLOB_FORMAT' | 'E_BLOB_LOCKED' | 'E_BLOB_TOO_BIG'

export class RecoveryBlobError extends Error {
  constructor(
    message: string,
    readonly code: RecoveryBlobErrorCode,
    /** What the user does now. Never what broke inside. */
    readonly help: string
  ) {
    super(message)
    this.name = 'RecoveryBlobError'
  }
}

// ---------------------------------------------------------------------------
// The format
// ---------------------------------------------------------------------------

export function encodeRecoveryBlob(blob: RecoveryBlob): Uint8Array<ArrayBuffer> {
  if (blob.deviceScalar.length !== SCALAR_BYTES) {
    throw format(`device key is ${blob.deviceScalar.length} bytes, expected ${SCALAR_BYTES}`)
  }
  if (blob.homes.length > 0xff) {
    throw format(`${blob.homes.length} homes, and the count is one byte`)
  }

  const encoder = new TextEncoder()
  const homes = blob.homes.map((home) => {
    if (home.boxStaticKey.length !== BOX_KEY_BYTES) {
      throw format(`box key is ${home.boxStaticKey.length} bytes, expected ${BOX_KEY_BYTES}`)
    }
    if (home.rendezvousSecret.length !== RENDEZVOUS_SECRET_BYTES) {
      throw format(
        `rendezvous secret is ${home.rendezvousSecret.length} bytes, expected ${RENDEZVOUS_SECRET_BYTES}`
      )
    }
    const siteId = encoder.encode(home.siteId)
    const label = encoder.encode(cutToCharacters(home.label, MAX_NAME_CHARS))
    if (siteId.length > 0xff || label.length > 0xff) throw format('a name is longer than a byte')
    return { siteId, label, home }
  })

  let size = SCALAR_BYTES + 1
  for (const { siteId, label } of homes) {
    size += 1 + siteId.length + 1 + label.length + BOX_KEY_BYTES + RENDEZVOUS_SECRET_BYTES
  }
  if (size > RECOVERY_BLOB_PLAIN_BYTES) {
    throw new RecoveryBlobError(
      `payload is ${size} bytes and the budget is ${RECOVERY_BLOB_PLAIN_BYTES}`,
      'E_BLOB_TOO_BIG',
      'There are more homes on this phone than a saved copy can carry. They all still work here.'
    )
  }

  // Padded, not merely sized: the length of what is written is the one thing
  // about it the service can read without a key. See RECOVERY_BLOB_PLAIN_BYTES.
  const out = new Uint8Array(RECOVERY_BLOB_PLAIN_BYTES)
  let at = 0
  out.set(blob.deviceScalar, at)
  at += SCALAR_BYTES
  out[at++] = homes.length
  for (const { siteId, label, home } of homes) {
    out[at++] = siteId.length
    out.set(siteId, at)
    at += siteId.length
    out[at++] = label.length
    out.set(label, at)
    at += label.length
    out.set(home.boxStaticKey, at)
    at += BOX_KEY_BYTES
    out.set(home.rendezvousSecret, at)
    at += RENDEZVOUS_SECRET_BYTES
  }
  return out
}

/**
 * Strict on the way in. Anything short, long or unaccounted for is refused
 * rather than read half-way: a home assembled from bytes that were not ours is
 * a box key nothing will ever answer, offered to someone as their house.
 */
export function decodeRecoveryBlob(plain: Uint8Array): RecoveryBlob {
  if (plain.length !== RECOVERY_BLOB_PLAIN_BYTES) {
    throw format(
      `payload is ${plain.length} bytes, and every one we write is ${RECOVERY_BLOB_PLAIN_BYTES}`
    )
  }

  const deviceScalar = plain.slice(0, SCALAR_BYTES)
  let at = SCALAR_BYTES
  const count = plain[at++]!
  const decoder = new TextDecoder()
  const homes: RecoverableHome[] = []

  for (let i = 0; i < count; i++) {
    const siteId = decoder.decode(readSlice())
    const label = decoder.decode(readSlice())
    if (at + BOX_KEY_BYTES + RENDEZVOUS_SECRET_BYTES > plain.length) {
      throw format('payload ends in the middle of a home')
    }
    const boxStaticKey = plain.slice(at, at + BOX_KEY_BYTES)
    at += BOX_KEY_BYTES
    const rendezvousSecret = plain.slice(at, at + RENDEZVOUS_SECRET_BYTES)
    at += RENDEZVOUS_SECRET_BYTES
    homes.push({ siteId, label, boxStaticKey, rendezvousSecret })
  }

  // The tail is padding and has to look like it. Anything else is a payload
  // this app did not write, and reading the homes out of it anyway is the one
  // thing this decoder exists to refuse.
  for (let i = at; i < plain.length; i++) {
    if (plain[i] !== 0) throw format(`${plain.length - at} bytes after the last home, not padding`)
  }
  return { deviceScalar, homes }

  function readSlice(): Uint8Array {
    if (at >= plain.length) throw format('payload ends in the middle of a home')
    const length = plain[at++]!
    if (at + length > plain.length) throw format('payload ends in the middle of a name')
    const bytes = plain.slice(at, at + length)
    at += length
    return bytes
  }
}

/**
 * The bytes that are bound into the seal without being sealed by it.
 *
 * Exported so a test can go at the ciphertext with the right key and the wrong
 * additional data. A binding checked only through the public API is a binding
 * whose absence no test can see — the version check above `open` would throw
 * either way.
 */
export function recoveryBlobAad(escrowVersion: number): Uint8Array<ArrayBuffer> {
  const aad = new Uint8Array(AAD_BYTES)
  aad[0] = RECOVERY_BLOB_VERSION
  new DataView(aad.buffer).setUint32(1, escrowVersion, false)
  return aad
}

export async function sealRecoveryBlob(
  key: CryptoKey,
  blob: RecoveryBlob,
  escrowVersion: number
): Promise<Uint8Array<ArrayBuffer>> {
  const plain = encodeRecoveryBlob(blob)
  const out = new Uint8Array(HEADER_BYTES + plain.length + TAG_BYTES)
  out[0] = RECOVERY_BLOB_VERSION
  const nonce = crypto.getRandomValues(out.subarray(1, HEADER_BYTES))
  try {
    const ct = await crypto.subtle.encrypt(
      { name: 'AES-GCM', iv: nonce, additionalData: recoveryBlobAad(escrowVersion) },
      key,
      plain
    )
    out.set(new Uint8Array(ct), HEADER_BYTES)
    return out
  } finally {
    plain.fill(0)
  }
}

/**
 * Open a sealed blob, or say why it will not open.
 *
 * `escrowVersion` is what the holder of the ciphertext said it was. If that is
 * not the number the blob was sealed under, this refuses — which is the whole
 * defence against a service that pairs old ciphertext with a fresh version.
 */
export async function openRecoveryBlob(
  key: CryptoKey,
  sealed: Uint8Array,
  escrowVersion: number
): Promise<RecoveryBlob> {
  if (sealed.length <= HEADER_BYTES) throw format('blob is too short to be sealed')
  if (sealed[0] !== RECOVERY_BLOB_VERSION) {
    throw format(`blob version ${sealed[0]}, and this app writes ${RECOVERY_BLOB_VERSION}`)
  }

  let plain: Uint8Array
  try {
    plain = new Uint8Array(
      // Copied rather than cast: WebCrypto refuses a view whose buffer
      // TypeScript thinks might be shared, and the whole blob is 512 bytes.
      await crypto.subtle.decrypt(
        {
          name: 'AES-GCM',
          iv: new Uint8Array(sealed.subarray(1, HEADER_BYTES)),
          additionalData: recoveryBlobAad(escrowVersion),
        },
        key,
        new Uint8Array(sealed.subarray(HEADER_BYTES))
      )
    )
  } catch {
    throw new RecoveryBlobError(
      'the derived key does not open this blob under that version',
      'E_BLOB_LOCKED',
      'The saved copy of this home could not be opened. Scan the code on your box instead.'
    )
  }

  try {
    return decodeRecoveryBlob(plain)
  } finally {
    plain.fill(0)
  }
}

// ---------------------------------------------------------------------------

/**
 * Cut a name to whole characters.
 *
 * Not `slice`, which counts UTF-16 code units: a cut landing between the two
 * halves of an emoji keeps one of them, and a lone half encodes to exactly the
 * replacement character that cutting by characters was meant to avoid. The
 * spread iterates code points, so the cut always falls between whole ones.
 */
function cutToCharacters(name: string, max: number): string {
  return [...name].slice(0, max).join('')
}

function format(message: string): RecoveryBlobError {
  return new RecoveryBlobError(
    message,
    'E_BLOB_FORMAT',
    'The saved copy of this home could not be read. Scan the code on your box instead.'
  )
}
