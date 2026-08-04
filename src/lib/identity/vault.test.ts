import { describe, it, expect, afterEach, vi } from 'vitest'
import 'fake-indexeddb/auto'
import { x25519 } from '@noble/curves/ed25519.js'
import { cacheKey, sealJson, unsealJson } from '$lib/store/seal'
import {
  memoryVaultStore,
  deviceKey,
  addCredential,
  removeCredential,
  resetIdentity,
  enrollWrappingKey,
  unlockWrappingKey,
  localWrappingKey,
  deviceStaticPublic,
  enrolledCredentialIds,
  isEnrolled,
  VaultError,
  LOCAL_CREDENTIAL_ID,
  type VaultStore,
  type WrappingKey,
} from './vault'
import { installMockAuthenticator, removeWebAuthn } from '../../../tests/support/passkey'

let cleanup: (() => void) | null = null

afterEach(() => {
  cleanup?.()
  cleanup = null
})

const hex = (b: Uint8Array) => [...b].map((x) => x.toString(16).padStart(2, '0')).join('')

async function codeOf(fn: () => Promise<unknown>): Promise<string> {
  try {
    await fn()
  } catch (err) {
    expect(err).toBeInstanceOf(VaultError)
    return (err as VaultError).code
  }
  throw new Error('expected a throw')
}

async function passkeyVault(): Promise<{ store: VaultStore; wrapping: WrappingKey }> {
  const store = memoryVaultStore()
  const wrapping = await enrollWrappingKey(store)
  return { store, wrapping }
}

describe('the cache key opens no doors and asks no questions', () => {
  it('is created without a passkey, so the first frame paints before Face ID', async () => {
    const mock = installMockAuthenticator()
    cleanup = () => mock.uninstall()

    const key = await cacheKey()

    expect(mock.createCalls).toBe(0)
    expect(mock.getCalls).toBe(0)
    expect(key.extractable).toBe(false)
    expect(key.algorithm.name).toBe('AES-GCM')
  })

  it('is the same key on every cold start', async () => {
    // Identity is the wrong test: IndexedDB structured-clones a CryptoKey, so
    // each read is a distinct object. What matters is that the key still
    // opens what it sealed — a regenerated key would silently orphan every
    // cached snapshot on disk.
    const sealed = await sealJson(await cacheKey(), { gridW: 11400 })
    expect(await unsealJson(await cacheKey(), sealed)).toEqual({ gridW: 11400 })
  })

  it('is kept apart from the wrapped copies of the device key', async () => {
    const mock = installMockAuthenticator()
    cleanup = () => mock.uninstall()

    const { store, wrapping } = await passkeyVault()
    await deviceKey(store, wrapping)
    const cache = await cacheKey()

    const ids = await enrolledCredentialIds(store)
    expect(ids).toEqual([wrapping.credentialId])
    expect(cache).not.toBe(wrapping.key)
  })
})

describe('the device key', () => {
  it('is created on first use and answers Noise DH against its own public key', async () => {
    const mock = installMockAuthenticator()
    cleanup = () => mock.uninstall()

    const { store, wrapping } = await passkeyVault()
    expect(await isEnrolled(store)).toBe(false)

    const key = await deviceKey(store, wrapping)
    const peer = x25519.keygen()

    expect(key.publicKey).toHaveLength(32)
    expect(hex(await key.diffieHellman(peer.publicKey))).toBe(
      hex(x25519.getSharedSecret(peer.secretKey, key.publicKey))
    )
    expect(await isEnrolled(store)).toBe(true)
  })

  it('survives a restart rather than rotating behind the user', async () => {
    const mock = installMockAuthenticator()
    cleanup = () => mock.uninstall()

    const { store, wrapping } = await passkeyVault()
    const first = await deviceKey(store, wrapping)
    const again = await deviceKey(store, wrapping)

    expect(hex(again.publicKey)).toBe(hex(first.publicKey))
    expect(hex((await deviceStaticPublic(store))!)).toBe(hex(first.publicKey))
  })

  it('reads its public key with no prompt at all', async () => {
    const mock = installMockAuthenticator()
    cleanup = () => mock.uninstall()

    const { store, wrapping } = await passkeyVault()
    await deviceKey(store, wrapping)
    const before = mock.createCalls + mock.getCalls

    await deviceStaticPublic(store)
    expect(mock.createCalls + mock.getCalls).toBe(before)
  })
})

describe('one wrapped copy per credential', () => {
  it('unwraps the same key from an Apple passkey and an Android one', async () => {
    // Two credentials derive two different PRF outputs, so the device key is
    // wrapped twice rather than derived twice. This is the whole reason the
    // hierarchy uses classic key wrapping.
    const mock = installMockAuthenticator()
    cleanup = () => mock.uninstall()

    const { store, wrapping: apple } = await passkeyVault()
    const original = await deviceKey(store, apple)

    const android = await enrollWrappingKey(store)
    await addCredential(store, apple, android)

    expect(apple.credentialId).not.toBe(android.credentialId)
    expect(await enrolledCredentialIds(store)).toEqual([apple.credentialId, android.credentialId])

    const viaAndroid = await deviceKey(store, android)
    expect(hex(viaAndroid.publicKey)).toBe(hex(original.publicKey))

    const peer = x25519.keygen()
    expect(hex(await viaAndroid.diffieHellman(peer.publicKey))).toBe(
      hex(await original.diffieHellman(peer.publicKey))
    )
  })

  it('refuses a credential that has no copy yet', async () => {
    const mock = installMockAuthenticator()
    cleanup = () => mock.uninstall()

    const { store, wrapping: apple } = await passkeyVault()
    await deviceKey(store, apple)
    const stranger = await enrollWrappingKey(store)

    expect(await codeOf(() => deviceKey(store, stranger))).toBe('E_VAULT_NO_COPY')
    expect(await codeOf(() => addCredential(store, stranger, apple))).toBe('E_VAULT_NO_COPY')
  })

  it('refuses a wrapping key that does not open the copy', async () => {
    const mock = installMockAuthenticator()
    cleanup = () => mock.uninstall()

    const { store, wrapping } = await passkeyVault()
    await deviceKey(store, wrapping)

    const impostor: WrappingKey = {
      credentialId: wrapping.credentialId,
      source: 'prf',
      key: await crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, false, [
        'encrypt',
        'decrypt',
      ]),
    }

    expect(await codeOf(() => deviceKey(store, impostor))).toBe('E_VAULT_LOCKED')
  })

  it('will not remove the copy that is holding the key up', async () => {
    const mock = installMockAuthenticator()
    cleanup = () => mock.uninstall()

    const { store, wrapping: apple } = await passkeyVault()
    await deviceKey(store, apple)

    expect(await codeOf(() => removeCredential(store, apple.credentialId))).toBe('E_VAULT_LAST_COPY')

    const android = await enrollWrappingKey(store)
    await addCredential(store, apple, android)
    await removeCredential(store, apple.credentialId)

    expect(await enrolledCredentialIds(store)).toEqual([android.credentialId])
    expect(await codeOf(() => deviceKey(store, apple))).toBe('E_VAULT_NO_COPY')
  })
})

describe('without PRF, enrollment still works and says so', () => {
  it('falls back to a local key when the passkey delivers no PRF', async () => {
    const mock = installMockAuthenticator({ prf: 'none' })
    cleanup = () => mock.uninstall()

    const store = memoryVaultStore()
    const wrapping = await enrollWrappingKey(store)

    expect(wrapping.source).toBe('local')
    expect(wrapping.credentialId).toBe(LOCAL_CREDENTIAL_ID)
    // The passkey is still registered: it gates privileged commands even when
    // it cannot derive a key.
    expect(mock.createCalls).toBe(1)

    const key = await deviceKey(store, wrapping)
    expect(key.publicKey).toHaveLength(32)
  })

  it('falls back when the browser has no WebAuthn at all, without prompting', async () => {
    cleanup = removeWebAuthn()

    const store = memoryVaultStore()
    const wrapping = await enrollWrappingKey(store)

    expect(wrapping.source).toBe('local')
    expect((await deviceKey(store, wrapping)).publicKey).toHaveLength(32)
  })

  it('unlocks on the next start with no prompt, because there is nothing to prompt for', async () => {
    const mock = installMockAuthenticator({ prf: 'none' })
    cleanup = () => mock.uninstall()

    const store = memoryVaultStore()
    const first = await deviceKey(store, await enrollWrappingKey(store))
    const calls = mock.createCalls + mock.getCalls

    const wrapping = await unlockWrappingKey(store)
    expect(wrapping.source).toBe('local')
    expect(mock.createCalls + mock.getCalls).toBe(calls)
    expect(hex((await deviceKey(store, wrapping)).publicKey)).toBe(hex(first.publicKey))
  })

  it('gives the same local key back rather than minting a second one', async () => {
    const store = memoryVaultStore()
    const a = await localWrappingKey(store)
    const b = await localWrappingKey(store)
    expect(a.key).toBe(b.key)
  })
})

describe('unlocking an enrolled device', () => {
  it('asks the passkey once and opens the vault', async () => {
    const mock = installMockAuthenticator()
    cleanup = () => mock.uninstall()

    const { store, wrapping } = await passkeyVault()
    const original = await deviceKey(store, wrapping)
    const before = mock.getCalls

    const unlocked = await unlockWrappingKey(store)
    expect(mock.getCalls).toBe(before + 1)
    expect(unlocked.source).toBe('prf')
    expect(hex((await deviceKey(store, unlocked)).publicKey)).toBe(hex(original.publicKey))
  })

  it('points at the box when there is nothing enrolled', async () => {
    const store = memoryVaultStore()
    expect(await codeOf(() => unlockWrappingKey(store))).toBe('E_VAULT_EMPTY')

    try {
      await unlockWrappingKey(store)
    } catch (err) {
      expect((err as VaultError).help).toMatch(/scan the code on your box/i)
    }
  })

  it('says what to do when a passkey vault can no longer derive its key', async () => {
    const mock = installMockAuthenticator()
    cleanup = () => mock.uninstall()

    const { store, wrapping } = await passkeyVault()
    await deviceKey(store, wrapping)

    mock.prf = 'none'
    expect(await codeOf(() => unlockWrappingKey(store))).toBe('E_VAULT_LOCKED')
  })

  it('leaves a decline as a decline instead of telling the user to re-pair', async () => {
    const mock = installMockAuthenticator()
    cleanup = () => mock.uninstall()

    const { store, wrapping } = await passkeyVault()
    await deviceKey(store, wrapping)

    mock.uninstall()
    const declining = installMockAuthenticator({
      failWith: new DOMException('user said no', 'NotAllowedError'),
    })
    cleanup = () => declining.uninstall()

    await expect(unlockWrappingKey(store)).rejects.toBeInstanceOf(DOMException)
  })
})

describe('browsers with passkeys but no X25519 in WebCrypto', () => {
  it('falls back to @noble and still produces a working Noise static', async () => {
    // Chrome shipped PRF long before it shipped the curve, so this pairing of
    // capabilities is a real phone, not a hypothetical one.
    vi.resetModules()
    const real = crypto.subtle.generateKey.bind(crypto.subtle)
    const spy = vi
      .spyOn(crypto.subtle, 'generateKey')
      .mockImplementation((algorithm, extractable, usages) =>
        (algorithm as Algorithm).name === 'X25519'
          ? Promise.reject(new DOMException('unsupported', 'NotSupportedError'))
          : real(algorithm as AlgorithmIdentifier, extractable, usages)
      )

    try {
      const vault = await import('./vault')
      const store = vault.memoryVaultStore()
      const key = await vault.deviceKey(store, await vault.localWrappingKey(store))
      const peer = x25519.keygen()

      // Proves the fresh module probed and was refused, so this really is the
      // fallback and not WebCrypto answering under a different name.
      expect(spy).toHaveBeenCalledWith(
        expect.objectContaining({ name: 'X25519' }),
        expect.anything(),
        expect.anything()
      )
      expect(key.publicKey).toHaveLength(32)
      expect(hex(await key.diffieHellman(peer.publicKey))).toBe(
        hex(x25519.getSharedSecret(peer.secretKey, key.publicKey))
      )
    } finally {
      spy.mockRestore()
    }
  })
})

describe('starting over', () => {
  // resetIdentity clears identity only. The sealed projection and the key
  // that opens it live in the other database, and clearing one without the
  // other is a leak, not a partial reset — see forgetEverything in
  // $lib/store/reset and tests/security-regressions.test.ts.
  it('clears the identity this origin holds', async () => {
    const mock = installMockAuthenticator()
    cleanup = () => mock.uninstall()

    const { store, wrapping } = await passkeyVault()
    await deviceKey(store, wrapping)

    await resetIdentity(store)

    expect(await isEnrolled(store)).toBe(false)
    expect(await deviceStaticPublic(store)).toBeNull()
    expect(await enrolledCredentialIds(store)).toEqual([])
  })
})
