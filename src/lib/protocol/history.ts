/* History geometry: tiles, resolutions, and the column packing.
 *
 * Shared by the box simulator and the client, so both compute the same tile
 * boundaries from the same numbers. A tile the client asks for and a tile the
 * box builds must be the same tile, or the etag comparison silently degrades
 * into "always refetch".
 *
 * Downsampling always happens on the box. One reading per second for a year
 * is 31 million points; that number never crosses the wire. When a window is
 * too wide for the requested resolution the box clamps to a coarser one and
 * reports `resActual`, and when even the coarsest is too wide it aggregates
 * whole buckets and widens `stepMs`. `res` says which store the data came
 * from; `stepMs` says how far apart the points are. They are not the same
 * question, which is why the chunk carries both.
 *
 * See docs/protocol.md, "History".
 */

import { MISSING_SAMPLE, type Resolution } from './messages'

export interface ResolutionSpec {
  /** Spacing of the stored buckets. */
  stepMs: number
  /** How much time one tile covers. */
  tileSpanMs: number
  /** How far back the box keeps this resolution. */
  retentionMs: number
}

const DAY_MS = 86_400_000

/** Mirrors `resolutions` in contract/registry.yaml. */
export const RESOLUTIONS: Record<Resolution, ResolutionSpec> = {
  '5m': { stepMs: 300_000, tileSpanMs: 43_200_000, retentionMs: 30 * DAY_MS },
  '1h': { stepMs: 3_600_000, tileSpanMs: 604_800_000, retentionMs: 730 * DAY_MS },
}

/** Fine to coarse. This is the order the box clamps along. */
export const RESOLUTION_ORDER: readonly Resolution[] = ['5m', '1h']

/**
 * Cap when the client does not name one.
 *
 * Roughly four points per CSS pixel on a phone held in one hand — beyond that
 * the wire is carrying detail no display can show.
 */
export const DEFAULT_MAX_POINTS = 2000

/** Buckets in one tile at the stored resolution. 144 at 5m, 168 at 1h. */
export function pointsPerTile(res: Resolution): number {
  const spec = RESOLUTIONS[res]
  return spec.tileSpanMs / spec.stepMs
}

/** Tiles are epoch-aligned, so two peers never disagree about where one starts. */
export function tileStartFor(res: Resolution, atMs: number): number {
  const span = RESOLUTIONS[res].tileSpanMs
  return Math.floor(atMs / span) * span
}

export interface PlannedTile {
  tileId: string
  startMs: number
  /** Points in this tile after aggregation. */
  points: number
}

export interface HistoryPlan {
  /** What the box will actually serve. May be coarser than requested. */
  res: Resolution
  /** Buckets combined into one point. 1 means the stored resolution. */
  stride: number
  /** Spacing of the points the client receives: stored step times stride. */
  stepMs: number
  tiles: PlannedTile[]
}

/**
 * Divisors of the tile's point count, ascending.
 *
 * Aggregation has to divide the tile evenly or a tile stops being a whole
 * number of points and every boundary needs special handling. Constraining
 * the stride to a divisor is what keeps tiles independent.
 */
function strides(res: Resolution): number[] {
  const n = pointsPerTile(res)
  const out: number[] = []
  for (let k = 1; k <= n; k++) if (n % k === 0) out.push(k)
  return out
}

/**
 * Decide resolution, stride and tile list for a window.
 *
 * Deterministic on both sides: the client plans the same tiles the box will
 * send, which is what lets it look them up in its cache before asking.
 */
export function planQuery(
  res: Resolution,
  fromMs: number,
  toMs: number,
  maxPoints = DEFAULT_MAX_POINTS
): HistoryPlan {
  const cap = Math.max(1, Math.floor(maxPoints))

  // Transfer is whole tiles, so the count that must fit under the cap is the
  // tile-aligned span, not the requested one. Budgeting for the request and
  // then sending two half-tiles more is how a cap becomes advisory.
  const alignedSpan = (candidate: Resolution) => {
    const spanMs = RESOLUTIONS[candidate].tileSpanMs
    const first = tileStartFor(candidate, fromMs)
    const last = tileStartFor(candidate, Math.max(fromMs, toMs - 1))
    return last + spanMs - first
  }

  // Clamp to a coarser store before aggregating: coarser stored data is real
  // data, while an aggregate of finer data is an average of it.
  let chosen = RESOLUTION_ORDER[RESOLUTION_ORDER.length - 1]!
  for (const candidate of RESOLUTION_ORDER) {
    if (RESOLUTION_ORDER.indexOf(candidate) < RESOLUTION_ORDER.indexOf(res)) continue
    chosen = candidate
    if (alignedSpan(candidate) / RESOLUTIONS[candidate].stepMs <= cap) break
  }

  const base = RESOLUTIONS[chosen].stepMs
  const total = alignedSpan(chosen)
  const options = strides(chosen)
  const stride = options.find((k) => total / (base * k) <= cap) ?? options[options.length - 1]!
  const stepMs = base * stride

  const spanMs = RESOLUTIONS[chosen].tileSpanMs
  const firstStart = tileStartFor(chosen, fromMs)
  const lastStart = tileStartFor(chosen, Math.max(fromMs, toMs - 1))

  const tiles: PlannedTile[] = []
  for (let start = firstStart; start <= lastStart; start += spanMs) {
    tiles.push({
      tileId: tileId(chosen, stride, start),
      startMs: start,
      points: pointsPerTile(chosen) / stride,
    })
  }

  return { res: chosen, stride, stepMs, tiles }
}

/**
 * A tile's stable name.
 *
 * The stride is part of the identity because a tile aggregated six buckets to
 * one holds different numbers from the same hours at full detail. Two tiles,
 * both immutable, rather than one tile whose contents depend on how it was
 * asked for.
 */
export function tileId(res: Resolution, stride: number, startMs: number): string {
  return `${res}/${stride}/${startMs / RESOLUTIONS[res].tileSpanMs}`
}

// ---------------------------------------------------------------------------
// Column packing
// ---------------------------------------------------------------------------

/**
 * One contiguous int32 LE block per series, concatenated.
 *
 * Column order rather than row order so the client can hand a whole series to
 * the renderer as one Int32Array without walking it.
 */
export function packColumns(columns: readonly Int32Array[]): Uint8Array {
  const points = columns[0]?.length ?? 0
  const out = new Uint8Array(columns.length * points * 4)
  const view = new DataView(out.buffer)

  let offset = 0
  for (const column of columns) {
    for (let i = 0; i < points; i++) {
      view.setInt32(offset, column[i] ?? MISSING_SAMPLE, true)
      offset += 4
    }
  }

  return out
}

/** Split a packed block back into one Int32Array per series. */
export function unpackColumns(data: Uint8Array, seriesCount: number): Int32Array[] {
  if (seriesCount <= 0) return []

  const points = Math.floor(data.byteLength / 4 / seriesCount)
  if (points <= 0) return Array.from({ length: seriesCount }, () => new Int32Array(0))

  // CBOR hands back a view into a larger buffer whose offset need not be a
  // multiple of four, and Int32Array will not sit on an unaligned offset.
  // Copy only when it has to, so the common case stays zero-copy.
  const aligned = data.byteOffset % 4 === 0
  const source = aligned ? data : new Uint8Array(data)
  const buffer = source.buffer as ArrayBuffer

  const out: Int32Array[] = []
  for (let s = 0; s < seriesCount; s++) {
    out.push(new Int32Array(buffer, source.byteOffset + s * points * 4, points))
  }
  return out
}

// ---------------------------------------------------------------------------
// Assembly
// ---------------------------------------------------------------------------

/** The parts of a tile the assembler needs, from cache or straight off the wire. */
export interface TileData {
  startMs: number
  stepMs: number
  series: readonly string[]
  data: Uint8Array
}

/** One evenly spaced block of samples per series, ready to draw. */
export interface SeriesFrame {
  startMs: number
  stepMs: number
  points: number
  names: readonly string[]
  /** One per name, in the same order. MISSING_SAMPLE where there is a hole. */
  columns: Int32Array[]
}

/**
 * Lay tiles end to end into one frame.
 *
 * Tiles absent from the map stay MISSING rather than shifting what follows
 * them. A chart that closes over a missing tile by drawing the next one
 * earlier is not showing a gap — it is showing the wrong day.
 */
export function assembleFrame(
  plan: HistoryPlan,
  names: readonly string[],
  tiles: ReadonlyMap<string, TileData>
): SeriesFrame {
  const perTile = plan.tiles[0]?.points ?? 0
  const points = perTile * plan.tiles.length
  const columns = names.map(() => new Int32Array(points).fill(MISSING_SAMPLE))

  plan.tiles.forEach((planned, index) => {
    const tile = tiles.get(planned.tileId)
    if (!tile) return

    const unpacked = unpackColumns(tile.data, tile.series.length)
    const offset = index * perTile

    names.forEach((name, target) => {
      const source = unpacked[tile.series.indexOf(name)]
      if (!source) return
      columns[target]!.set(source.subarray(0, perTile), offset)
    })
  })

  return {
    startMs: plan.tiles[0]?.startMs ?? 0,
    stepMs: plan.stepMs,
    points,
    names,
    columns,
  }
}

/**
 * Trim a tile-aligned frame to the window that was asked for.
 *
 * Tiles are twelve hours or seven days wide, so a request for "the last day"
 * lands inside a frame up to twice that. Drawing the overhang would answer a
 * question nobody asked and move the axis under the user's finger.
 */
export function clipFrame(frame: SeriesFrame, fromMs: number, toMs: number): SeriesFrame {
  if (frame.points === 0) return frame

  const first = Math.max(0, Math.floor((fromMs - frame.startMs) / frame.stepMs))
  const last = Math.min(frame.points, Math.ceil((toMs - frame.startMs) / frame.stepMs))
  if (first === 0 && last === frame.points) return frame
  if (last <= first) return { ...frame, points: 0, columns: frame.names.map(() => new Int32Array(0)) }

  return {
    startMs: frame.startMs + first * frame.stepMs,
    stepMs: frame.stepMs,
    points: last - first,
    names: frame.names,
    columns: frame.columns.map((c) => c.subarray(first, last)),
  }
}

/**
 * Content etag.
 *
 * FNV-1a: the client only needs to know whether a tile changed, and a closed
 * tile never does. A cryptographic digest here would cost a WebCrypto round
 * trip per tile to answer a question a 32-bit hash already answers.
 */
export function etagOf(data: Uint8Array): string {
  let h = 0x811c9dc5
  for (let i = 0; i < data.length; i++) {
    h ^= data[i]!
    h = Math.imul(h, 0x01000193)
  }
  return (h >>> 0).toString(16).padStart(8, '0')
}
