/* Names from contract/registry.yaml, in TypeScript.
 *
 * There is no generator in this repository — the box has one — so this file is
 * written by hand and checked instead: tests/registry-contract.test.ts reads
 * contract/registry.yaml and fails when anything here has stopped matching it,
 * and scripts/check-contract-drift.mjs compares this repository's copy of the
 * registry against the box's. That is the same shape as the vendored
 * components' digests, and it is here for the same reason: the registry exists
 * because three separate authorisation namespaces once grew up in this
 * codebase, and a table nothing checks becomes the fourth.
 *
 * Add nothing here that is not in the registry.
 */

/** One object axis, two verb axes. `<object>.<read|write>`. */
export const SCOPES = [
  'ftw.live.read',
  'ftw.history.read',
  'ftw.plan.read',
  'ftw.health.read',
  'ftw.assets.read',
  'ftw.dispatch.write',
  'ftw.mode.write',
  'ftw.members.read',
  'ftw.members.write',
] as const

export type Scope = (typeof SCOPES)[number]

/**
 * What each role carries, with the registry's `'*'` expanded.
 *
 * Roles are a projection over scopes, never a replacement for them: the box
 * checks a scope for a named operation and a role for the passthrough's
 * configure tier, and those are two different questions.
 */
export const ROLE_SCOPES: Record<string, readonly string[]> = {
  owner: SCOPES,
  viewer: ['ftw.live.read'],
}

/** The label the registry gives each role. The app owns no other wording. */
export const ROLE_LABELS: Record<string, string> = {
  owner: 'Owner',
  viewer: 'Viewer',
}

/** Whether a role carries a scope. An unknown role carries nothing. */
export function roleHasScope(role: string, scope: string): boolean {
  return (ROLE_SCOPES[role] ?? []).includes(scope)
}
