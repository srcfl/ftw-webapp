/* The bytes, and what is bound into them.
 *
 * Two of these go at the ciphertext directly rather than through the public
 * API, and that is the point of the file. `openRecoveryBlob` checks the format
 * version before it decrypts anything, so a test that swaps that byte and
 * expects a throw passes whether or not the byte was ever bound in as
 * additional data — it is the check above the seal that fires, not the seal.
 * The same trap is waiting for the escrow version, where the consequence is
 * larger: without the binding, whoever holds the ciphertext can pair an old
 * blob with a new version number and hand a household back a home it removed.
 */

import { describe, it, expect } from 'vitest'
import {
  decodeRecoveryBlob,
  encodeRecoveryBlob,
  MAX_NAME_CHARS,
  openRecoveryBlob,
  recoveryBlobAad,
  RECOVERY_BLOB_MAX_BYTES,
  RECOVERY_BLOB_VERSION,
  RecoveryBlobError,
  sealRecoveryBlob,
  type RecoveryBlob,
} from './recovery-blob'
import { ESCROW_BLOB_BYTES } from '../../../escrow/src/escrow.ts'

const SCALAR = new Uint8Array(32).fill(0x44)

function blob(homes: number): RecoveryBlob {
  return {
    deviceScalar: SCALAR,
    homes: Array.from({ length: homes }, (_, n) => ({
      siteId: `site-${n}`,
      label: n === 0 ? 'Home' : `Cabin ${n}`,
      boxStaticKey: new Uint8Array(32).fill(0xa0 + n),
      rendezvousSecret: new Uint8Array(32).fill(0xc0 + n),
    })),
  }
}

function sealingKey(): Promise<CryptoKey> {
  return crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt'])
}

describe('the format', () => {
  it('carries more than one home, and gives each back as it went in', () => {
    // Multi-site is coming. A format that fits exactly one home would have to
    // be broken to add the second, and a broken format strands every copy
    // already sitting in the escrow.
    const out = decodeRecoveryBlob(encodeRecoveryBlob(blob(3)))

    expect(out.homes.map((h) => h.siteId)).toEqual(['site-0', 'site-1', 'site-2'])
    expect(out.homes.map((h) => h.label)).toEqual(['Home', 'Cabin 1', 'Cabin 2'])
    expect(Array.from(out.homes[2]!.boxStaticKey)).toEqual(Array.from(blob(3).homes[2]!.boxStaticKey))
    expect(Array.from(out.homes[2]!.rendezvousSecret)).toEqual(
      Array.from(blob(3).homes[2]!.rendezvousSecret)
    )
    expect(Array.from(out.deviceScalar)).toEqual(Array.from(SCALAR))
  })

  it('refuses bytes it cannot account for rather than reading half a home', () => {
    // A home assembled out of bytes that were not ours is a box key nothing
    // will ever answer, offered to somebody as their house.
    const whole = encodeRecoveryBlob(blob(2))

    expect(() => decodeRecoveryBlob(whole.subarray(0, whole.length - 1))).toThrow(RecoveryBlobError)
    const extra = new Uint8Array(whole.length + 1)
    extra.set(whole)
    expect(() => decodeRecoveryBlob(extra)).toThrow(RecoveryBlobError)
  })

  it('is the same length whether it carries one home or four', async () => {
    // Unpadded, the sealed blob grows by about eighty bytes a home, so whoever
    // holds the ciphertext counts the household's homes without opening
    // anything. Lane 0 pads against exactly this on the wire.
    const key = await sealingKey()
    const lengths = new Set<number>()
    for (const homes of [1, 2, 3, 4]) {
      lengths.add((await sealRecoveryBlob(key, blob(homes), 1)).length)
    }

    expect([...lengths], 'the length said how many homes were inside').toEqual([
      RECOVERY_BLOB_MAX_BYTES,
    ])
  })

  it('is exactly the length the escrow will accept', () => {
    // Two constants in two directories for one number. A copy the service
    // refuses is a recovery that fails at the last step, on the phone that
    // needed it.
    expect(ESCROW_BLOB_BYTES).toBe(RECOVERY_BLOB_MAX_BYTES)
  })

  it('refuses more homes than the budget allows, rather than truncating', async () => {
    const key = await sealingKey()
    await expect(sealRecoveryBlob(key, blob(9), 1)).rejects.toMatchObject({ code: 'E_BLOB_TOO_BIG' })
  })

  it('cuts a long name between characters, never through one', () => {
    // slice() counts UTF-16 code units, so a cut landing between the halves of
    // an emoji keeps one of them — and a lone half decodes to exactly the
    // replacement character that cutting by characters exists to avoid. The
    // leading letter is what puts the boundary in the wrong place.
    const long = 'a' + '\u{1F3E0}'.repeat(MAX_NAME_CHARS)
    const one = blob(1)
    const [home] = decodeRecoveryBlob(
      encodeRecoveryBlob({ ...one, homes: [{ ...one.homes[0]!, label: long }] })
    ).homes

    expect(home!.label, 'half a character reached the screen').not.toContain('�')
    expect([...home!.label]).toHaveLength(MAX_NAME_CHARS)
  })
})

describe('what the seal is bound to', () => {
  it('will not open a blob whose format version was swapped underneath it', async () => {
    const key = await sealingKey()
    const sealed = await sealRecoveryBlob(key, blob(1), 1)
    expect(sealed[0]).toBe(RECOVERY_BLOB_VERSION)

    sealed[0] = RECOVERY_BLOB_VERSION + 1
    await expect(openRecoveryBlob(key, sealed, 1)).rejects.toBeInstanceOf(RecoveryBlobError)
  })

  it('binds the escrow version in, so an old blob cannot arrive under a new number', async () => {
    // The rollback guard's other half. The service refuses to store a version
    // that is not the successor; this refuses to *open* ciphertext that was
    // sealed under a different one. Without it, whoever holds the row can
    // answer a fresh device with version 9 and the bytes of version 2 — and a
    // household gets back a home it removed, or a phone that was locked out.
    const key = await sealingKey()
    const sealed = await sealRecoveryBlob(key, blob(1), 2)

    await expect(openRecoveryBlob(key, sealed, 9)).rejects.toMatchObject({ code: 'E_BLOB_LOCKED' })
    await expect(openRecoveryBlob(key, sealed, 1)).rejects.toMatchObject({ code: 'E_BLOB_LOCKED' })
    await expect(openRecoveryBlob(key, sealed, 2)).resolves.toMatchObject({
      homes: [expect.objectContaining({ siteId: 'site-0' })],
    })
  })

  it('binds both versions into the seal itself, not into a check above it', async () => {
    // Straight at the ciphertext, with the right key, asking AES-GCM what it
    // was sealed under. The two tests above cannot see the difference: the
    // format-version check fires before any decrypt, and passing the wrong
    // escrow version to openRecoveryBlob would still fail if the value were
    // merely compared somewhere. Take `additionalData` out of
    // sealRecoveryBlob and the first expectation here passes.
    const key = await sealingKey()
    const sealed = await sealRecoveryBlob(key, blob(1), 7)
    const open = (additionalData?: Uint8Array) =>
      crypto.subtle.decrypt(
        { name: 'AES-GCM', iv: sealed.subarray(1, 13), ...(additionalData ? { additionalData } : {}) },
        key,
        sealed.subarray(13)
      )

    await expect(open(), 'nothing is bound in at all').rejects.toThrow()
    await expect(open(recoveryBlobAad(8)), 'another escrow version opens it').rejects.toThrow()
    await expect(
      open(new Uint8Array([RECOVERY_BLOB_VERSION])),
      'the format version alone opens it, so the escrow version is not bound'
    ).rejects.toThrow()
    // And with the whole of it, so the three refusals above are the binding
    // rather than a wrong key or a wrong nonce.
    await expect(open(recoveryBlobAad(7))).resolves.toBeTruthy()
  })

  it('does not open under another key', async () => {
    const sealed = await sealRecoveryBlob(await sealingKey(), blob(1), 1)

    await expect(openRecoveryBlob(await sealingKey(), sealed, 1)).rejects.toBeInstanceOf(
      RecoveryBlobError
    )
  })
})
