/* How the ring's light moves, frame to frame.
 *
 * Plain values stepped once per frame, so a test can run them without a
 * screen. The constants are the iOS app's (Flow.swift): a change belongs in
 * both, or the phone and the browser stop showing the same house.
 *
 * Steady flow (J, chosen by Fredrik on 30 October 2026): an arc is brightest
 * over its middle third, each reading from the box sends one swell along it,
 * and thin lines of light run all the time between the arc and the home's
 * circle, in toward the home for power coming into it and out for power
 * leaving it.
 *
 * Light means live. An arc glows and its lines run only while the box
 * confirms the reading; when it stops, the glow cools like a CRT and the
 * arc goes to ink. An arc that has never been live never glows, so a cache
 * opens still.
 */

/** Pixels from one line of light to the next on its way to the home or
 *  away from it. */
export const WAVELENGTH = 15

/** How fast the light runs, in px a second: 19 at 0.1 kW, 31 at 1 kW, 52
 *  at 10 kW. Faster with power, never racing. */
export function waveSpeed(kw: number): number {
  return 16 + 22 * Math.log10(1 + 4 * Math.abs(kw))
}

/** How strong an arc's swell and its lines are: 0.65 at a trickle, full
 *  from about 4.7 kW. */
export function ringStrength(kw: number): number {
  const a = Math.abs(kw)
  if (!Number.isFinite(a)) return 0.65
  return 0.65 + 0.35 * Math.min(1, Math.log10(1 + 4 * a) / 1.3)
}

/** Brightness along an arc or a line, `u` from -1 at one end to 1 at the
 *  other: full over the middle third, easing to `end` at the ends. The
 *  light has no hot ends. */
export function ringEase(u: number, end: number): number {
  const x = Math.min(1, Math.max(0, (Math.abs(u) - 0.3) / 0.7))
  return 1 - (1 - end) * x * x * (3 - 2 * x)
}

/** The swell a reading sends along its arc, `s` px from the arc's middle,
 *  `k` of the way through it, on an arc `half` px each side of its middle:
 *  it starts in the middle, runs out past both ends and fades as it goes. */
export function ringSwell(s: number, k: number, half: number): number {
  if (!(k >= 0 && k <= 1)) return 0
  const sigma = Math.max(12, 0.32 * half)
  const at = (1 - (1 - k) * (1 - k)) * (half + sigma)
  const d = Math.abs(s) - at
  return Math.pow(1 - k, 1.3) * Math.exp(-(d * d) / (2 * sigma * sigma))
}

/** How long a reading's swell runs: 0.95 of the time since the one before,
 *  from 0.48 s to 1.5 s, so at a steady cadence a swell has ended when the
 *  next reading comes. */
export function ringSwellDuration(gap: number): number {
  return Math.min(1.5, 0.95 * Math.max(0.5, Number.isFinite(gap) ? gap : 1))
}

/** Where the lines of light sit on a way `length` px long between an arc
 *  and the home's circle, as shares from the arc (0) to the circle (1). As
 *  `phase`, in wavelengths, grows they move toward the home when the power
 *  flows into it and toward the arc when it flows out. */
export function ringLines(phase: number, length: number, towardHome: boolean): number[] {
  if (!(length > 0) || !Number.isFinite(phase)) return []
  const out: number[] = []
  for (let s = (phase - Math.floor(phase)) * WAVELENGTH; s <= length; s += WAVELENGTH) {
    out.push(towardHome ? s / length : 1 - s / length)
  }
  return out
}

/** A value that follows its target as a critically damped spring with time
 *  constant `tau`: it swells to a new value and never overshoots. Stepped
 *  exactly, so a long frame lands where many short ones would. */
export class Follow {
  velocity = 0
  constructor(public value: number) {}

  step(target: number, dt: number, tau: number): void {
    if (dt <= 0) return
    if (tau <= 0) return this.snap(target)
    const w = 1 / tau
    const e = this.value - target
    const k = Math.exp(-w * dt)
    const a = this.velocity + w * e
    this.value = target + (e + a * dt) * k
    this.velocity = (this.velocity - w * a * dt) * k
  }

  snap(target: number): void {
    this.value = target
    this.velocity = 0
  }
}

/** The phosphor, from 0 (ink, still) to 1 (live). It ignites on a spring
 *  (response 0.35 s, damping 0.85) and decays exponentially (τ 0.4 s) while
 *  its lines slow to rest in 0.35 s. Instant under reduced motion. */
export class Light {
  static readonly decay = 0.4
  static readonly rest = 0.35
  static readonly response = 0.35
  static readonly damping = 0.85

  private since: number
  private level0: number
  private motion0: number

  constructor(public live: boolean, t: number) {
    this.since = t
    this.level0 = live ? 1 : 0
    this.motion0 = this.level0
  }

  set(live: boolean, t: number, instant = false): void {
    if (live === this.live) return
    const target = live ? 1 : 0
    this.level0 = instant ? target : this.level(t)
    this.motion0 = instant ? target : this.motion(t)
    this.since = t
    this.live = live
  }

  /** The glow, the lines' light and the core's strength. */
  level(t: number): number {
    const dt = Math.max(0, t - this.since)
    return this.live ? 1 - (1 - this.level0) * Light.residual(dt) : this.level0 * Math.exp(-dt / Light.decay)
  }

  /** How fast the lines run, as a share of their speed. */
  motion(t: number): number {
    const dt = Math.max(0, t - this.since)
    if (this.live) return Math.min(1, 1 - (1 - this.motion0) * Light.residual(dt))
    const k = 1 - Math.min(1, dt / Light.rest)
    return this.motion0 * k * k
  }

  /** What is left of a step after `t` seconds on the spring. */
  static residual(t: number): number {
    const w = (2 * Math.PI) / Light.response
    const z = Light.damping
    const wd = w * Math.sqrt(1 - z * z)
    return Math.exp(-z * w * t) * (Math.cos(wd * t) + ((z * w) / wd) * Math.sin(wd * t))
  }
}

/** What one arc shows for one node's reading. */
export interface ArcTarget {
  /** Magnitude, never signed. */
  kw: number
  live: boolean
  flowing: boolean
  /** The power flows into the home: the lines run toward it. */
  towardHome: boolean
  /** How much of its quarter the arc lights, 0 to 1. */
  fill: number
}

/** One arc's look in one frame. */
export interface ArcFrame {
  /** Wavelengths the lines have run. */
  phase: number
  /** The phosphor: the glow's strength and the lines' light. */
  light: number
  /** 0 for a flowing arc, 1 for a node at rest. */
  idle: number
  /** The share of its quarter the arc lights. */
  fill: number
  /** How far the newest reading's swell has run, 0 to 1; null when none runs. */
  swell: number | null
}

export const alpha = (f: ArcFrame) => 0.35 + 0.65 * Math.min(1, f.light)

/** One arc over time: its fill and speed follow the readings (τ 0.4 s), its
 *  light ignites and decays, its lines run at the speed the power gives, and
 *  each new reading from the box sends one swell along it. */
export class ArcMotion {
  static readonly tau = 0.4
  /** Longer than this between two frames, nothing was drawn: the page was
   *  away or the loop rested. */
  static readonly gap = 0.5

  private speed: Follow
  private idle: Follow
  private fill: Follow
  private light: Light
  private phase = 0
  private last: number
  /** The newest reading's time, in ms. */
  private reading: number | null
  private swell: { start: number; duration: number } | null = null

  /** The first frame: everything where the reading puts it, with no ignite,
   *  so a page that opens on live data does not flash. */
  constructor(target: ArcTarget, t: number, reading: number | null = null) {
    this.speed = new Follow(waveSpeed(target.kw))
    this.idle = new Follow(target.flowing ? 0 : 1)
    this.fill = new Follow(target.fill)
    this.light = new Light(target.live, t)
    this.last = t
    this.reading = reading
  }

  /** The arc at `t`, with `reading` the time of the newest reading from the
   *  box. A new one starts a swell while the arc is live and flowing and the
   *  ring is `animating`. The first frame, a reading that came while nothing
   *  was drawn, a frame drawn once at rest, a cache and reduced motion never
   *  swell: a swell that cannot run would stand still at its brightest. */
  step(target: ArcTarget, t: number, reduceMotion: boolean, reading: number | null = null, animating = true): ArcFrame {
    const dt = Math.max(0, t - this.last)
    this.last = Math.max(this.last, t)
    // A reading that stopped being live while nothing was drawn went out at
    // a moment nobody saw, so it never cools on screen afterwards.
    this.light.set(target.live, t, reduceMotion || (!target.live && dt > ArcMotion.gap))
    const v = waveSpeed(target.kw)
    const rest = target.flowing ? 0 : 1
    if (reduceMotion) {
      this.speed.snap(v)
      this.idle.snap(rest)
      this.fill.snap(target.fill)
    } else {
      this.speed.step(v, dt, ArcMotion.tau)
      this.idle.step(rest, dt, ArcMotion.tau / 2)
      this.fill.step(target.fill, dt, ArcMotion.tau)
      this.phase = ((this.phase + (this.speed.value * this.light.motion(t) * dt) / WAVELENGTH) % 1_000)
    }
    if (reading !== null && reading !== this.reading) {
      if (this.reading !== null && target.live && target.flowing && !reduceMotion && animating && dt <= ArcMotion.gap) {
        this.swell = { start: t, duration: ringSwellDuration((reading - this.reading) / 1000) }
      }
      this.reading = reading
    }
    let swell: number | null = null
    if (this.swell) {
      const p = (t - this.swell.start) / this.swell.duration
      if (reduceMotion || !animating || p > 1) this.swell = null
      else swell = Math.max(0, p)
    }
    return {
      phase: this.phase,
      light: this.light.level(t),
      idle: Math.min(1, Math.max(0, this.idle.value)),
      fill: Math.min(1, Math.max(0, this.fill.value)),
      swell,
    }
  }
}
