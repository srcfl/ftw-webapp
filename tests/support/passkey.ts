/* A pretend platform authenticator.
 *
 * jsdom has no WebAuthn at all, so every test of the identity layer has to
 * bring its own. This one is deliberately faithful about the single property
 * the key hierarchy depends on: two credentials produce two different PRF
 * outputs for the same salt, which is why the device key is wrapped once per
 * credential instead of derived once.
 *
 * Not a test file — vitest collects `tests/ **\/*.test.ts` only.
 */

import { sha256 } from '@noble/hashes/sha2.js'

export type PrfBehaviour =
  /** PRF output comes back from `create`, the one-prompt path. */
  | 'create'
  /** `create` reports enabled but returns nothing; only `get` evaluates it. */
  | 'assert-only'
  /** No PRF at all. */
  | 'none'

export interface MockOptions {
  prf?: PrfBehaviour
  /** null models a browser without `getClientCapabilities`. */
  capabilities?: Record<string, boolean> | null
  /** Reject every ceremony with this error instead of answering. */
  failWith?: DOMException
}

export interface MockAuthenticator {
  /** Mutable, so a test can take PRF away from credentials that still exist. */
  prf: PrfBehaviour
  createCalls: number
  getCalls: number
  /** Credential ids in registration order, as raw bytes. */
  credentials: Uint8Array[]
  uninstall(): void
}

export function installMockAuthenticator(opts: MockOptions = {}): MockAuthenticator {
  const seeds = new Map<string, Uint8Array>()

  const mock: MockAuthenticator = {
    prf: opts.prf ?? 'create',
    createCalls: 0,
    getCalls: 0,
    credentials: [],
    uninstall() {
      restore()
    },
  }

  const evaluate = (rawId: Uint8Array, salt: Uint8Array): ArrayBuffer => {
    const seed = seeds.get(key(rawId))!
    const input = new Uint8Array(seed.length + salt.length)
    input.set(seed)
    input.set(salt, seed.length)
    return sha256(input).buffer as ArrayBuffer
  }

  const credentials = {
    async create(options: CredentialCreationOptions) {
      mock.createCalls++
      if (opts.failWith) throw opts.failWith

      const pk = options.publicKey!
      const rawId = crypto.getRandomValues(new Uint8Array(16))
      seeds.set(key(rawId), crypto.getRandomValues(new Uint8Array(32)))
      mock.credentials.push(rawId)

      const salt = asBytes(pk.extensions?.prf?.eval?.first)
      const results =
        mock.prf === 'create' && salt
          ? { prf: { enabled: true, results: { first: evaluate(rawId, salt) } } }
          : mock.prf === 'assert-only'
            ? { prf: { enabled: true } }
            : {}

      return credentialObject(rawId, results)
    },

    async get(options: CredentialRequestOptions) {
      mock.getCalls++
      if (opts.failWith) throw opts.failWith

      const pk = options.publicKey!
      const allowed = pk.allowCredentials?.[0]?.id
      const rawId = allowed ? asBytes(allowed)! : mock.credentials[0]
      if (!rawId || !seeds.has(key(rawId))) {
        throw new DOMException('no such credential', 'NotAllowedError')
      }

      const salt = asBytes(pk.extensions?.prf?.eval?.first)
      const results =
        mock.prf !== 'none' && salt ? { prf: { results: { first: evaluate(rawId, salt) } } } : {}

      return credentialObject(rawId, results)
    },
  }

  const previous = {
    pkc: Object.getOwnPropertyDescriptor(globalThis, 'PublicKeyCredential'),
    creds: Object.getOwnPropertyDescriptor(navigator, 'credentials'),
  }

  const pkcStatics: Record<string, unknown> = {}
  if (opts.capabilities !== null) {
    pkcStatics['getClientCapabilities'] = async () =>
      opts.capabilities ?? { 'extension:prf': mock.prf !== 'none' }
  }

  Object.defineProperty(globalThis, 'PublicKeyCredential', {
    value: pkcStatics,
    configurable: true,
    writable: true,
  })
  Object.defineProperty(navigator, 'credentials', {
    value: credentials,
    configurable: true,
    writable: true,
  })

  function restore() {
    define(globalThis, 'PublicKeyCredential', previous.pkc)
    define(navigator, 'credentials', previous.creds)
  }

  return mock
}

/** Removes WebAuthn entirely, the way an old browser or a plain http page does. */
export function removeWebAuthn(): () => void {
  const previous = {
    pkc: Object.getOwnPropertyDescriptor(globalThis, 'PublicKeyCredential'),
    creds: Object.getOwnPropertyDescriptor(navigator, 'credentials'),
  }
  Object.defineProperty(globalThis, 'PublicKeyCredential', {
    value: undefined,
    configurable: true,
    writable: true,
  })
  Object.defineProperty(navigator, 'credentials', {
    value: undefined,
    configurable: true,
    writable: true,
  })
  return () => {
    define(globalThis, 'PublicKeyCredential', previous.pkc)
    define(navigator, 'credentials', previous.creds)
  }
}

function define(target: object, name: string, descriptor: PropertyDescriptor | undefined): void {
  if (descriptor) Object.defineProperty(target, name, descriptor)
  else Reflect.deleteProperty(target, name)
}

function credentialObject(rawId: Uint8Array, extensions: object) {
  return {
    id: '',
    type: 'public-key',
    rawId: rawId.buffer.slice(rawId.byteOffset, rawId.byteOffset + rawId.byteLength),
    response: {},
    getClientExtensionResults: () => extensions,
  }
}

function asBytes(source: BufferSource | undefined): Uint8Array | undefined {
  if (!source) return undefined
  return source instanceof ArrayBuffer ? new Uint8Array(source) : new Uint8Array(
    source.buffer,
    source.byteOffset,
    source.byteLength
  )
}

function key(bytes: Uint8Array): string {
  return [...bytes].join(',')
}
