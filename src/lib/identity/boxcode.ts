/* The box code: eight characters somebody reads out loud.
 *
 * The box shows XXXX-XXXX on its own screen and says "read this out". This is
 * the other end of that sentence — what the listener types, turned back into
 * the five bytes the box drew. Those bytes go in Noise handshake message 1,
 * exactly where a scanned code's bytes go, so nothing on the wire changes.
 *
 * The alphabet is Crockford base32 and the folding is not a nicety. Somebody
 * writing down what they hear will put an I where the box drew a 1 and an O
 * where it drew a 0, and five wrong tries burn the code at the box. So every
 * fold happens here, before a single attempt is spent — a typo this file could
 * have normalised must never cost the household its code.
 *
 * This mirrors DecodeSpokenCode in go/internal/appenroll/boxcode.go, which is
 * the box's copy of the same rule. The two are held together by the vectors in
 * boxcode.test.ts, which were produced by running the Go encoder.
 */

/** Forty bits. See SpokenCodeBytes in the box's boxcode.go. */
export const BOX_CODE_BYTES = 5

/** Forty bits divides by five exactly, so there is no padding to explain. */
export const BOX_CODE_CHARS = 8

/**
 * Crockford base32, without I, L, O — the characters people mishear — and
 * without U, so a random draw cannot spell something a household would rather
 * not read to their neighbour.
 */
const ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ'

/** What a listener may type that carries no meaning: the grouping and spacing. */
const IGNORED = ' -\t'

export class BoxCodeError extends Error {
  constructor(
    message: string,
    /** What the user does now. Never what broke inside. */
    readonly help: string
  ) {
    super(message)
    this.name = 'BoxCodeError'
  }
}

const NOT_A_CODE =
  'That is not a code from your box. It is eight characters, like 04HM-ASW9.'

/**
 * Fold what somebody typed onto the alphabet, keeping only what counts.
 *
 * Separate from decoding because the input field uses it on every keystroke:
 * the box's own I is a 1 and the app should show a 1 back rather than wait
 * until the code is spent to mention it. Characters outside the alphabet are
 * dropped rather than rejected here — the field must not fight someone
 * mid-word — and `decodeBoxCode` is what refuses.
 */
export function foldBoxCode(typed: string): string {
  let out = ''
  for (const raw of typed.toUpperCase()) {
    if (IGNORED.includes(raw)) continue
    const ch = raw === 'I' || raw === 'L' ? '1' : raw === 'O' ? '0' : raw
    if (ALPHABET.includes(ch)) out += ch
  }
  return out.slice(0, BOX_CODE_CHARS)
}

/** How a code is shown and read: XXXX-XXXX. The hyphen is for the reader. */
export function groupBoxCode(folded: string): string {
  return folded.length > 4 ? `${folded.slice(0, 4)}-${folded.slice(4)}` : folded
}

/**
 * Turn what somebody typed into the five bytes the box drew.
 *
 * Throws BoxCodeError, with a sentence, for anything that is not eight
 * characters of the alphabet once the folding has been applied. Nothing here
 * reaches the box, so a refusal costs no attempt.
 */
export function decodeBoxCode(typed: string): Uint8Array {
  // Not foldBoxCode: that one drops what it does not recognise, which is right
  // for a field being typed into and wrong here. A ! in the middle of a code
  // means the person is reading the wrong line, and eight good characters
  // salvaged from around it would be a code nobody meant to send.
  let chars = ''
  for (const raw of typed.toUpperCase()) {
    if (IGNORED.includes(raw)) continue
    const ch = raw === 'I' || raw === 'L' ? '1' : raw === 'O' ? '0' : raw
    if (!ALPHABET.includes(ch)) {
      throw new BoxCodeError(`${JSON.stringify(raw)} is not in the alphabet`, NOT_A_CODE)
    }
    chars += ch
  }

  if (chars.length !== BOX_CODE_CHARS) {
    throw new BoxCodeError(`${chars.length} characters, expected ${BOX_CODE_CHARS}`, NOT_A_CODE)
  }

  // Forty bits, most significant character first. BigInt rather than a number:
  // 40 bits fits a double exactly, but the shift operators do not — they work
  // on 32, so `n << 5` silently wraps at the sixth character and the last three
  // bytes come out of a different code than the one that was read out.
  let n = 0n
  for (const ch of chars) n = (n << 5n) | BigInt(ALPHABET.indexOf(ch))

  const out = new Uint8Array(BOX_CODE_BYTES)
  for (let i = BOX_CODE_BYTES - 1; i >= 0; i--) {
    out[i] = Number(n & 0xffn)
    n >>= 8n
  }
  return out
}
