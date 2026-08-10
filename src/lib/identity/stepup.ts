/* Proving, right now, that the person holding the phone is its owner.
 *
 * WHAT THIS BUYS, AND WHAT IT DOES NOT. The box cannot verify that a passkey
 * ceremony happened. It has no relationship with the authenticator, and it is
 * deliberately never a WebAuthn relying party — that would need an origin, and
 * docs/architecture.md rejects the box ever being one. So `stepUp: true` on
 * the wire is this app's word, not proof.
 *
 * What it stops is a phone left unlocked on a table being picked up and used
 * to reconfigure a house, because this app will not say `true` without the
 * ceremony below actually running. It stops nothing at all against a modified
 * client — one on an enrolled device can already send a command today.
 *
 * The box's own contribution is one line in its log: the subject, the role,
 * the method, the path and the flag as it arrived. Nothing counts these and
 * nothing rate-limits them, and this comment said otherwise for a release.
 *
 * Run whenever the box refuses a write, not on a schedule this app keeps. The
 * box now remembers a genuine ceremony for a few minutes and waves through the
 * configure calls that follow, so a run of writes usually prompts once — but
 * that window is the box's to measure, not this app's to assume. This layer
 * only ever prompts in answer to a refusal it was actually given; caching an
 * outcome here would be this app deciding how long the box's answer lasts,
 * which is exactly the claim it must not make.
 *
 * Which is why this is deliberately NOT `unlockWrappingKey`. That falls back
 * to the local copy with no prompt when PRF is missing or an assertion fails,
 * which is right for reading and would be a lie here — the app would claim a
 * ceremony that never happened.
 */

import { assertWrappingKey, isUserCancelled, webAuthnAvailable } from './prf'
import { openVaultStore, passkeyCredentialIds } from './vault'

export type StepUpOutcome =
  /** The ceremony ran. */
  | 'done'
  /** The person said no. Their answer, and it stands. */
  | 'declined'
  /** This phone has no passkey to ask for. Nothing to prompt with. */
  | 'unavailable'

/**
 * Run the ceremony, and say honestly which of the three happened.
 *
 * Never throws for the ordinary cases, because all three of them are answers
 * a screen has to be able to say something about.
 */
export async function stepUp(): Promise<StepUpOutcome> {
  if (!webAuthnAvailable()) return 'unavailable'

  const credentialIds = await passkeyCredentialIds(openVaultStore())
  if (credentialIds.length === 0) return 'unavailable'

  try {
    // The return value is the PRF output, which is not what is wanted here —
    // a platform can run a full user-verification ceremony and still have no
    // PRF to give. What is being asked for is the ceremony, and reaching this
    // line without throwing is what says it ran.
    await assertWrappingKey({ credentialIds })
    return 'done'
  } catch (err) {
    if (isUserCancelled(err)) return 'declined'
    // Anything else is this platform failing at something the person holding
    // it cannot fix. It is not a decline, and it is not a ceremony either.
    return 'unavailable'
  }
}

/** What to say when a step-up did not happen. Never a code. */
export function stepUpHelp(outcome: Exclude<StepUpOutcome, 'done'>): string {
  return outcome === 'declined'
    ? 'That needs your face or fingerprint. Try again when you are ready.'
    : 'This phone cannot confirm it is yours. Changes have to be made on your box.'
}
