/* Turning a plan into sentences.
 *
 * The box sends reason codes because it has no idea what language anyone
 * reads. Every word a user sees is decided here.
 *
 * A plan is intent, not prophecy — the box revalidates against fresh state
 * every tick. The copy says "will" rather than "is going to have to", but
 * never promises: "charging at 3 kW" is what it means to do, not a guarantee.
 */

import type { Plan, PlanSlot, PlanReason, SiteMode } from '$lib/protocol/messages'
import { formatPower } from './power'

export const MODE_LABEL: Record<SiteMode, string> = {
  automatic: 'Automatic',
  self_use: 'Use my own solar',
  paused: 'Paused',
}

/** One line under each choice. What it does, in the user's terms. */
export const MODE_HELP: Record<SiteMode, string> = {
  automatic: 'Charges when power is cheap or the sun is spare, and covers the expensive hours.',
  self_use: 'Stores your own solar and uses it later. Ignores prices.',
  paused: 'Nothing is controlled. Your home runs straight off the grid and the sun.',
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

/** Price in whole currency units per kWh, for display beside a slot. */
export function formatPrice(minor: number | null): string | null {
  if (minor === null || !Number.isFinite(minor)) return null
  return (minor / 100).toFixed(2)
}
