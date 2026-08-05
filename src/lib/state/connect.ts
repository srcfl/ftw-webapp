/* Building the carrier stack for a paired site.
 *
 *   Session  →  NoiseCarrier  →  RelayCarrier  →  the relay
 *
 * Everything above the session sees state; everything below the Noise carrier
 * sees opaque bytes. This file is the one place the three are wired together,
 * so there is exactly one answer to "how does this app reach a box".
 */

import { NoiseCarrier } from '$lib/carrier/noise'
import { RelayCarrier } from '$lib/carrier/relay'
import type { Carrier } from '$lib/carrier/carrier'
import { openVaultStore, unlockWrappingKey, deviceKey, isEnrolled } from '$lib/identity/vault'
import { db, type StoredSite } from '$lib/store/db'
import { RELAY_URL as DEFAULT_RELAY_URL } from '$lib/identity/origin'

/** Overridable only for development against a local relay. */
export const RELAY_URL = import.meta.env['VITE_RELAY_URL'] ?? DEFAULT_RELAY_URL

/**
 * The rendezvous secret, derived from the box's public key.
 *
 * KNOWN GAP, and deliberately not hidden: the QR payload has no field for a
 * rendezvous secret, so there is nothing long-lived and private to derive a
 * rotating handle from. Deriving it from the box's public key makes the handle
 * stable for the life of the box, which means the relay can correlate one
 * household across epochs — exactly what the rotation exists to prevent.
 *
 * The pairing code is not a substitute: it is single-use, so it cannot be a
 * long-lived anchor, and anyone who ever photographs the QR would hold it.
 *
 * The fix is a fifth QR segment with its own rotation path, and it needs the
 * box side to mint it. Until then this is honest about what it is.
 * See docs/architecture.md, "What is not yet true".
 */
async function rendezvousSecret(boxStaticKey: Uint8Array): Promise<Uint8Array> {
  const salt = new TextEncoder().encode('ftw.rendezvous.v1.provisional')
  const material = new Uint8Array(salt.length + boxStaticKey.length)
  material.set(salt, 0)
  material.set(boxStaticKey, salt.length)
  return new Uint8Array(await crypto.subtle.digest('SHA-256', material as BufferSource))
}

export interface ConnectOptions {
  /** Injected by tests. Defaults to a real relay carrier. */
  makeInner?: (opts: { url: string; secret: Uint8Array }) => Carrier
  relayUrl?: string
}

export class ConnectError extends Error {
  constructor(
    readonly code: 'not_paired' | 'not_enrolled' | 'locked',
    /** What the user does now. */
    readonly help: string
  ) {
    super(code)
    this.name = 'ConnectError'
  }
}

export async function loadSite(siteId: string): Promise<StoredSite | null> {
  const database = await db()
  return (await database.get('sites', siteId)) ?? null
}

/**
 * Build a carrier for a paired site.
 *
 * Prompts for the passkey, because unwrapping the device key needs it. That
 * is why this is never on the cold-start path: the app paints cached readings
 * first and only then asks, so pressing the icon never opens a Face ID sheet
 * before it shows a watt.
 */
export async function connectToSite(siteId: string, opts: ConnectOptions = {}): Promise<Carrier> {
  const site = await loadSite(siteId)
  if (!site) {
    throw new ConnectError('not_paired', 'This home is not paired on this device. Scan its code again.')
  }

  const vault = openVaultStore()
  if (!(await isEnrolled(vault))) {
    throw new ConnectError('not_enrolled', 'This device has no key for that home. Scan its code again.')
  }

  const wrapping = await unlockWrappingKey(vault)
  const device = await deviceKey(vault, wrapping)

  const secret = await rendezvousSecret(site.boxStaticKey)
  const relayUrl = opts.relayUrl ?? RELAY_URL
  const inner = opts.makeInner
    ? opts.makeInner({ url: relayUrl, secret })
    : new RelayCarrier({ url: relayUrl, secret })

  return new NoiseCarrier({
    inner,
    // The non-extractable handle, not raw bytes. Its scalar is never readable
    // by script where the browser has X25519.
    staticKey: device,
    // Pinned optically at enrollment. This is what stops the relay presenting
    // itself as a box.
    remoteStatic: site.boxStaticKey,
    // Binds the session to this box, so a captured handshake cannot be
    // replayed into a different one.
    prologue: prologueFor(site.boxStaticKey),
  })
}

function prologueFor(boxStaticKey: Uint8Array): Uint8Array {
  const tag = new TextEncoder().encode('ftw.session.v1:')
  const out = new Uint8Array(tag.length + boxStaticKey.length)
  out.set(tag, 0)
  out.set(boxStaticKey, tag.length)
  return out
}
