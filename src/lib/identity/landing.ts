/* Where a launch with a pairing fragment should land.
 *
 * The camera opens /p#v2.… in the browser, and after a successful pairing
 * that URL is what gets reloaded, bookmarked, and restored by the browser —
 * with a code that was spent the moment it worked. Re-running it against a
 * box that is already paired shows the owner a pairing screen for a house
 * they are standing in.
 *
 * So a fragment is judged, not obeyed: against a site we already hold, it is
 * a leftover and the app goes home; against an unknown box, it is a genuine
 * invitation and the pairing screen is right.
 */

import { parseEnrollmentFragment } from './enrollment'
import { siteIdFor } from './pairing'

/**
 * The siteId a fragment points at, or null when it points at nothing —
 * unparsable, truncated, or not ours. Null means there is nothing to pair
 * with and the fragment should simply be cleaned off the URL.
 */
export async function fragmentTarget(fragment: string): Promise<string | null> {
  try {
    const enrollment = parseEnrollmentFragment(fragment)
    return await siteIdFor(enrollment.boxStaticPublic)
  } catch {
    return null
  }
}
