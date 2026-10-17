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

/**
 * An object and a verb: `<object>.<read|write|run|hold|request>`. read and
 * write are a phone's; run, hold and request are an agent's (docs/agents.md
 * in srcfl/ftw).
 */
export const SCOPES = [
  'ftw.live.read',
  'ftw.history.read',
  'ftw.plan.read',
  'ftw.health.read',
  'ftw.assets.read',
  'ftw.events.read',
  'ftw.dispatch.write',
  'ftw.mode.write',
  'ftw.members.read',
  'ftw.members.write',
  'ftw.logs.read',
  'ftw.config.read',
  'ftw.diag.run',
  'ftw.dispatch.hold',
  'ftw.goals.request',
  'ftw.update.request',
  'ftw.cars.read',
  'ftw.cars.write',
] as const

export type Scope = (typeof SCOPES)[number]

/** What an assistant or Sourceful support may carry at most. */
const AGENT_SCOPES: readonly string[] = [
  'ftw.live.read',
  'ftw.history.read',
  'ftw.plan.read',
  'ftw.health.read',
  'ftw.events.read',
  'ftw.logs.read',
  'ftw.config.read',
  'ftw.diag.run',
  'ftw.dispatch.hold',
  'ftw.goals.request',
]

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
  watch: ['ftw.live.read', 'ftw.plan.read', 'ftw.events.read', 'ftw.dispatch.write'],
  // Agents: grants an owner gives to an assistant, to Sourceful support or to
  // the release check. The most a grant of each kind may carry; each grant
  // names a subset, and the box enforces it.
  agent: AGENT_SCOPES,
  support: AGENT_SCOPES,
  release: ['ftw.health.read'],
}

/** The label the registry gives each role. The app owns no other wording. */
export const ROLE_LABELS: Record<string, string> = {
  owner: 'Owner',
  viewer: 'Viewer',
  watch: 'Watch',
  agent: 'Assistant',
  support: 'Sourceful support',
  release: 'Release check',
}

/** Whether a role carries a scope. An unknown role carries nothing. */
export function roleHasScope(role: string, scope: string): boolean {
  return (ROLE_SCOPES[role] ?? []).includes(scope)
}

/** The scope the box checks for OP_SET_MODE. */
export const SCOPE_MODE_WRITE: Scope = 'ftw.mode.write'

/** The capability a box offers when its optimizer accepts dispatch. */
export const CAP_PLAN_DISPATCH = 'plan.dispatch'

/** The box accepts its own session through FTW Cloud. */
export const CAP_CLOUD_TUN = 'cloud.tun'

/** The capability a box offers when a charger is among its resources. */
export const CAP_DER_EV = 'der.ev'

/** The box's own API over the session. Absent hides every view that needs it. */
export const CAP_API_PASSTHROUGH = 'api.passthrough'
