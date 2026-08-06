/* Leaving a home, in the order that survives being interrupted.
 *
 * Clearing the disk is only half of it. The other half is in memory: a live
 * session that is still receiving frames, and a snapshot writer holding the
 * last one on a fifteen-second timer. Clear the disk while those are running
 * and the very next flush writes the home straight back — a sealed reading
 * belonging to a household this phone has just left, under a cache key
 * generated on demand to replace the one that was cleared a moment earlier.
 *
 * So the stream stops first, and the disk is cleared second. Anything that
 * kills the app between the two leaves a device that is still paired and still
 * works, which is the only kind of interruption worth having.
 *
 * It throws when the disk could not be cleared. The caller has to be able to
 * put the home back on screen rather than show a pairing screen for one that
 * is still sitting there.
 */

import { forgetEverything } from '$lib/store/reset'
import { openVaultStore, type VaultStore } from '$lib/identity/vault'

export interface Leaving {
  /** The live projection of the home being left. */
  home: { destroy(): void }
  /** Whatever is feeding it — the development simulator, or nothing. */
  stopFeed?: (() => void) | undefined
  /** Injected by tests. */
  vault?: VaultStore
}

export async function leaveHome({ home, stopFeed, vault }: Leaving): Promise<void> {
  stopFeed?.()
  home.destroy()
  await forgetEverything(vault ?? openVaultStore())
}
