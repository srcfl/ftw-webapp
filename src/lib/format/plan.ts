/* Turning a plan into sentences.
 *
 * The box sends reason codes because it has no idea what language anyone
 * reads. Every word a user sees is decided here.
 *
 * A plan is intent, not prophecy — the box revalidates against fresh state
 * every tick. The copy says "will" rather than "is going to have to", but
 * never promises: "charging at 3 kW" is what it means to do, not a guarantee.
 */

import type { Plan, PlanSlot, PlanReason, SiteMode, ModeInfo } from '$lib/protocol/messages'
import { toDisplay, unitFor } from '$vendor/ftw/price-units.js'
import { formatPower } from './power'

/**
 * Mode wording comes from the box, not from here.
 *
 * control.ModeCatalog() is FTW's single source of truth for how a mode is
 * presented, and its own dashboard builds buttons from that same list. An app
 * that renamed them would give the same setting two names — one in FTW's web
 * UI, one here — and support would have to know both.
 *
 * So this returns what the box sent. When the wording should change, it
 * changes in ModeCatalog() and both surfaces follow at once. That is the
 * point of the contract.
 *
 * TRANSLATION, when i18n lands, goes here: keyed by mode key, translating
 * FTW's English rather than replacing it. Rewriting in English is not
 * translation, it is divergence.
 */
const TRANSLATIONS: Record<string, Record<string, { label: string; help: string }>> = {}

/** The current locale's wording if we have it, the box's otherwise. */
export function modeLabel(info: ModeInfo, locale = 'en'): string {
  return TRANSLATIONS[locale]?.[info.key]?.label ?? info.label
}

export function modeHelp(info: ModeInfo, locale = 'en'): string {
  return TRANSLATIONS[locale]?.[info.key]?.help ?? info.tooltip
}

/** True when a translation exists. Used by tests and diagnostics only. */
export function hasTranslation(key: SiteMode, locale = 'en'): boolean {
  return TRANSLATIONS[locale]?.[key] !== undefined
}

const REASON_TEXT: Record<PlanReason, string> = {
  cheap_import: 'Power is cheap',
  expensive_import: 'Power is expensive',
  solar_surplus: 'Spare solar',
  peak_shaving: 'Holding the grid limit',
  reserve_held: 'Keeping a reserve',
  export_paid: 'Sending to the grid',
  idle: 'Nothing scheduled',
}

export function reasonText(reason: PlanReason): string {
  return REASON_TEXT[reason]
}

/** What the battery does in a slot, as a verb a person would use. */
export function slotAction(slot: PlanSlot): 'charge' | 'discharge' | 'idle' {
  if (slot.batteryW > 50) return 'charge'
  if (slot.batteryW < -50) return 'discharge'
  return 'idle'
}

export interface PlanHeadline {
  text: string
  /** The slot the sentence is about, for highlighting. Null when general. */
  slotIndex: number | null
}

/**
 * One sentence about what happens next.
 *
 * Deliberately about the *next change*, not the current slot: a person opening
 * the app already sees what is happening now on the Now screen. What they
 * cannot see is what is about to happen, and that is the reason to look at a
 * plan at all.
 */
export function planHeadline(plan: Plan | null, nowMs: number): PlanHeadline {
  if (!plan) return { text: 'No plan yet.', slotIndex: null }

  if (plan.stale) {
    return {
      text: "Your box couldn't plan ahead just now, so it's running on safe defaults.",
      slotIndex: null,
    }
  }

  const current = plan.slots.findIndex(
    (s) => nowMs >= s.startMs && nowMs < s.startMs + s.durationMs
  )
  if (current === -1) return { text: 'No plan for right now.', slotIndex: null }

  const now = plan.slots[current]!
  const nowAction = slotAction(now)

  // Find where it stops doing what it is doing.
  let next = current + 1
  while (next < plan.slots.length && slotAction(plan.slots[next]!) === nowAction) next++

  if (next >= plan.slots.length) {
    return { text: describeSlot(now, 'now'), slotIndex: current }
  }

  const change = plan.slots[next]!
  const inMs = change.startMs - nowMs

  return {
    text: `${describeSlot(now, 'now')} Then ${describeSlot(change, 'later').toLowerCase()} ${inWords(inMs)}.`,
    slotIndex: current,
  }
}

function describeSlot(slot: PlanSlot, when: 'now' | 'later'): string {
  const action = slotAction(slot)
  const power = formatPower(slot.batteryW)
  const amount = `${power.text} ${power.unit}`

  if (action === 'idle') {
    return when === 'now'
      ? `The battery is resting — ${reasonText(slot.reason).toLowerCase()}.`
      : 'it rests'
  }

  const verb = action === 'charge' ? 'charging' : 'covering the house'
  if (when === 'now') {
    return `The battery is ${verb} at ${amount} — ${reasonText(slot.reason).toLowerCase()}.`
  }
  return action === 'charge' ? `it charges at ${amount}` : `it covers the house at ${amount}`
}

/**
 * Coarse on purpose.
 *
 * "In 47 minutes" invites people to check whether it was 47, and a plan is
 * intent that will be revised. Rounding to something a person would say keeps
 * the promise the plan can actually keep.
 */
function inWords(ms: number): string {
  const minutes = Math.round(ms / 60_000)
  if (minutes < 1) return 'in a moment'
  if (minutes < 25) return `in ${minutes} min`
  if (minutes < 50) return 'in about half an hour'
  const hours = Math.round(minutes / 60)
  if (hours <= 1) return 'in about an hour'
  if (hours < 10) return `in about ${hours} hours`
  return 'later today'
}

/**
 * A slot's price, for display beside it — in the chart's unit, to the chart's
 * precision.
 *
 * The chart directly above the timeline prices the same hours, and it reads
 * this table for every number it draws. Anything else here puts two numbers
 * for 21:00 one above the other in units a hundred apart: 144.0 öre on the
 * chart, 1.44 on the timeline, and a reader left to work out that they are
 * the same money. The unit is named once above the column rather than on
 * every row, which is what `unitPerKwh` is for.
 */
export function formatPrice(minor: number | null, currency: string): string | null {
  if (minor === null || !Number.isFinite(minor)) return null
  return toDisplay(minor, currency).toFixed(unitFor(currency).decimals)
}
