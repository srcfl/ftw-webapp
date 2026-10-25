/* How the ring's light moves, frame to frame.
 *
 * Plain values stepped once per frame, so a test can run them without a
 * screen. The constants are the iOS app's (Flow.swift): a change belongs in
 * both, or the phone and the browser stop showing the same house.
 *
 * Light means live. An arc glows and its wave runs only while the box
 * confirms the reading; when it stops, the glow cools like a CRT and the
 * arc goes to ink. An arc that has never been live never glows, so a cache
 * opens still.
 */

/** Pixels from one crest of the light to the next. */
export const WAVELENGTH = 30

/** How fast the light runs from source to sink, in px a second: 19 at
 *  0.1 kW, 31 at 1 kW, 52 at 10 kW. Faster with power, never racing. */
export function waveSpeed(kw: number): number {
  return 16 + 22 * Math.log10(1 + 4 * Math.abs(kw))
}

/** Brightness along an arc, from 0.45 to 1: soft crests a wavelength apart.
 *  `s` is px from the source, `phase` is wavelengths the light has run. */
export function wave(s: number, phase: number): number {
  const c = (1 + Math.cos(2 * Math.PI * (s / WAVELENGTH - phase))) / 2
  return 0.45 + 0.55 * c * c * c
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
 *  its wave slows to rest in 0.35 s. Instant under reduced motion. */
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

  /** The glow, the wave's depth and the core's strength. */
  level(t: number): number {
    const dt = Math.max(0, t - this.since)
    return this.live ? 1 - (1 - this.level0) * Light.residual(dt) : this.level0 * Math.exp(-dt / Light.decay)
  }

  /** How fast the wave runs, as a share of its speed. */
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
  /** The light runs toward the home: clockwise. */
  towardHome: boolean
  /** How much of its quarter the arc lights, 0 to 1. */
  fill: number
}

/** One arc's look in one frame. */
export interface ArcFrame {
  /** Wavelengths the light has run, source to sink. */
  phase: number
  /** The phosphor: the glow's strength and the wave's depth. */
  light: number
  /** 0 for a flowing arc, 1 for a node at rest. */
  idle: number
  /** The share of its quarter the arc lights. */
  fill: number
}

export const alpha = (f: ArcFrame) => 0.35 + 0.65 * Math.min(1, f.light)
export const depth = (f: ArcFrame) => Math.min(1, f.light)

/** One arc over time: its fill and speed follow the readings (τ 0.4 s), its
 *  light ignites and decays, its wave runs at the speed the power gives. */
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

  /** The first frame: everything where the reading puts it, with no ignite,
   *  so a page that opens on live data does not flash. */
  constructor(target: ArcTarget, t: number) {
    this.speed = new Follow(waveSpeed(target.kw))
    this.idle = new Follow(target.flowing ? 0 : 1)
    this.fill = new Follow(target.fill)
    this.light = new Light(target.live, t)
    this.last = t
  }

  step(target: ArcTarget, t: number, reduceMotion: boolean): ArcFrame {
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
    return {
      phase: this.phase,
      light: this.light.level(t),
      idle: Math.min(1, Math.max(0, this.idle.value)),
      fill: Math.min(1, Math.max(0, this.fill.value)),
    }
  }
}
