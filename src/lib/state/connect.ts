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

export interface ConnectOptions {
  /** Injected by tests. Defaults to a real relay carrier. */
  makeInner?: (opts: { url: string; secret: Uint8Array }) => Carrier
  relayUrl?: string
}

export class ConnectError extends Error {
  constructor(
    readonly code: 'not_paired' | 'not_enrolled' | 'locked' | 'stale_pairing',
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

  // Read from the QR, never derived. A handle derived from the box's public
  // key would be stable for the life of the box, which hands the relay
  // operator one household identifier good for years — the exact thing the
  // hourly rotation exists to deny it.
  const secret = site.rendezvousSecret
  if (!secret) {
    throw new ConnectError(
      'stale_pairing',
      'This home was paired before this app could reach it privately. Scan its code again.'
    )
  }

  const wrapping = await unlockWrappingKey(vault)
  const device = await deviceKey(vault, wrapping)

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
    // Message 1's payload, which is how the box learns this device is
    // allowed. It spends the code once and remembers the key it came with,
    // so a session after that is authorised by the key alone and the payload
    // is ignored.
    ...(site.pairingCode ? { handshakePayload: site.pairingCode } : {}),
  })
}

function prologueFor(boxStaticKey: Uint8Array): Uint8Array {
  const tag = new TextEncoder().encode('ftw.session.v1:')
  const out = new Uint8Array(tag.length + boxStaticKey.length)
  out.set(tag, 0)
  out.set(boxStaticKey, tag.length)
  return out
}
