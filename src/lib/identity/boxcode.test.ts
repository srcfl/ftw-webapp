/* The box code, held to the box's own arithmetic.
 *
 * The vectors below are not invented here. They came out of the box's encoder
 * — encodeSpoken in go/internal/appenroll/boxcode.go — run over fixed inputs,
 * and they are what stops the two implementations drifting apart. A decoder
 * that agrees with itself would pass a round-trip test written in this file
 * and still hand the box five bytes it never drew.
 *
 * The 0x10 0x84 0x21 0x08 0x42 vector is there for one reason: every one of
 * its eight five-bit groups is 2, so a decoder that packs the bits in the
 * wrong order still produces 22222222 and a round trip notices nothing.
 */

import { describe, it, expect } from 'vitest'
import {
  BOX_CODE_CHARS,
  BoxCodeError,
  decodeBoxCode,
  foldBoxCode,
  groupBoxCode,
} from './boxcode'

/** [what the box drew, what its screen shows]. From the Go encoder. */
const VECTORS: [string, string][] = [
  ['0000000000', '0000-0000'],
  ['ffffffffff', 'ZZZZ-ZZZZ'],
  ['0000000001', '0000-0001'],
  ['0123456789', '04HM-ASW9'],
  ['deadbeef42', 'VTPV-XVT2'],
  ['8f1c00a57b', 'HWE0-19BV'],
  ['1084210842', '2222-2222'],
]

function hex(bytes: Uint8Array): string {
  return [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('')
}

describe('a code read off the box', () => {
  it('decodes to the bytes the box drew', () => {
    for (const [bytes, code] of VECTORS) {
      expect(hex(decodeBoxCode(code)), `${code} is ${bytes} at the box`).toBe(bytes)
    }
  })

  it('is five bytes, whatever was typed', () => {
    for (const [, code] of VECTORS) {
      expect(decodeBoxCode(code)).toHaveLength(5)
    }
  })
})

/* The folding is the whole reason this code can be read down a phone.
 *
 * Five wrong tries burn the code at the box, so a typo the app could have
 * normalised must never cost an attempt. These are the ones a listener
 * actually makes.
 */
describe('what somebody writing down what they heard produces', () => {
  const SAME = '04HM-ASW9'

  it('reads I and L as 1, and O as 0', () => {
    // The box never draws I, L, O or U — so these can only be a listener's
    // hand, and folding them is not a guess. The literal is the Go decoder's
    // own answer for the same string, not this file's arithmetic repeated.
    expect(hex(decodeBoxCode('IO1L-0000'))).toBe('0802100000')
    expect(hex(decodeBoxCode('1011-0000'))).toBe('0802100000')
    // A different spelling of the same eight characters.
    expect(hex(decodeBoxCode('l0i1-oooo'))).toBe('0802100000')
  })

  it('does not care about case, the hyphen, or spaces', () => {
    const want = hex(decodeBoxCode(SAME))
    for (const typed of ['04hm-asw9', '04HMASW9', '04 HM AS W9', ' 04hm asw9 ', '04HM\tASW9']) {
      expect(hex(decodeBoxCode(typed)), `${typed} is the same code`).toBe(want)
    }
  })

  it('refuses a character that is not in the alphabet, rather than skipping it', () => {
    // U is left out of Crockford on purpose, and a ! is somebody reading the
    // wrong line. Salvaging eight good characters from around either would
    // send the box a code nobody meant to give.
    expect(() => decodeBoxCode('UUUU-UUUU')).toThrow(BoxCodeError)
    expect(() => decodeBoxCode('04HM-ASW!')).toThrow(BoxCodeError)
    expect(() => decodeBoxCode('04HM_ASW9')).toThrow(BoxCodeError)
  })

  it('refuses the wrong number of characters', () => {
    expect(() => decodeBoxCode('')).toThrow(BoxCodeError)
    expect(() => decodeBoxCode('04HM-ASW')).toThrow(BoxCodeError)
    expect(() => decodeBoxCode('04HM-ASW90')).toThrow(BoxCodeError)
  })

  it('says what to do rather than what failed', () => {
    try {
      decodeBoxCode('nope')
      expect.unreachable('a four-character code was accepted')
    } catch (err) {
      expect((err as BoxCodeError).help).toMatch(/eight characters/i)
      // Never a validation name, never a count of bytes.
      expect((err as BoxCodeError).help).not.toMatch(/expected|invalid|error/i)
    }
  })
})

describe('the field somebody types into', () => {
  it('folds as they type, so the box’s 1 and their I look the same', () => {
    expect(foldBoxCode('io1l')).toBe('1011')
    expect(foldBoxCode('04hm-asw9')).toBe('04HMASW9')
  })

  it('drops what it cannot use rather than fighting a half-typed code', () => {
    expect(foldBoxCode('04!hm')).toBe('04HM')
    expect(foldBoxCode('')).toBe('')
  })

  it('stops at eight, so a stuck key cannot push the code off the front', () => {
    expect(foldBoxCode('04HMASW9ZZZZ')).toHaveLength(BOX_CODE_CHARS)
    expect(foldBoxCode('04HMASW9ZZZZ')).toBe('04HMASW9')
  })

  it('groups the way the box shows it', () => {
    expect(groupBoxCode('04HMASW9')).toBe('04HM-ASW9')
    // Nothing to group yet: a hyphen before the fifth character would appear
    // under the cursor as somebody types.
    expect(groupBoxCode('04HM')).toBe('04HM')
    expect(groupBoxCode('04HMA')).toBe('04HM-A')
  })
})
