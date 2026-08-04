/* Forgetting a device, completely.
 *
 * Identity and the local projection live in two databases, and clearing one
 * without the other is not a partial reset — it is a leak. A phone sold or
 * handed on with the passkey copies gone but the sealed snapshot and its key
 * still present will paint the previous household's readings, device names
 * and source table on its very first frame, because that is exactly what the
 * cold-start path is built to do.
 *
 * So there is one entry point, and it covers both.
 */

import { db } from './db'
import { resetIdentity, type VaultStore } from '$lib/identity/vault'

/**
 * Clear everything this origin holds about this device and its homes.
 *
 * The box keeps the record, so nothing is lost that cannot be recovered by
 * pairing again. Best effort by design: a store that fails to clear must not
 * stop the others from clearing, since a half-cleared device is the outcome
 * this function exists to prevent.
 */
export async function forgetEverything(vault: VaultStore): Promise<void> {
  const failures: unknown[] = []

  try {
    await resetIdentity(vault)
  } catch (err) {
    failures.push(err)
  }

  try {
    const database = await db()
    // 'prefs' survives: theme and units are not the previous owner's data,
    // and losing them makes a reset feel like a fault.
    for (const store of ['keys', 'sites', 'snapshot', 'tiles', 'meta'] as const) {
      await database.clear(store)
    }
  } catch (err) {
    failures.push(err)
  }

  if (failures.length > 0) {
    throw new AggregateError(failures, 'some stores could not be cleared')
  }
}
