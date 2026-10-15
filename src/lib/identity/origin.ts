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

/** The relay. The default remote path until FTW Cloud speaks these frames. */
export const RELAY_HOST = 'relay.ftw.energy'
export const RELAY_URL = `wss://${RELAY_HOST}`

/**
 * FTW Cloud, the host the iPhone app dials (`cloud.ftw.energy` in
 * srcfl/ftw-app `Origin.swift` / `CloudEndpoint`).
 *
 * This app does not open the iPhone's readable session at
 * `wss://cloud.ftw.energy/v1/app?home=`. A parallel port of the relay
 * protocol onto that host keeps this app's frame format, so the switch is
 * which origin the existing `/r/<epoch>/<handle>/app` join uses.
 */
export const CLOUD_HOST = 'cloud.ftw.energy'
export const CLOUD_URL = `wss://${CLOUD_HOST}`

export type CarrierName = 'relay' | 'cloud'

export interface CarrierChoice {
  /** Which host the build prefers. `relay` is the default. */
  name: CarrierName
  /** Origin to dial first, with no path. */
  url: string
  /**
   * The relay, when `url` is the cloud host and the two differ.
   *
   * Used once, when that host never speaks the relay protocol. Absent means
   * stay on `url`, which is today's behaviour.
   */
  fallbackUrl?: string
}

/**
 * Which host carries reads and commands.
 *
 * `carrier` is `VITE_CARRIER`: `cloud` prefers {@link CLOUD_URL} and falls
 * back to the relay; anything else, including unset, keeps the relay. That
 * is the transition default — the cloud path is not deployed until the
 * relay frames land on `cloud.ftw.energy`.
 */
export function resolveCarrier(env: {
  carrier?: string
  cloudUrl?: string
  relayUrl?: string
} = {}): CarrierChoice {
  const relay = stripSlash(env.relayUrl?.trim() || RELAY_URL)
  const cloud = stripSlash(env.cloudUrl?.trim() || CLOUD_URL)
  const flag = (env.carrier ?? '').trim().toLowerCase()
  if (flag === 'cloud' && cloud !== relay) {
    return { name: 'cloud', url: cloud, fallbackUrl: relay }
  }
  return { name: 'relay', url: flag === 'cloud' ? cloud : relay }
}

function stripSlash(url: string): string {
  return url.replace(/\/+$/, '')
}

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
