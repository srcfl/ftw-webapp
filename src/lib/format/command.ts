/* Sentences for a command's fate. The box never writes prose.
 *
 * One table for every op, because the codes are about the DOOR, not about
 * what was asked: an expired mode change and an expired charge-now failed
 * the same way, and a person needs the same sentence — what happens now,
 * and whether trying again can help.
 */

import type { CmdResult } from '$lib/protocol/messages'

/** Stable codes in, sentences out. */
export function commandHelp(result: CmdResult): string {
  switch (result.error?.code) {
    case 'E_PRECONDITION':
      return 'Your home changed while that was sending. Have another go.'
    case 'E_CONFLICT':
      return 'Something else changed the setting first. Try again.'
    case 'E_SCOPE_DENIED':
      return "You don't have permission to change how this home runs."
    case 'E_CMD_EXPIRED':
      return 'That took too long to reach your box. Try again.'
    case 'E_BOOTING':
      return 'Your box is still starting. Give it a minute.'
    case 'E_UNAVAILABLE':
      if (result.error.args?.['op'] === 'loadpoint.surplus_only.set') return 'Solar rule not saved. Your previous choice is unchanged. Try again.'
      return "Your box can't reach the charger right now. Try again shortly."
    default:
      return "That didn't go through. Try again."
  }
}

/**
 * The boost's own refusals, before the door's.
 *
 * The box answers a boost the live site cannot carry with E_UNAVAILABLE
 * naming the op — the session's spelling of the HTTP 409 — and a lease
 * outside its bounds with E_UNKNOWN_OP naming `lease`. Neither is the
 * charger being out of reach, which is what the shared table says for
 * E_UNAVAILABLE, so they get their own sentences and everything else falls
 * through to it.
 */
export function boostHelp(result: CmdResult): string {
  const e = result.error
  if (e?.code === 'E_UNAVAILABLE' && typeof e.args?.['op'] === 'string') {
    return "Your box won't boost right now — the house battery or the site isn't ready for it."
  }
  if (e?.code === 'E_UNKNOWN_OP' && e.args?.['arg'] === 'lease') {
    return 'Your box refused that reserve and time. Try other values.'
  }
  return commandHelp(result)
}

/**
 * The level correction's own refusal, before the door's.
 *
 * The box refuses a level for a car that is not on the cable with
 * E_UNAVAILABLE naming the op and `reason: "unplugged"` — the session's
 * spelling of the HTTP route's 409. That is not the charger being out of
 * reach, so it gets its own sentence and everything else falls through.
 */
export function socHelp(result: CmdResult): string {
  const e = result.error
  if (e?.code === 'E_UNAVAILABLE' && e.args?.['reason'] === 'unplugged') {
    return 'Plug the car in first — your box has no car to set a level for.'
  }
  return commandHelp(result)
}
