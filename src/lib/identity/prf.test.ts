import { describe, it, expect, afterEach } from 'vitest'
import {
  prfCapability,
  webAuthnAvailable,
  registerPasskey,
  assertWrappingKey,
  isUserCancelled,
  PRF_SALTS,
} from './prf'
import { installMockAuthenticator, removeWebAuthn } from '../../../tests/support/passkey'

let cleanup: (() => void) | null = null

afterEach(() => {
  cleanup?.()
  cleanup = null
})

const handle = () => new Uint8Array(16).fill(1)

async function roundTrip(a: CryptoKey, b: CryptoKey): Promise<boolean> {
  const iv = new Uint8Array(12)
  const plain = new TextEncoder().encode('device key')
  const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, a, plain)
  try {
    const out = await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, b, ct)
    return new TextDecoder().decode(out) === 'device key'
  } catch {
    return false
  }
}

describe('feature detection is honest about what it does not know', () => {
  it('says no when the browser has no WebAuthn', async () => {
    cleanup = removeWebAuthn()
    expect(webAuthnAvailable()).toBe(false)
    await expect(prfCapability()).resolves.toBe('no')
  })

  it('says yes or no when the browser will answer', async () => {
    const mock = installMockAuthenticator({ capabilities: { 'extension:prf': true } })
    cleanup = () => mock.uninstall()
    await expect(prfCapability()).resolves.toBe('yes')

    mock.uninstall()
    const denied = installMockAuthenticator({ capabilities: { 'extension:prf': false } })
    cleanup = () => denied.uninstall()
    await expect(prfCapability()).resolves.toBe('no')
  })

  it('says unknown rather than guessing when the browser cannot be asked', async () => {
    // Browsers without getClientCapabilities only reveal PRF by being asked
    // for it. Reporting 'no' here would refuse a device that works.
    const mock = installMockAuthenticator({ capabilities: null })
    cleanup = () => mock.uninstall()
    await expect(prfCapability()).resolves.toBe('unknown')
  })
})

describe('registration', () => {
  it('derives a wrapping key from one prompt when PRF comes back at create', async () => {
    const mock = installMockAuthenticator({ prf: 'create' })
    cleanup = () => mock.uninstall()

    const reg = await registerPasskey({ userHandle: handle() })

    expect(reg.wrapping?.source).toBe('prf')
    expect(reg.wrapping?.credentialId).toBe(reg.credentialId)
    expect(mock.createCalls).toBe(1)
    expect(mock.getCalls).toBe(0)
  })

  it('falls back to one extra prompt when the platform only evaluates on assert', async () => {
    const mock = installMockAuthenticator({ prf: 'assert-only' })
    cleanup = () => mock.uninstall()

    const reg = await registerPasskey({ userHandle: handle() })

    expect(reg.wrapping?.source).toBe('prf')
    expect(mock.getCalls).toBe(1)
  })

  it('returns the credential with no wrapping key when PRF is absent', async () => {
    const mock = installMockAuthenticator({ prf: 'none' })
    cleanup = () => mock.uninstall()

    const reg = await registerPasskey({ userHandle: handle() })

    expect(reg.credentialId).not.toBe('')
    expect(reg.wrapping).toBeNull()
    expect(mock.getCalls).toBe(0)
  })
})

describe('the derived key', () => {
  it('is a non-extractable AES-GCM key that can only seal and open', async () => {
    const mock = installMockAuthenticator()
    cleanup = () => mock.uninstall()

    const { wrapping } = await registerPasskey({ userHandle: handle() })

    expect(wrapping!.key.extractable).toBe(false)
    expect(wrapping!.key.algorithm.name).toBe('AES-GCM')
    expect([...wrapping!.key.usages].sort()).toEqual(['decrypt', 'encrypt'])
  })

  it('comes out the same every time the same passkey answers', async () => {
    // The fixed salt is what makes this true. If it ever moved, every enrolled
    // device would be locked out of its own vault.
    const mock = installMockAuthenticator()
    cleanup = () => mock.uninstall()

    const first = await registerPasskey({ userHandle: handle() })
    const again = await assertWrappingKey({ credentialIds: [first.credentialId] })

    expect(again?.credentialId).toBe(first.credentialId)
    await expect(roundTrip(first.wrapping!.key, again!.key)).resolves.toBe(true)
  })

  it('differs per credential, which is why the device key is wrapped N times', async () => {
    const mock = installMockAuthenticator()
    cleanup = () => mock.uninstall()

    const apple = await registerPasskey({ userHandle: handle() })
    const android = await registerPasskey({ userHandle: handle() })

    expect(apple.credentialId).not.toBe(android.credentialId)
    await expect(roundTrip(apple.wrapping!.key, android.wrapping!.key)).resolves.toBe(false)
  })

  it('keeps one salt per purpose, fixed', () => {
    expect(PRF_SALTS.vault).toBe('ftw.prf.v1.vault')
    expect(new Set(Object.values(PRF_SALTS)).size).toBe(Object.values(PRF_SALTS).length)
  })
})

describe('assertion', () => {
  it('returns null when the passkey answers without PRF', async () => {
    const mock = installMockAuthenticator({ prf: 'none' })
    cleanup = () => mock.uninstall()

    const reg = await registerPasskey({ userHandle: handle() })
    await expect(assertWrappingKey({ credentialIds: [reg.credentialId] })).resolves.toBeNull()
  })

  it('tells a decline from a failure', async () => {
    expect(isUserCancelled(new DOMException('no', 'NotAllowedError'))).toBe(true)
    expect(isUserCancelled(new DOMException('gone', 'AbortError'))).toBe(true)
    expect(isUserCancelled(new DOMException('broken', 'NotSupportedError'))).toBe(false)
    expect(isUserCancelled(new Error('anything else'))).toBe(false)
  })
})
