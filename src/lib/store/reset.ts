/* Leaving a home, from the phone.
 *
 * A home lives on this device in three places: a pointer in localStorage that
 * the launch path reads before any module exists, a projection in the 'ftw'
 * database, and a key in the 'ftw-identity' one. Clearing one without the
 * others is not a partial sign-out — each combination is its own fault.
 *
 * So there is one entry point, and the order it works in is the design:
 *
 *   1. The pointer. It is a hint the database can rebuild, so losing it alone
 *      changes nothing — and keeping it after the rows are gone strands the
 *      next launch on a home that no longer exists, with no route back to the
 *      pairing screen.
 *   2. The projection, cache before rows. Every prefix of this leaves a phone
 *      that still works with less cached, right up to the last step, which is
 *      the one that makes it unpaired.
 *   3. The key, last, and only if the rows it authorises really went. A key
 *      without rows is a device back at pairing, and pairing reuses it. Rows
 *      without a key is a house on screen that can never be reached again,
 *      and no amount of reloading fixes that.
 *
 * The phone leaving is not the box forgetting it. The box keeps this device on
 * its list until someone removes it there; the sign-out screen says so, because
 * a claim we cannot keep is worse than the extra sentence.
 */

import { db } from './db'
import { clearCurrentSite } from '$lib/identity/pairing'
import { resetIdentity, type VaultStore } from '$lib/identity/vault'

/**
 * Everything that projects a home, in the order it is safe to lose.
 *
 * 'prefs' is not here: theme and units are not the previous owner's data, and
 * losing them makes signing out feel like a fault. It is the only store that
 * may be missing from this list, and a test in reset.test.ts holds the list to
 * the schema so a store added later cannot quietly outlive a sign-out.
 */
export const PROJECTION = ['snapshot', 'tiles', 'meta', 'sites', 'keys'] as const

/**
 * Clear everything this origin holds about this device and its homes.
 *
 * The box holds the record, so nothing is lost here that pairing again cannot
 * recover. Throws when the projection could not be cleared — the caller has to
 * be able to say "this is still on your phone" rather than show a pairing
 * screen for a home that is still sitting on the disk.
 */
export async function forgetEverything(vault: VaultStore): Promise<void> {
  clearCurrentSite()

  const failures: unknown[] = []
  try {
    const database = await db()
    // Best effort within the projection: one store that refuses must not stop
    // the rest, because more cleared is strictly better than less — with one
    // exception, and it is the ordering rule at the top of this file.
    for (const store of PROJECTION) {
      // The key is what makes the rows readable. Clearing it while a row it
      // sealed is still on the disk leaves a house that can never be opened
      // again: the next launch mints a fresh key, unsealing throws, and the
      // app paints nothing at all. A phone that still works and a sign-out
      // that says it did not finish is the better of the two.
      if (store === 'keys' && failures.length > 0) break
      try {
        await database.clear(store)
      } catch (err) {
        failures.push(err)
      }
    }
  } catch (err) {
    failures.push(err)
  }

  if (failures.length > 0) {
    // Deliberately before resetIdentity. A site row that outlived its key is
    // the one state this device cannot heal from on its own.
    throw new AggregateError(failures, 'this device still holds a home')
  }

  try {
    await resetIdentity(vault)
  } catch {
    // The rows are gone, so this device is signed out whatever happens here.
    // A surviving device key reaches nothing without a pinned box key and a
    // rendezvous secret, and the next pairing reuses it — which is what it
    // does for a phone that never signed out at all. Nothing to report and
    // nothing for anyone to do.
  }
}
