import { SCOPE_SETUP_WRITE } from '$lib/protocol/contract'

/**
 * Names that mean UTC. A box that says one has no household clock of its own:
 * a Docker host runs on UTC whatever house it is in. A device that says one
 * knows nothing about the house either.
 */
const UTC_NAME = /^(Etc\/)?(UTC|UCT|GMT|GMT0|GMT[+-]0|Greenwich|Universal|Zulu)$/

export function isUtcName(zone: string): boolean {
  return UTC_NAME.test(zone)
}

/** This device's IANA zone, or null where the platform does not say. */
export function deviceTimeZone(): string | null {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || null
  } catch {
    return null
  }
}

/**
 * The zone this device offers the box as its household clock, or null.
 *
 * Only a box on UTC is offered one, and only by a device allowed to change
 * setup. The box decides: it takes the zone only while it keeps none, so a
 * phone abroad cannot move a house's clock.
 */
export function timeZoneToOffer(
  boxTz: string | null | undefined,
  deviceTz: string | null | undefined,
  scopes: ReadonlySet<string>,
): string | null {
  if (!boxTz || !isUtcName(boxTz.trim())) return null
  if (!deviceTz || isUtcName(deviceTz)) return null
  return scopes.has(SCOPE_SETUP_WRITE) ? deviceTz : null
}
