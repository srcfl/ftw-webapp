/* The enrollment payload.
 *
 *   https://app.ftw.energy/p#v1.<box_noise_pub>.<pairing_code>.<lan_hint>
 *
 * Everything after the `#` is a URL fragment, and a fragment is never sent in
 * an HTTP request. That is the whole design: the trust anchor reaches the app
 * optically and reaches no server on the way, so a hostile or compelled cloud
 * can deny service but cannot impersonate a box. Nothing here may ever move
 * into the path or the query.
 *
 * Enrollment is the first thing anyone does with this app and it has to be two
 * taps — scan, Face ID, done. So the errors say what the user does next, and
 * never which check failed.
 *
 * See docs/architecture.md, "Identity".
 */

import { decodeBase64url, encodeBase64url, Base64urlError } from './base64url'

export const ENROLLMENT_VERSION = 'v1'
export const ENROLLMENT_HOST = 'app.ftw.energy'
export const ENROLLMENT_PATH = '/p'

export const BOX_KEY_BYTES = 32
export const PAIRING_CODE_BYTES = 16

/** A real box's hint is a host and a port. This is a bound, not a budget. */
export const MAX_LAN_HINT_CHARS = 64

export interface Enrollment {
  /** The box's Noise static public key. The trust anchor, out of band. */
  boxStaticPublic: Uint8Array
  /** Single use — the box refuses it a second time. Never log this. */
  pairingCode: Uint8Array
  /** Where the box believes it can be reached on the LAN. Empty when it has no idea. */
  lanHint: string
}

export type EnrollmentErrorCode =
  | 'E_QR_NOT_FTW'
  | 'E_QR_VERSION'
  | 'E_QR_SHAPE'
  | 'E_QR_ENCODING'
  | 'E_QR_KEY'
  | 'E_QR_CODE'
  | 'E_QR_HINT'

export class EnrollmentError extends Error {
  constructor(
    message: string,
    readonly code: EnrollmentErrorCode,
    /** What the user does now. Never what broke inside. */
    readonly help: string
  ) {
    super(message)
    this.name = 'EnrollmentError'
  }
}

const SCAN_AGAIN = 'That code did not read cleanly. Hold the phone steady and scan it again.'
const WRONG_CODE = 'That is not an FTW pairing code. Scan the code on the box itself.'
const APP_TOO_OLD = 'This box needs a newer version of the app. Update the app, then scan again.'

export function parseEnrollmentUrl(raw: string): Enrollment {
  let url: URL
  try {
    url = new URL(raw)
  } catch {
    throw new EnrollmentError(`not a URL: ${raw.slice(0, 24)}`, 'E_QR_NOT_FTW', WRONG_CODE)
  }

  if (url.protocol !== 'https:' && !isLocalDev(url.hostname)) {
    throw new EnrollmentError(`scheme ${url.protocol} is not https`, 'E_QR_NOT_FTW', WRONG_CODE)
  }
  if (url.hostname !== ENROLLMENT_HOST && !isLocalDev(url.hostname)) {
    throw new EnrollmentError(`host ${url.hostname} is not FTW`, 'E_QR_NOT_FTW', WRONG_CODE)
  }
  if (url.pathname !== ENROLLMENT_PATH) {
    throw new EnrollmentError(
      `path ${url.pathname} is not ${ENROLLMENT_PATH}`,
      'E_QR_NOT_FTW',
      WRONG_CODE
    )
  }

  return parseEnrollmentFragment(url.hash)
}

/** Takes `location.hash`, with or without its leading `#`. */
export function parseEnrollmentFragment(fragment: string): Enrollment {
  const body = fragment.startsWith('#') ? fragment.slice(1) : fragment
  if (body === '') {
    throw new EnrollmentError('empty fragment', 'E_QR_NOT_FTW', WRONG_CODE)
  }

  const parts = body.split('.')
  const version = parts[0]!

  // Version before shape: a v2 payload with five segments is an old app
  // meeting a new box, and "update the app" is the answer, not "scan again".
  if (version !== ENROLLMENT_VERSION) {
    if (/^v\d+$/.test(version)) {
      throw new EnrollmentError(`payload version ${version}`, 'E_QR_VERSION', APP_TOO_OLD)
    }
    throw new EnrollmentError(`fragment does not start with a version`, 'E_QR_NOT_FTW', WRONG_CODE)
  }

  if (parts.length !== 4) {
    throw new EnrollmentError(`${parts.length} segments, expected 4`, 'E_QR_SHAPE', SCAN_AGAIN)
  }

  const boxStaticPublic = decodeSegment(parts[1]!, 'box key')
  const pairingCode = decodeSegment(parts[2]!, 'pairing code')
  const lanHint = new TextDecoder().decode(decodeSegment(parts[3]!, 'lan hint'))

  if (boxStaticPublic.length !== BOX_KEY_BYTES) {
    throw new EnrollmentError(
      `box key is ${boxStaticPublic.length} bytes, expected ${BOX_KEY_BYTES}`,
      'E_QR_KEY',
      SCAN_AGAIN
    )
  }
  if (pairingCode.length !== PAIRING_CODE_BYTES) {
    throw new EnrollmentError(
      `pairing code is ${pairingCode.length} bytes, expected ${PAIRING_CODE_BYTES}`,
      'E_QR_CODE',
      SCAN_AGAIN
    )
  }
  // The hint becomes a connection target later, so it is checked here rather
  // than trusted there.
  if (lanHint.length > MAX_LAN_HINT_CHARS || !/^[\x21-\x7e]*$/.test(lanHint)) {
    throw new EnrollmentError(`lan hint is not a plain address`, 'E_QR_HINT', SCAN_AGAIN)
  }

  return { boxStaticPublic, pairingCode, lanHint }
}

/** The inverse, for the box simulator and for round-trip tests. */
export function buildEnrollmentUrl(enrollment: Enrollment, origin?: string): string {
  const fragment = [
    ENROLLMENT_VERSION,
    encodeBase64url(enrollment.boxStaticPublic),
    encodeBase64url(enrollment.pairingCode),
    encodeBase64url(new TextEncoder().encode(enrollment.lanHint)),
  ].join('.')

  return `${origin ?? `https://${ENROLLMENT_HOST}`}${ENROLLMENT_PATH}#${fragment}`
}

// ---------------------------------------------------------------------------

function decodeSegment(segment: string, what: string): Uint8Array {
  try {
    return decodeBase64url(segment)
  } catch (err) {
    if (err instanceof Base64urlError) {
      throw new EnrollmentError(`${what}: ${err.message}`, 'E_QR_ENCODING', SCAN_AGAIN)
    }
    throw err
  }
}

/**
 * So the box simulator can hand out a scannable URL during development.
 *
 * Compiled out of production builds. Left in, it accepted any hostname ending
 * in '.localhost' over plain http — so app.ftw.energy.attacker.localhost
 * parsed clean in a shipped bundle. That does not by itself defeat the pin,
 * since the real defence is that the user scanned the box in front of them,
 * but it removed the one shape check in front of a hostile QR while reading
 * as though the check were enforced.
 */
function isLocalDev(hostname: string): boolean {
  if (!import.meta.env.DEV) return false
  return hostname === 'localhost' || hostname === '127.0.0.1' || hostname.endsWith('.localhost')
}
