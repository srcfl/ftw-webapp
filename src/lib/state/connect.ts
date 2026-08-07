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
import {
  openVaultStore,
  silentWrappingKey,
  unlockWrappingKey,
  ensureLocalCopy,
  deviceKey,
  isEnrolled,
} from '$lib/identity/vault'
import { db, type StoredSite } from '$lib/store/db'
import { RELAY_URL as DEFAULT_RELAY_URL } from '$lib/identity/origin'

/** Overridable only for development against a local relay. */
export const RELAY_URL = import.meta.env['VITE_RELAY_URL'] ?? DEFAULT_RELAY_URL

export interface ConnectOptions {
  /** Injected by tests. Defaults to a real relay carrier. */
  makeInner?: (opts: { url: string; secret: Uint8Array }) => Carrier
  relayUrl?: string
}

/**
 * No carrier could be built from what this phone holds.
 *
 * Every other failure on this path heals itself, because the carrier
 * reconnects from the inside. These are the ones where there is nothing to
 * reconnect, so the app has to offer a way back rather than promise it keeps
 * trying — see the pairing screen, which is what the offer opens.
 *
 * `help` says what happened and stops there. It used to end "Scan its code
 * again", which was one of three ways in and not always the one that works:
 * a phone with no key cannot spend a typed code, and a phone whose box has
 * simply forgotten it is not helped by a sealed copy of the key it refused.
 * Naming the ways is the screen's job, because the screen is where they are.
 */
export class ConnectError extends Error {
  constructor(
    readonly code: 'not_paired' | 'not_enrolled' | 'locked' | 'stale_pairing',
    /** What happened, in words the person holding the phone can act on. */
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
 * Build a carrier for a paired site — silently, in the ordinary case.
 *
 * Reading your own house is not a privilege, so connecting unlocks the device
 * key with the local copy and never prompts. The one exception is a device
 * enrolled before the local copy existed: it pays one final passkey prompt,
 * ensureLocalCopy records the result, and every start after that is silent.
 * PRF keeps guarding what it was always for — enrollment and privileged
 * commands — not the act of looking.
 */
export async function connectToSite(siteId: string, opts: ConnectOptions = {}): Promise<Carrier> {
  const site = await loadSite(siteId)
  if (!site) {
    throw new ConnectError('not_paired', 'This phone has no record of that home.')
  }

  const vault = openVaultStore()
  if (!(await isEnrolled(vault))) {
    throw new ConnectError('not_enrolled', 'This device has no key for that home.')
  }

  // Read from the QR, never derived. A handle derived from the box's public
  // key would be stable for the life of the box, which hands the relay
  // operator one household identifier good for years — the exact thing the
  // hourly rotation exists to deny it.
  const secret = site.rendezvousSecret
  if (!secret) {
    throw new ConnectError(
      'stale_pairing',
      'This home was paired before this app could reach it privately.'
    )
  }

  let wrapping = await silentWrappingKey(vault)
  if (!wrapping) {
    // Enrolled when PRF wrapped the only copy. One last prompt, then the
    // local copy exists and this branch never runs again on this device.
    wrapping = await unlockWrappingKey(vault)
    await ensureLocalCopy(vault, wrapping)
  }
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
