/* Where this app lives, decided once.
 *
 * Three things have to agree exactly, and they are all here so they cannot
 * drift apart:
 *
 *   - the origin the app is served from
 *   - the host in the QR code the box prints
 *   - the WebAuthn RP ID the passkey is bound to
 *
 * The RP ID is the one that cannot be changed later. A passkey created under
 * one RP ID is invisible under another, so moving it means every household
 * pairs again — FTW is already living through one of those migrations for
 * home.fortytwowatts.com. Deriving it from location.hostname, which is what
 * this replaces, would have quietly minted passkeys under whatever host a
 * preview or staging deploy happened to use, and those would then not work on
 * the real one.
 *
 * PRF output is bound to the RP ID rather than the origin, so this value also
 * decides who may derive the cache-sealing key. Scoped to the app subdomain,
 * never the registrable domain: the box is never an origin, so a wider scope
 * buys nothing and costs the guarantee. See docs/architecture.md.
 */

/** The one origin. */
export const APP_HOST = 'app.ftw.energy'
export const APP_ORIGIN = `https://${APP_HOST}`

/**
 * The WebAuthn relying party.
 *
 * Identical to APP_HOST by construction rather than by coincidence: a passkey
 * created under a different RP ID than the app is served from cannot be used
 * at all, and the failure is silent until someone tries to unlock.
 */
export const RP_ID = APP_HOST
export const RP_NAME = 'FTW'

/** The relay. One value, no setting — see CLAUDE.md. */
export const RELAY_HOST = 'relay.ftw.energy'
export const RELAY_URL = `wss://${RELAY_HOST}`

/**
 * Development runs on localhost, where the RP ID must be the literal hostname.
 *
 * Compiled out of production builds. Left in, an attacker-controlled host
 * ending in '.localhost' would satisfy the check while reading as though the
 * check were enforced.
 */
export function isDevHost(hostname: string): boolean {
  if (!import.meta.env.DEV) return false
  return hostname === 'localhost' || hostname === '127.0.0.1' || hostname.endsWith('.localhost')
}

/**
 * The RP ID to use right now.
 *
 * A constant in production. In development it follows the hostname, because
 * WebAuthn refuses an RP ID that is not a suffix of the origin and there is no
 * way to serve app.ftw.energy from a laptop.
 */
export function currentRpId(): string {
  const host = globalThis.location?.hostname ?? ''
  return isDevHost(host) ? host : RP_ID
}
