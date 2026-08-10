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
      return "Your box can't reach the charger right now. Try again shortly."
    default:
      return "That didn't go through. Try again."
  }
}
