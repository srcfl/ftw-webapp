/* Base64url, canonical only.
 *
 * The enrollment fragment carries a trust anchor — the box's static key,
 * arriving out of band. Two spellings of the same bytes would be two spellings
 * of one anchor, so decoding accepts exactly one form: no padding, no
 * whitespace, no alternate alphabet, and no non-zero bits past the last byte.
 * Anything else is rejected rather than tidied up.
 */

export class Base64urlError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'Base64urlError'
  }
}

const ALPHABET = /^[A-Za-z0-9_-]*$/

export function encodeBase64url(bytes: Uint8Array): string {
  let binary = ''
  for (const b of bytes) binary += String.fromCharCode(b)
  return btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replaceAll('=', '')
}

// The return type is spelled out because TypeScript models a bare Uint8Array
// as possibly backed by a SharedArrayBuffer, which WebCrypto refuses. This one
// allocates its own buffer, and saying so here saves a cast at every call.
export function decodeBase64url(text: string): Uint8Array<ArrayBuffer> {
  if (!ALPHABET.test(text)) {
    throw new Base64urlError('character outside the base64url alphabet')
  }
  // A single trailing character encodes six bits, which is not a whole byte.
  if (text.length % 4 === 1) {
    throw new Base64urlError(`length ${text.length} cannot encode whole bytes`)
  }

  const standard = text.replaceAll('-', '+').replaceAll('_', '/')
  const binary = atob(standard.padEnd(Math.ceil(standard.length / 4) * 4, '='))
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i)

  // atob discards the bits past the last whole byte instead of complaining, so
  // two different strings can decode to the same bytes. Re-encoding is the
  // cheapest way to insist on the canonical one.
  if (encodeBase64url(bytes) !== text) {
    throw new Base64urlError('not canonical: bits past the final byte are set')
  }

  return bytes
}
