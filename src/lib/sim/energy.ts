/* A plausible house.
 *
 * Not a physics model — a shape generator. It exists so the client can be
 * built and demonstrated against something that behaves like a home rather
 * than a sine wave, and so screenshots and tests are reproducible.
 *
 * Deterministic by construction: same seed, same house, same day. Tests that
 * depend on Math.random are tests that fail on a Tuesday.
 *
 * Sign convention is FTW's throughout: positive watts flow INTO the site.
 * PV generation is therefore negative at the panel boundary and arrives here
 * already converted, exactly as a driver would deliver it.
 */

/** Small, fast, well-distributed. Enough for shaping noise. */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

export interface HouseConfig {
  seed: number
  /** Peak array output in watts. 0 for a house without solar. */
  pvPeakW: number
  /** Usable capacity in watt-hours. 0 for a house without storage. */
  batteryCapacityWh: number
  batteryMaxChargeW: number
  /** Main fuse rating, used for the ceiling the optimiser defends. */
  fuseA: number
  phases: 1 | 3
}

export const DEFAULT_HOUSE: HouseConfig = {
  seed: 42,
  pvPeakW: 9600,
  batteryCapacityWh: 15000,
  batteryMaxChargeW: 5000,
  fuseA: 20,
  phases: 3,
}

export interface Reading {
  gridW: number
  pvW: number
  batteryW: number
  batterySocPermille: number
  loadW: number
}

/**
 * Solar output for a moment of the day.
 *
 * A half-sine between sunrise and sunset, scaled by a slow cloud factor. The
 * cloud term matters more than it looks: a perfectly smooth PV curve makes
 * every downstream feature — forecasting, dispatch, the "why" sentence —
 * look like it works when it has never met a real afternoon.
 */
function solarW(cfg: HouseConfig, hourOfDay: number, dayOfYear: number, rand: () => number): number {
  if (cfg.pvPeakW <= 0) return 0

  // Northern-hemisphere daylight, roughly Swedish latitudes.
  const seasonal = Math.cos(((dayOfYear - 172) / 365) * 2 * Math.PI)
  const dayLength = 12 - 5.5 * seasonal
  const sunrise = 12 - dayLength / 2
  const sunset = 12 + dayLength / 2

  if (hourOfDay < sunrise || hourOfDay > sunset) return 0

  const arc = Math.sin(((hourOfDay - sunrise) / dayLength) * Math.PI)
  const seasonalPeak = 0.55 + 0.45 * (1 - (seasonal + 1) / 2)

  // Cloud factor drifts slowly rather than jittering per sample.
  const cloudPhase = Math.sin(hourOfDay * 0.7 + cfg.seed) * 0.5 + 0.5
  const cloud = 0.35 + 0.65 * cloudPhase * (0.85 + 0.3 * rand())

  return Math.max(0, cfg.pvPeakW * arc * seasonalPeak * cloud)
}

/**
 * Household consumption for a moment of the day.
 *
 * A base load plus morning and evening humps, plus occasional appliance
 * spikes. The spikes are what make a fuse ceiling interesting; without them
 * nothing ever approaches the limit and the battery never has a reason to act.
 */
function loadW(cfg: HouseConfig, hourOfDay: number, rand: () => number): number {
  const base = 350 + 120 * rand()

  const morning = 2400 * Math.exp(-((hourOfDay - 7.5) ** 2) / 2.2)
  const evening = 3600 * Math.exp(-((hourOfDay - 18.5) ** 2) / 4.0)

  // Roughly one appliance running at any given evening moment.
  const spike = rand() < 0.04 ? 1500 + 2500 * rand() : 0

  return base + morning + evening + spike
}

/**
 * One moment in the life of the house.
 *
 * The battery follows a simple rule that produces recognisable behaviour: it
 * absorbs surplus solar, and it discharges to keep grid import under the
 * ceiling. That is enough for the app to have something true to explain.
 */
export function sample(
  cfg: HouseConfig,
  atMs: number,
  socPermille: number,
  ceilingW: number
): Reading {
  const d = new Date(atMs)
  const hourOfDay = d.getUTCHours() + d.getUTCMinutes() / 60 + d.getUTCSeconds() / 3600
  const dayOfYear = Math.floor((atMs - Date.UTC(d.getUTCFullYear(), 0, 0)) / 86_400_000)

  // Seeded on the minute so consecutive samples within a minute stay coherent.
  const rand = mulberry32(cfg.seed + Math.floor(atMs / 60_000))

  const pv = solarW(cfg, hourOfDay, dayOfYear, rand)
  const load = loadW(cfg, hourOfDay, rand)

  // Positive means into the site; PV arrives as generation, so it offsets load.
  const netBeforeBattery = load - pv

  let battery = 0
  if (cfg.batteryCapacityWh > 0) {
    if (netBeforeBattery < 0 && socPermille < 1000) {
      // Surplus solar: absorb what fits.
      battery = Math.min(-netBeforeBattery, cfg.batteryMaxChargeW)
    } else if (netBeforeBattery > ceilingW && socPermille > 50) {
      // Defend the ceiling. This is the case the app gets to explain.
      battery = -Math.min(netBeforeBattery - ceilingW, cfg.batteryMaxChargeW)
    }
  }

  const grid = netBeforeBattery + battery

  return {
    gridW: Math.round(grid),
    pvW: Math.round(pv),
    batteryW: Math.round(battery),
    batterySocPermille: socPermille,
    loadW: Math.round(load),
  }
}

/** Advance state of charge by one step, clamped to the usable window. */
export function stepSoc(
  cfg: HouseConfig,
  socPermille: number,
  batteryW: number,
  stepMs: number
): number {
  if (cfg.batteryCapacityWh <= 0) return socPermille

  const deltaWh = (batteryW * stepMs) / 3_600_000
  const deltaPermille = (deltaWh / cfg.batteryCapacityWh) * 1000

  return Math.max(0, Math.min(1000, socPermille + deltaPermille))
}
