/* The sealed escrow.
 *
 * It holds one sealed copy of a household's recovery blob, so a phone with
 * nothing on it can come back with a passkey alone. The sentence the product
 * makes, and the one this file has to make literally true:
 *
 *   "Sourceful holds a sealed copy it cannot open, with an opaque id and
 *    nothing beside it."
 *
 * Sealed: the payload is AES-GCM ciphertext under a key derived from WebAuthn
 *   PRF output. Nothing in this directory decrypts anything, holds a secret key
 *   or has a code path that could take one if it were offered. What it does do
 *   with cryptography is hash and verify a signature, both of which need only
 *   public inputs — see `authentic` in store.ts.
 * Opaque id: 32 bytes derived from the same PRF output under its own info
 *   string. The id and the key are siblings, so the id says nothing about the
 *   key, and a fresh device derives the id from the passkey alone.
 * Nothing beside it: see store.ts and layout.md. Four fields in a fixed slot,
 *   and no fifth.
 *
 * WHY EVERY REQUEST IS A POST TO ONE PATH, and the id travels in the body.
 *
 * The obvious shape is GET /e/{id}. It is wrong here for two reasons that have
 * nothing to do with taste. A URL is the one part of a request every layer
 * writes down — edge request logs, sampled dashboards, anything an operator
 * later switches on — so an id in the path is an id in somebody's log beside a
 * timestamp, and "nothing beside it" would be false in operation while the
 * table stayed clean. And a GET is cacheable by the very edge that serves it,
 * so a shared cache keyed on a URL is one misconfiguration away from handing
 * one household's ciphertext to another.
 *
 * So: one path, `/e`, the same for everyone; POST, which is never cached; and
 * the id in a JSON body. The server in ./main writes no log at all and the
 * proxy in front of it discards both of its own — but the shape is what makes
 * the claim hold even when somebody turns logging on.
 *
 * AND EVERY REQUEST IS THE SAME LENGTH, which is the same argument one layer
 * down and was learned the hard way. The proxy in front of this once kept a
 * request line with the URI, the headers and both address fields deleted from
 * it, and what was left still told the three operations apart: a put read 769
 * bytes and answered 13, a read hit 63 and 707, a miss 63 and 2. A filter is a
 * list of the fields somebody thought of, and a byte count is not a field.
 *
 * So every legal request body is exactly ESCROW_REQUEST_BYTES and every answer
 * past that gate is exactly ESCROW_ANSWER_BYTES. Padding is not decoration
 * here any more than it is in the blob, which is padded to 512 so its length
 * cannot count the homes inside it: with these two constants a put, a read of
 * a copy that is there and a read of one that is not are the same size on the
 * wire, in a proxy that counts bytes, and in whatever counts them next.
 *
 * READING IS THE ID ALONE. WRITING IS NOT, AND THAT IS NEW.
 *
 * This file used to say, plainly, that knowing an id was the whole
 * authorisation — so anyone who learned one could write version+1 of anything
 * and destroy a household's spare copy. A write now carries an Ed25519 public
 * key and a signature over the id, the version and the blob's digest. The store
 * pins the key on the first write and refuses every later write that presents a
 * different one. The key is a sibling of the sealing key, out of the same
 * passkey ceremony, so it costs the household nothing.
 *
 * Reading stays behind the id alone, deliberately: a fresh install has a
 * passkey and nothing else, and it has to be able to read.
 *
 * WHAT IS LEFT, stated here rather than in a footnote. An id that has never
 * been written can be claimed by whoever writes it first, because a first write
 * is what pins the key. Learning an id takes a passkey ceremony on that
 * household's own credential, and the first write follows it within the second,
 * so the window is that gap and not a policy. Nothing is ever evicted here,
 * which is what keeps a pin from lapsing and reopening it later.
 */

import { decodeId, SIGNATURE_BYTES, WRITE_KEY_BYTES, type EscrowStore } from './store.ts'

/**
 * Every blob is exactly this long, padded inside the seal before it is sealed.
 *
 * Refused at any other length, which is a privacy control and not a size
 * limit: an unpadded blob's length counts the homes inside it. The app's
 * RECOVERY_BLOB_MAX_BYTES is the same number and a test pins the two together.
 */
export const ESCROW_BLOB_BYTES = 512

/**
 * A blob's worth of nothing, for the answer a miss builds and never sends.
 *
 * Random rather than zeroes, so encoding it costs what encoding a sealed copy
 * costs. Made once, when the service starts. It is not a secret and it is not a
 * key: nothing is sealed under it and it never reaches a socket.
 */
const ABSENT = new Uint8Array(ESCROW_BLOB_BYTES)
crypto.getRandomValues(ABSENT)

/**
 * WHY THERE IS NO DELETE, and a household clears its copy instead.
 *
 * A delete looks like the obvious way to leave, and it quietly undoes two
 * things at once. Versions count from 1 against a record that is not there, so
 * a deleted id accepts a first write again — and whoever kept an earlier blob
 * can write it straight back, because that blob really was sealed under version
 * 1. A household that removed a home would get it offered back on the next
 * fresh install, which is exactly what the guard exists to stop. A delete would
 * also drop the pinned write key, so the id would be there for whoever claimed
 * it next. The test that caught the first of those is in
 * tests/escrow-e2e.test.ts and the one for the second is in escrow.test.ts.
 *
 * So a clear is a write of zero bytes at the successor version. The version
 * keeps counting, both guards keep holding, and what is left is an id, a small
 * number and a public key with nothing sealed under them.
 *
 * The residue, stated rather than glossed: an id that has ever been used keeps
 * a record, so the service can say that some passkey once used the escrow and
 * roughly how many times it wrote. It cannot say whose, when, or what.
 * README.md carries this in the same words.
 */
export const ESCROW_CLEARED_BYTES = 0

/** Versions are uint32. A household that writes 4 billion times has other problems. */
const MAX_VERSION = 0xffffffff

/**
 * The one origin a browser may call this from.
 *
 * Exact, never a wildcard. It is not a security boundary — a client that is
 * not a browser ignores CORS entirely, and the seal is what makes that
 * survivable — but it keeps the browser surface at the single origin the app
 * actually lives on.
 */
export const DEFAULT_ORIGIN = 'https://app.ftw.energy'


/**
 * The length of every legal request body. Not a maximum — the length.
 *
 * A privacy control and not a size limit, in the same way the blob's 512 is:
 * unpadded, a request's length says which of the operations it is, and that is
 * a household activity record for anything that counts bytes. The largest
 * natural body is a put at 925 — the key and the signature added 147 of that —
 * and the smallest a get at 63, so this still has room and the app pads up to
 * it. The test that measures the largest legal request is what would have
 * caught the padding running out.
 *
 * Exported so the server in ./main hangs up at the same number rather than
 * carrying a second copy of it that drifts. The app carries its own copy,
 * because it must not import service code, and tests/escrow-e2e.test.ts pins
 * the two together.
 */
export const ESCROW_REQUEST_BYTES = 1024

/**
 * The length of every answer past the length gate. Also not a maximum.
 *
 * A hit carries 512 bytes of ciphertext and a miss carries none, so without
 * this the answer's length says whether a household has a copy — the same leak
 * from the other direction. The largest natural answer is 716, and a refused
 * write is the same length as an accepted one.
 *
 * Refusals *before* the gate are not padded: they are what a request that is
 * not a household operation at all gets — a wrong method, a wrong path, a body
 * that is not this length — and padding them would answer 1 KB to a 60-byte
 * stranger, which is an amplifier and not a privacy control.
 */
export const ESCROW_ANSWER_BYTES = 1024

export async function handle(
  request: Request,
  store: EscrowStore,
  allowedOrigin = DEFAULT_ORIGIN
): Promise<Response> {
  const cors = {
    'access-control-allow-origin': allowedOrigin,
    'access-control-allow-methods': 'POST, OPTIONS',
    'access-control-allow-headers': 'content-type',
    'access-control-max-age': '86400',
    // Belongs on every answer, not only the ones with a body: this service
    // exists to be uncached, and a 404 cached at an edge is a household told
    // its copy is gone.
    'cache-control': 'no-store',
  }

  /** Before the length gate. Not a household operation, so not padded. */
  const refuse = (status: number) =>
    new Response('{}', { status, headers: { ...cors, 'content-type': 'application/json' } })

  /** Past the gate. Every one of these is the same length as every other. */
  const answer = (status: number, payload: Record<string, unknown> = {}) =>
    new Response(pad(payload, ESCROW_ANSWER_BYTES), {
      status,
      headers: { ...cors, 'content-type': 'application/json' },
    })

  if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors })
  if (request.method !== 'POST') return refuse(405)

  const url = new URL(request.url)
  // One path and no query. The path is the reason for the whole wire shape;
  // the query is the same hole with a different name, and refusing it here is
  // what stops `?id=` from ever looking like a reasonable convenience to add.
  if (url.pathname !== '/e' || url.search !== '') return refuse(404)

  // The length gate. One length for every operation, so no client can opt out
  // of the padding — the same rule the blob has, and for the same reason.
  const body = await readBody(request)
  if (!body) return refuse(400)

  // 32 bytes of base64url, in the one spelling those bytes have. Several
  // strings decode to the same id — the last character carries two bits the id
  // does not — and taking more than one of them would give a household several
  // names, one of which its signature was made under. See decodeId.
  const id = typeof body['id'] === 'string' ? body['id'] : ''
  if (!decodeId(id)) return answer(400)

  switch (body['op']) {
    case 'get': {
      const stored = await store.read(id)
      // A miss and a hit run the same lookup, carry the same number of bytes,
      // and now cost the same to build. That last one was missing and it was
      // not a small thing: encoding half a kilobyte to base64 and packing it
      // into JSON only when there was something to encode is an existence
      // oracle a stopwatch reads straight off, and padding the answer to 1024
      // bytes does nothing about it. Padding fixed the size channel. This is
      // the clock.
      //
      // So both answers are built every time and the wrong one is dropped.
      // ABSENT stands in for a copy that is not there; it never leaves this
      // function.
      const full = stored?.blob.length === ESCROW_BLOB_BYTES
      const staging = new Uint8Array(ABSENT)
      staging.set(full ? stored.blob : ABSENT)
      const encoded = toBase64(staging)
      const hit = answer(200, { version: stored?.version ?? 0, blob: full ? encoded : '' })
      const miss = answer(404)
      // What is left to tell them apart is the status code — which TLS covers
      // on the wire and no log records, because there is no log — and the size
      // of the id space, which is what makes guessing pointless.
      return stored ? hit : miss
    }

    case 'put': {
      const version = body['version']
      if (!Number.isInteger(version) || (version as number) < 1 || (version as number) > MAX_VERSION) {
        return answer(400)
      }
      const blob = typeof body['blob'] === 'string' ? fromBase64(body['blob']) : null
      // Two lengths and no others: a sealed copy, or the zero bytes that clear
      // one. Anything in between would let a client opt out of the padding
      // that stops the length counting the homes inside.
      if (!blob || (blob.length !== ESCROW_BLOB_BYTES && blob.length !== ESCROW_CLEARED_BYTES)) {
        return answer(400)
      }
      // Who is allowed to write this id. Checked for shape here and for truth
      // in the store, which is where the pinned key is.
      const writeKey = typeof body['pub'] === 'string' ? fromBase64url(body['pub']) : null
      const signature = typeof body['sig'] === 'string' ? fromBase64url(body['sig']) : null
      if (!writeKey || writeKey.length !== WRITE_KEY_BYTES) return answer(400)
      if (!signature || signature.length !== SIGNATURE_BYTES) return answer(400)

      const outcome = await store.write({ id, version: version as number, blob, writeKey, signature })
      switch (outcome) {
        case 'written':
          return answer(200, { version: version as number })
        // The version was not the immediate successor. Read and try again.
        case 'version':
          return answer(409)
        // Signed by nobody, or by a key that is not the one pinned here.
        case 'unauthorised':
          return answer(403)
        // The file is at its ceiling for this id's bucket. README.md says what
        // that means and deploy/README.md says what to do about it.
        case 'full':
          return answer(507)
      }
    }

    default:
      return answer(400)
  }
}

/**
 * `payload` as JSON, with a `pad` member that makes the whole exactly `bytes`.
 *
 * A member rather than trailing whitespace, so it survives anything that
 * re-serialises on the way past and so a reader can see what it is. Both sides
 * of the wire carry these three lines — the app's copy is in
 * src/lib/identity/escrow.ts, because the app must not import service code —
 * and tests/escrow-e2e.test.ts drives one through the other.
 */
export function pad(payload: Record<string, unknown>, bytes: number): string {
  const empty = JSON.stringify({ ...payload, pad: '' })
  return JSON.stringify({ ...payload, pad: 'A'.repeat(bytes - empty.length) })
}

/**
 * The request body, or null for anything that is not a JSON object of exactly
 * ESCROW_REQUEST_BYTES.
 *
 * The declared length is checked first, so a client cannot make this service
 * allocate by announcing a large body — and nothing about the failure is
 * reported back, because there is nothing here worth telling anyone apart.
 *
 * Exactly, not at most. A request one byte short is a client that skipped the
 * padding, and a service that took it would let the next proxy count bytes and
 * name the operation again.
 */
async function readBody(request: Request): Promise<Record<string, unknown> | null> {
  const declared = request.headers.get('content-length')
  if (declared && Number(declared) !== ESCROW_REQUEST_BYTES) return null

  let bytes: ArrayBuffer
  try {
    bytes = await request.arrayBuffer()
  } catch {
    return null
  }
  // Bytes, not characters. The property is about what goes over the wire, and
  // one multi-byte character would make a body of 1024 characters longer than
  // 1024 bytes.
  if (bytes.byteLength !== ESCROW_REQUEST_BYTES) return null
  const text = new TextDecoder().decode(bytes)

  try {
    const parsed: unknown = JSON.parse(text)
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null
  } catch {
    return null
  }
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

/**
 * The key and the signature travel base64url, the way the id does.
 *
 * Strict about the alphabet rather than lenient: `atob` accepts a great deal
 * that is not base64url, and a decoder that quietly succeeds on rubbish is how
 * a 32-byte length check stops meaning anything.
 */
function fromBase64url(text: string): Uint8Array | null {
  if (!/^[A-Za-z0-9_-]*$/.test(text)) return null
  return fromBase64(text.replaceAll('-', '+').replaceAll('_', '/'))
}
