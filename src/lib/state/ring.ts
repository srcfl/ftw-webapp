/* The ring on Now, as the iOS app draws it (Ring / Quiet, chosen by Fredrik
 * on 24 October 2026).
 *
 * The home's use sits in the middle of a ring. The sun is top left, the
 * battery top right, the grid bottom left and the car bottom right, each as
 * text on the ground. Each one owns the quarter of the ring that faces it,
 * and its arc lights from that quarter's middle out, longer with more power.
 * A node whose partner across the middle is missing moves onto the middle
 * axis, so a home with no car is a Y.
 *
 * Everything here is a plain function of the readings and the room, so the
 * drawing and its tests agree. The numbers are the phone's: the iOS app's
 * NowFlow.swift and Flow.swift, and a change to one belongs in both.
 */

import type { ControlMark, ControlScope } from '$vendor/ftw/control-feedback.js'
import { FLOW_IDLE_W, type FlowPlanet, type FlowReadings } from './flow'

export type RingNode = 'solar' | 'battery' | 'home' | 'grid' | 'car'

export type RingSpot = 'topLeading' | 'topTrailing' | 'bottomLeading' | 'bottomTrailing' | 'top' | 'bottom' | 'center'

/** One node as Now draws it. */
export interface RingReading {
  node: RingNode
  /** Watts as shown, never signed: the direction is in `word`. Null when
   *  the box sends no such reading. */
  watts: number | null
  /** What it does, lower case: making, charging, buying, using… */
  word: string
  /** Its energy's colour, for its name and arc while live. */
  color: string
  /** Power flows toward the home. Decides which way the light runs. */
  towardHome: boolean
  /** The battery's charge, or the car's level, in percent. */
  levelPct: number | null
  /** The box confirms this reading live. Only then does anything glow or move. */
  live: boolean
  /** Core's warning or alarm on this node, or null while all is well. */
  mark: ControlMark | null
  /** What a tap opens, or null where there is nothing to open. */
  scope: ControlScope | null
}

/** Above the idle line: worth a beam of light. */
export function flowing(r: RingReading): boolean {
  return (r.watts ?? 0) > FLOW_IDLE_W
}

export const NODE_TITLE: Record<RingNode, string> = {
  solar: 'Solar',
  battery: 'Battery',
  home: 'Usage',
  grid: 'Grid',
  car: 'Car',
}

/** The order Now draws its nodes in, as the phone does. */
const ORDER: RingNode[] = ['solar', 'battery', 'home', 'grid', 'car']

const ROLE: Record<Exclude<RingNode, 'home'>, FlowPlanet['role']> = {
  solar: 'pv',
  battery: 'battery',
  grid: 'grid',
  car: 'ev',
}

const idle = (w: number) => Math.abs(w) <= FLOW_IDLE_W

/** A planet that only holds a place: no reading behind it. */
const empty = (p: FlowPlanet) => p.placeholder === true || p.sub === 'no data'

/** Several devices of one kind fold into one node, as on the phone. */
function fold(node: Exclude<RingNode, 'home'>, first: FlowPlanet, group: FlowPlanet[], live: boolean): RingReading {
  const real = group.filter((p) => !empty(p))
  const scope: ControlScope | null = group.every((p) => p.clickable === false)
    ? null
    : group.length === 1
      ? { role: first.role, name: first.name ?? null, id: first.id }
      : { role: first.role, name: null, id: `agg-${first.role}` }
  const mark = strongest(group)
  const base = { node, mark, scope, live: live && real.length > 0 }
  if (real.length === 0) {
    return { ...base, watts: null, word: 'no reading', color: color(node, 0), towardHome: node !== 'car', levelPct: null }
  }
  // Signed into the home's side of each device: what a battery takes is
  // positive, as is what the grid sells to the home. The planets carry a
  // magnitude and a direction, so the sign is rebuilt from both.
  const signed = real.reduce((sum, p) => {
    const kw = Math.abs(p.kw) * 1000
    switch (node) {
      case 'solar': return sum + p.kw * 1000
      case 'battery': return sum + (p.toHub ? -kw : kw)
      case 'grid': return sum + (p.toHub ? kw : -kw)
      case 'car': return sum + kw
    }
  }, 0)
  const socs = real.map((p) => p.soc).filter((s): s is number => typeof s === 'number' && Number.isFinite(s))
  const level = node === 'battery'
    ? (socs.length ? Math.round(socs.reduce((a, b) => a + b, 0) / socs.length) : null)
    : node === 'car' && socs.length === 1 && socs[0] !== undefined ? Math.round(socs[0]) : null
  return {
    ...base,
    watts: Math.abs(signed),
    word: word(node, signed),
    color: color(node, signed),
    towardHome: node === 'battery' ? signed < 0 : node === 'grid' ? signed >= 0 : node === 'solar',
    levelPct: level,
  }
}

function word(node: RingNode, w: number): string {
  switch (node) {
    case 'solar': return idle(w) ? 'resting' : 'making'
    case 'battery': return idle(w) ? 'resting' : w > 0 ? 'charging' : 'giving power'
    case 'grid': return idle(w) ? 'balanced' : w > 0 ? 'buying' : 'selling'
    case 'car': return idle(w) ? 'resting' : 'charging'
    case 'home': return 'using'
  }
}

/** The node's own colour: its kind, and for the battery which way it runs. */
function color(node: RingNode, w: number): string {
  switch (node) {
    case 'solar': return 'var(--energy-generation)'
    case 'battery': return !idle(w) && w < 0 ? 'var(--energy-gives)' : 'var(--energy-storage)'
    case 'grid': return 'var(--energy-import)'
    case 'car': return 'var(--energy-mobility)'
    case 'home': return 'var(--fg)'
  }
}

function strongest(group: FlowPlanet[]): ControlMark | null {
  const marks = group.map((p) => p.controlMark).filter((m): m is ControlMark => !!m)
  if (!marks.length) return null
  const tone = marks.some((m) => m.tone === 'alarm') ? 'alarm' : 'warning'
  const n = marks.filter((m) => m.tone === tone).length
  const [only] = marks
  return {
    tone,
    label: only && marks.length === 1 ? only.label : `${n} ${n === 1 ? 'device needs' : 'devices need'} attention`,
  }
}

/**
 * Now's nodes from the readings the hero used to take.
 *
 * The grid and the home are always drawn, so a missing meter reads as
 * unknown. Any other kind appears only when the box has a device of it.
 */
export function ringReadings(r: FlowReadings, live: boolean): RingReading[] {
  const out: RingReading[] = []
  for (const node of ORDER) {
    if (node === 'home') {
      out.push({
        node, watts: Math.max(0, r.load * 1000), word: 'using', color: color('home', 0), towardHome: false,
        levelPct: null, live, mark: null, scope: { role: 'load' },
      })
      continue
    }
    const group = r.planets.filter((p) => p.role === ROLE[node])
    const [first] = group
    if (!first) continue
    out.push(fold(node, first, group, live))
  }
  return out
}

// ---------- where each node sits ----------

export function ringSpot(node: RingNode, nodes: readonly RingNode[]): RingSpot {
  const has = (n: RingNode) => nodes.includes(n)
  switch (node) {
    case 'home': return 'center'
    case 'solar': return has('battery') ? 'topLeading' : 'top'
    case 'battery': return has('solar') ? 'topTrailing' : 'top'
    case 'grid': return has('car') ? 'bottomLeading' : 'bottom'
    case 'car': return has('grid') ? 'bottomTrailing' : 'bottom'
  }
}

export const onAxis = (s: RingSpot) => s === 'top' || s === 'bottom'

/** Degrees left open between two quarters of the ring. */
export const RING_GAP = 14

/**
 * The middle of a node's arc, in degrees clockwise from three o'clock with y
 * down, as a canvas draws: the quarter facing its corner, or straight up or
 * down for a node on the axis.
 */
export function ringAngle(spot: RingSpot): number {
  switch (spot) {
    case 'topLeading': return 225
    case 'topTrailing': return 315
    case 'bottomTrailing': return 45
    case 'bottomLeading': return 135
    case 'top': return 270
    case 'bottom': return 90
    case 'center': return 0
  }
}

export interface RingArc {
  /** The whole quarter the node may light. */
  track: [number, number]
  /** The part it lights, centred in it, or null at rest. */
  lit: [number, number] | null
}

/** A node's arc: a stronger flow grows both ways, so the quarter's middle
 *  always faces the node. */
export function ringArc(spot: RingSpot, fill: number): RingArc {
  const mid = ringAngle(spot)
  const half = (90 - RING_GAP) / 2
  const f = Math.min(1, Math.max(0, fill))
  return {
    track: [mid - half, mid + half],
    lit: f > 0.001 ? [mid - half * f, mid + half * f] : null,
  }
}

/**
 * How much of its quarter a node's arc lights: none at rest, a fifth at
 * 0.6 kW, half at 1.8 kW, nine tenths at 6 kW. One curve for every node, so
 * arcs compare across the ring, and it saturates, so an 11 kW charger never
 * swallows the rest.
 */
export function ringFill(kw: number): number {
  const a = Math.abs(kw)
  if (!Number.isFinite(a) || a * 1000 <= FLOW_IDLE_W) return 0
  return Math.min(1, Math.max(0.12, 1 - Math.exp(-a / 2.5)))
}

// ---------- the room it takes ----------

/** A corner label's type, in CSS pixels: name, figure, word. */
export const LABEL_TYPE = { name: 15, figure: 30, unit: 15, word: 14 } as const

/** A corner label's height for its three rows. */
export function labelHeight(t: { name: number; figure: number; word: number } = LABEL_TYPE): number {
  return Math.min(t.name, 18) * 1.3 + t.figure * 1.2 + t.word * 1.3 + 2
}

/** A corner label's width: 38 % of the flow, from 92 px to 140 px. */
export function nodeWidth(width: number): number {
  return Math.min(140, Math.max(92, width * 0.38))
}

export interface RingGeometry {
  cx: number
  cy: number
  /** Through the middle of the arcs. */
  diameter: number
  radius: number
  thickness: number
  /** The hub's circle inside it. */
  hub: number
  /** The height of the box whose corners hold the labels. */
  box: number
  /** What the labels are drawn at, of their size: 1 unless they would touch the least ring. */
  labelScale: number
}

/** Below it the home's figure has no room. */
export const LEAST_RING = 120
const LEAST_SCALE = 0.7

const thick = (d: number) => Math.max(7, Math.round(d * 0.042))

/** How far above the middle a corner label's inner edge clears the ring. */
function clearance(d: number, dx: number): number {
  const reach = d / 2 + thick(d) / 2 + 10
  return dx < reach ? Math.sqrt(reach * reach - dx * dx) : 0
}

/**
 * The largest ring, up to 62 % of the width and 300 px, whose corner labels
 * clear it by 10 px, with the labels in the corners of a box just tall
 * enough for that. Where even the least ring leaves too little height the
 * labels shrink rather than touch it.
 */
export function ringGeometry(width: number, height: number, label: number, labelWidth: number, axis: boolean): RingGeometry {
  const dx = axis ? 0 : Math.max(0, width / 2 - labelWidth)
  const box = (d: number) => 2 * (clearance(d, dx) + label)
  let d = Math.min(width * 0.62, 300)
  while (d > LEAST_RING && box(d) > height) d = Math.max(LEAST_RING, d - 2)
  const room = height / 2 - clearance(d, dx)
  const labelScale = box(d) > height && label > 0 ? Math.min(1, Math.max(LEAST_SCALE, room / label)) : 1
  return {
    cx: width / 2,
    cy: height / 2,
    diameter: d,
    radius: d / 2,
    thickness: thick(d),
    hub: d * 0.62,
    box: Math.min(height, 2 * (clearance(d, dx) + label * labelScale)),
    labelScale,
  }
}

/**
 * The flow's height for its width: what the largest ring and its labels
 * need, from 232 px to 420 px. A function of the width and the home's shape
 * alone, so nothing on the page moves when a reading arrives.
 */
export function flowHeight(width: number, axis: boolean, label = labelHeight()): number {
  const dx = axis ? 0 : Math.max(0, width / 2 - nodeWidth(width))
  const d = Math.min(width * 0.62, 300)
  return Math.min(420, Math.max(232, Math.ceil(2 * (clearance(d, dx) + label))))
}

// ---------- the figures ----------

/** The figure's step at a reading: 10 W, 100 W or 1 kW. */
function step(watts: number): number {
  const a = Math.abs(watts)
  return a < 995 ? 10 : a < 9_950 ? 100 : 1_000
}

/**
 * A figure on Now: 10 W steps under 1 kW, 0.1 kW to 10 kW, whole kW past
 * that. It changes when the digits on screen change, and not every second.
 */
export function quantised(watts: number): number {
  if (!Number.isFinite(watts)) return 0
  return Math.round(watts / step(watts)) * step(watts)
}

/**
 * A figure that holds still on a rounding edge: the one shown stays until
 * the reading moves more than 60 % of a step away from it, so 1.45 kW read
 * as 1.5, 1.4 and 1.5 again shows 1.5 throughout.
 */
export function quantisedHolding(watts: number, shown: number | null | undefined): number {
  const next = quantised(watts)
  if (shown == null || !Number.isFinite(shown) || !Number.isFinite(watts)) return next
  return Math.abs(watts - shown) > 0.6 * Math.max(step(shown), step(watts)) ? next : shown
}

/** What a node does, under its figure: "Charging · 68%", or a space when
 *  there is nothing yet, so the row keeps its height. */
export function doing(r: RingReading): string {
  const w = r.word.charAt(0).toUpperCase() + r.word.slice(1)
  if (r.levelPct == null) return w || ' '
  const pct = `${Math.round(r.levelPct)}%`
  return w ? `${w} · ${pct}` : pct
}
