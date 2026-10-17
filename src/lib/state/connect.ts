/* Building the carrier stack for a paired site.
 *
 *   Session → NoiseCarrier → CloudTunnelCarrier → FTW Cloud
 *
 * Everything above the session sees state; everything below the Noise carrier
 * sees opaque bytes. This file is the one place the three are wired together,
 * so there is exactly one answer to "how does this app reach a box".
 */

import { NoiseCarrier } from '$lib/carrier/noise'
import { CloudTunnelCarrier, type CloudOptions } from '$lib/carrier/cloud'
import type { Carrier } from '$lib/carrier/carrier'
import { validHome } from '$lib/protocol/cloud'
import { CAP_CLOUD_TUN } from '$lib/protocol/contract'
import { decodeFrame } from '$lib/protocol/frame'
import {
  openVaultStore,
  silentWrappingKey,
  unlockWrappingKey,
  ensureLocalCopy,
  deviceKey,
  isEnrolled,
} from '$lib/identity/vault'
import { db, type StoredSite } from '$lib/store/db'
import { markLinkPhase } from '$lib/perf/link'

export interface ConnectOptions {
  /** Injected by tests. Production always opens FTW Cloud. */
  makeCloud?: (opts: CloudOptions) => Carrier
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

  if (!validHome(site.cloudHome)) {
    throw new ConnectError(
      'stale_pairing',
      'Pair this home again. Open your box’s local dashboard, then Settings → FTW app → Show pairing code, and scan the new QR.'
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
  markLinkPhase('keys-ready')

  const cloudOptions: CloudOptions = {
    home: site.cloudHome ?? '', staticKey: device,
    ...(site.pairingCode ? { pairingCode: site.pairingCode } : {}),
  }
  const inner = opts.makeCloud ? opts.makeCloud(cloudOptions) : new CloudTunnelCarrier(cloudOptions)

  const noise = new NoiseCarrier({
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
  // Only the authenticated box session may supply the box's signing key.
  noise.onFrame(bytes => {
    try {
      const frame = decodeFrame(bytes)
      if (frame.envelope.t !== 'hello_ok') return
      void rememberCloudKey(siteId, frame.envelope.b).catch(() => {
        // A failed cache write leaves the existing route usable.
      })
    } catch { /* Session owns malformed box frames. */ }
  })
  return noise
}

async function rememberCloudKey(siteId: string, hello: unknown): Promise<void> {
  if (!hello || typeof hello !== 'object') return
  const value = hello as { caps?: unknown; cloud?: { home?: unknown; pk?: unknown } }
  if (!Array.isArray(value.caps) || !value.caps.includes(CAP_CLOUD_TUN)) return
  const home = value.cloud?.home
  const pk = value.cloud?.pk
  if (!validHome(home) || !(pk instanceof Uint8Array) || pk.length !== 65 || pk[0] !== 4) return
  const database = await db()
  const tx = database.transaction('sites', 'readwrite')
  const row = await tx.store.get(siteId)
  if (row?.cloudHome === home) {
    const { pairingCode: _spent, ...kept } = row
    await tx.store.put({ ...kept, cloudKey: pk })
  }
  await tx.done
}

function prologueFor(boxStaticKey: Uint8Array): Uint8Array {
  const tag = new TextEncoder().encode('ftw.session.v1:')
  const out = new Uint8Array(tag.length + boxStaticKey.length)
  out.set(tag, 0)
  out.set(boxStaticKey, tag.length)
  return out
}
