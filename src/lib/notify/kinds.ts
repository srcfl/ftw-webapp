/* The push kinds, for the toggles and nothing else.
 *
 * The sentences live in contract/push-catalogue.yaml and are rendered by the
 * box — a push must read as a sentence when this app is not running to write
 * one. The app never parses the catalogue at runtime: all it needs is which
 * kinds exist, so someone can turn each one off. This list is that, written
 * by hand and held to the catalogue by tests/push-contract.test.ts the same
 * way the protocol tables are held to the registry.
 */

export const KINDS = [
  'charging.session_complete',
  'charging.interrupted',
  'update.installed',
  'box.unreachable',
] as const

export type PushKind = (typeof KINDS)[number]

/**
 * The kinds the box's rules document governs. box.unreachable is not among
 * them and cannot be: the box cannot gate a message about its own absence —
 * the relay holds that one, and it follows the subscription itself. Turning
 * notifications off is what turns it off.
 */
export const RULE_KINDS = KINDS.filter((k) => k !== 'box.unreachable')

/**
 * What each toggle says. The app's prose, not the catalogue's: the catalogue
 * writes the notification itself, this names the decision to receive it.
 */
export const KIND_LABELS: Record<PushKind, string> = {
  'charging.session_complete': 'When the car finishes charging',
  'charging.interrupted': 'If charging stops before it is done',
  'update.installed': 'When your box updates itself',
  'box.unreachable': 'If your box goes out of reach',
}
