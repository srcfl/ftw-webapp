import { describe, it, expect } from 'vitest'
import {
  parseEnrollmentUrl,
  parseEnrollmentFragment,
  buildEnrollmentUrl,
  EnrollmentError,
  ENROLLMENT_HOST,
  type Enrollment,
  type EnrollmentErrorCode,
} from './enrollment'
import { encodeBase64url } from './base64url'

const boxKey = new Uint8Array(32).fill(7)
const pairingCode = new Uint8Array(16).fill(9)
const rendezvousSecret = new Uint8Array(32).fill(11)

const payload: Enrollment = {
  boxStaticPublic: boxKey,
  pairingCode,
  lanHint: '192.168.1.42:8443',
  rendezvousSecret,
}

const fragment = (
  version = 'v2',
  key = encodeBase64url(boxKey),
  code = encodeBase64url(pairingCode),
  hint = encodeBase64url(new TextEncoder().encode('192.168.1.42:8443')),
  secret = encodeBase64url(rendezvousSecret)
) => [version, key, code, hint, secret].join('.')

function codeOf(fn: () => unknown): EnrollmentErrorCode {
  try {
    fn()
  } catch (err) {
    expect(err).toBeInstanceOf(EnrollmentError)
    return (err as EnrollmentError).code
  }
  throw new Error('expected a throw')
}

describe('the fragment never reaches a server', () => {
  // The whole trust argument rests on this. A pairing code in a query string
  // would be in the cloud's access log before the user finished blinking.
  it('puts every secret after the #', () => {
    const url = new URL(buildEnrollmentUrl(payload))

    expect(url.search).toBe('')
    expect(url.pathname).toBe('/p')
    expect(url.hash).toContain(encodeBase64url(pairingCode))
    expect(url.hash).toContain(encodeBase64url(rendezvousSecret))
    expect(`${url.origin}${url.pathname}`).not.toContain(encodeBase64url(pairingCode))
    expect(`${url.origin}${url.pathname}`).not.toContain(encodeBase64url(rendezvousSecret))
  })

  it('round trips through the QR text', () => {
    const parsed = parseEnrollmentUrl(buildEnrollmentUrl(payload))

    expect(parsed.boxStaticPublic).toEqual(boxKey)
    expect(parsed.pairingCode).toEqual(pairingCode)
    expect(parsed.lanHint).toBe('192.168.1.42:8443')
    expect(parsed.rendezvousSecret).toEqual(rendezvousSecret)
  })

  it('reads location.hash with or without the leading #', () => {
    expect(parseEnrollmentFragment(`#${fragment()}`).lanHint).toBe('192.168.1.42:8443')
    expect(parseEnrollmentFragment(fragment()).lanHint).toBe('192.168.1.42:8443')
  })
})

describe('what the QR is allowed to be', () => {
  it('accepts a box with no LAN hint', () => {
    const parsed = parseEnrollmentFragment(fragment('v2', undefined, undefined, ''))
    expect(parsed.lanHint).toBe('')
    expect(parsed.boxStaticPublic).toEqual(boxKey)
  })

  it('accepts a dev origin, so the simulator can hand out a scannable URL', () => {
    const url = buildEnrollmentUrl(payload, 'http://localhost:5173')
    expect(parseEnrollmentUrl(url).pairingCode).toEqual(pairingCode)
  })

  it('rejects another host wearing the same shape', () => {
    expect(codeOf(() => parseEnrollmentUrl(`https://evil.example/p#${fragment()}`))).toBe(
      'E_QR_NOT_FTW'
    )
  })

  it('rejects plain http on the real host', () => {
    expect(codeOf(() => parseEnrollmentUrl(`http://${ENROLLMENT_HOST}/p#${fragment()}`))).toBe(
      'E_QR_NOT_FTW'
    )
  })

  it('rejects a QR that is not a URL at all', () => {
    expect(codeOf(() => parseEnrollmentUrl('WIFI:S=Home;T=WPA;P=hunter2;;'))).toBe('E_QR_NOT_FTW')
  })

  it('rejects the right path but an empty fragment', () => {
    expect(codeOf(() => parseEnrollmentUrl(`https://${ENROLLMENT_HOST}/p`))).toBe('E_QR_NOT_FTW')
  })
})

describe('every way the payload can be wrong', () => {
  it('tells a newer box from a damaged scan', () => {
    // These two need different answers: one is "update the app", the other is
    // "scan again", and guessing wrong sends the user round a loop.
    expect(codeOf(() => parseEnrollmentFragment(fragment('v3')))).toBe('E_QR_VERSION')
    expect(codeOf(() => parseEnrollmentFragment(fragment('x1')))).toBe('E_QR_NOT_FTW')
  })

  it('rejects a rendezvous secret of the wrong length', () => {
    const short = encodeBase64url(new Uint8Array(16).fill(11))
    expect(
      codeOf(() => parseEnrollmentFragment(fragment('v2', undefined, undefined, undefined, short)))
    ).toBe('E_QR_SECRET')
  })

  it('rejects a truncated payload', () => {
    expect(codeOf(() => parseEnrollmentFragment('v2.' + encodeBase64url(boxKey)))).toBe('E_QR_SHAPE')
    expect(codeOf(() => parseEnrollmentFragment(fragment() + '.extra'))).toBe('E_QR_SHAPE')
  })

  it('rejects padded base64', () => {
    const padded = encodeBase64url(boxKey) + '='
    expect(codeOf(() => parseEnrollmentFragment(fragment('v2', padded)))).toBe('E_QR_ENCODING')
  })

  it('rejects the standard base64 alphabet', () => {
    const standard = btoa(String.fromCharCode(...new Uint8Array(32).fill(0xfb)))
      .replaceAll('=', '')
    expect(standard).toContain('+')
    expect(codeOf(() => parseEnrollmentFragment(fragment('v2', standard)))).toBe('E_QR_ENCODING')
  })

  it('rejects non-canonical trailing bits', () => {
    // 32 bytes need 43 characters, which carry 258 bits. The last two are
    // padding and must be zero — one anchor gets exactly one spelling.
    const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_'
    const canonical = encodeBase64url(boxKey)
    const dirty = canonical.slice(0, -1) + alphabet[alphabet.indexOf(canonical.at(-1)!) | 0b11]

    expect(dirty).not.toBe(canonical)
    expect(codeOf(() => parseEnrollmentFragment(fragment('v2', dirty)))).toBe('E_QR_ENCODING')
  })

  it('rejects a length that cannot be whole bytes', () => {
    expect(codeOf(() => parseEnrollmentFragment(fragment('v2', 'A')))).toBe('E_QR_ENCODING')
  })

  it('rejects a box key of the wrong length', () => {
    const short = encodeBase64url(new Uint8Array(31).fill(7))
    expect(codeOf(() => parseEnrollmentFragment(fragment('v2', short)))).toBe('E_QR_KEY')

    const long = encodeBase64url(new Uint8Array(33).fill(7))
    expect(codeOf(() => parseEnrollmentFragment(fragment('v2', long)))).toBe('E_QR_KEY')
  })

  it('rejects a pairing code of the wrong length', () => {
    const short = encodeBase64url(new Uint8Array(8).fill(9))
    expect(codeOf(() => parseEnrollmentFragment(fragment('v2', undefined, short)))).toBe('E_QR_CODE')
  })

  it('rejects a LAN hint that is not a plain address', () => {
    const control = encodeBase64url(new TextEncoder().encode('192.168.1.1\n:80'))
    expect(codeOf(() => parseEnrollmentFragment(fragment('v2', undefined, undefined, control)))).toBe(
      'E_QR_HINT'
    )

    const long = encodeBase64url(new TextEncoder().encode('a'.repeat(65)))
    expect(codeOf(() => parseEnrollmentFragment(fragment('v2', undefined, undefined, long)))).toBe(
      'E_QR_HINT'
    )
  })
})

describe('what the user is told', () => {
  it('says what to do next, not which check failed', () => {
    const help = (f: () => unknown) => {
      try {
        f()
      } catch (err) {
        return (err as EnrollmentError).help
      }
      throw new Error('expected a throw')
    }

    // Which side is behind decides the sentence. A v1 box is old firmware
    // meeting this app; a v3 payload is this app meeting a newer box. Telling
    // someone to update the wrong thing sends them round a loop.
    expect(help(() => parseEnrollmentFragment(fragment('v3')))).toMatch(/update the app/i)
    expect(help(() => parseEnrollmentFragment(fragment('v1')))).toMatch(/update the box/i)
    expect(help(() => parseEnrollmentFragment(fragment('v2', 'A')))).toMatch(/scan it again/i)
    expect(help(() => parseEnrollmentUrl('https://evil.example/p#x'))).toMatch(/code on the box/i)

    // No error prose leaks a field name, a length or a byte count.
    for (const f of [
      () => parseEnrollmentFragment(fragment('v3')),
      () => parseEnrollmentFragment(fragment('v1')),
      () => parseEnrollmentFragment(fragment('v2', 'A')),
      () => parseEnrollmentFragment(fragment('v2', encodeBase64url(new Uint8Array(31)))),
    ]) {
      expect(help(f)).not.toMatch(/base64|byte|segment|canonical|null|undefined/i)
    }
  })
})
