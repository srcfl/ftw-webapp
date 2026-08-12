/* What the pen actually did.
 *
 * chart.test.ts proves the maths keeps a hole a hole. This proves the canvas
 * obeys it, which is a separate question: the reduction can be right and the
 * paint can still join the two sides of an outage, and nothing on the maths
 * side would notice.
 *
 * jsdom has no 2D context, so one is recorded instead. That is enough for the
 * three claims worth making about a drawing — where the pen went, whether it
 * lifted, and what colour it was — and none of them needs a raster.
 */

import { describe, it, expect, vi, afterEach } from 'vitest'
import { render } from '@testing-library/svelte'
import Chart from './Chart.svelte'
import { MISSING_SAMPLE } from '$lib/protocol/messages'
import type { SeriesFrame } from '$lib/protocol/history'
import type { Domain, Trace } from './chart'

class QuietResizeObserver {
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
}
globalThis.ResizeObserver ??= QuietResizeObserver as unknown as typeof ResizeObserver

/** The width the component falls back to when nothing has measured it. */
const WIDTH = 320
const HEIGHT = 200

interface Op {
  op: string
  args: number[]
  strokeStyle: string
  fillStyle: string
}

/** One stroked subpath: the points, in order, as the pen visited them. */
interface Path {
  points: [number, number][]
  strokeStyle: string
}

/**
 * The roles this component is allowed to paint with, and what they resolve to.
 *
 * Deliberately values no one would write by hand, so a hex left in the
 * component shows up as itself rather than blending in with a token.
 */
const ROLES: Record<string, string> = {
  '--line': 'role-line',
  '--line-soft': 'role-line-soft',
  '--surface-sunken': 'role-sunken',
  '--fg-muted': 'role-muted',
  '--energy-import': 'role-import',
  '--energy-generation': 'role-generation',
}

function recorder(): { ops: Op[]; ctx: CanvasRenderingContext2D } {
  const ops: Op[] = []
  const ctx = {
    strokeStyle: '',
    fillStyle: '',
    lineWidth: 1,
    lineJoin: '',
    lineCap: '',
    globalAlpha: 1,
  } as unknown as CanvasRenderingContext2D & Record<string, unknown>

  for (const op of [
    'setTransform',
    'clearRect',
    'fillRect',
    'beginPath',
    'closePath',
    'moveTo',
    'lineTo',
    'bezierCurveTo',
    'arc',
    'stroke',
    'fill',
  ]) {
    ctx[op] = (...args: number[]) =>
      ops.push({
        op,
        args,
        strokeStyle: String(ctx.strokeStyle),
        fillStyle: String(ctx.fillStyle),
      })
  }

  return { ops, ctx }
}

/** Every subpath that was stroked, rebuilt from the op stream. */
function strokedPaths(ops: Op[]): Path[] {
  const out: Path[] = []
  let current: Path | null = null

  for (const op of ops) {
    if (op.op === 'beginPath') current = { points: [], strokeStyle: '' }
    else if (op.op === 'moveTo' || op.op === 'lineTo') {
      current?.points.push([op.args[0]!, op.args[1]!])
    } else if (op.op === 'bezierCurveTo') {
      current?.points.push([op.args[4]!, op.args[5]!])
    } else if (op.op === 'stroke' && current) {
      out.push({ ...current, strokeStyle: op.strokeStyle })
      current = null
    } else if (op.op === 'fill') current = null
  }

  return out
}

function mount(
  columns: Int32Array[],
  names: string[],
  traces: Trace[],
  axis: Domain,
  roles: Record<string, string> = ROLES,
  stepMs = 3_600_000,
  cursor: number | null = null
) {
  const { ops, ctx } = recorder()
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(ctx as never)
  vi.spyOn(window, 'getComputedStyle').mockReturnValue({
    getPropertyValue: (name: string) => roles[name] ?? '',
  } as unknown as CSSStyleDeclaration)

  const frame: SeriesFrame = {
    names,
    columns,
    points: columns[0]!.length,
    startMs: 0,
    stepMs,
  }
  render(Chart, { props: { frame, traces, axis, height: HEIGHT, cursor } })
  return ops
}

const GRID: Trace = { name: 'grid_w', label: 'Grid', colorVar: '--energy-import' }
const PV: Trace = { name: 'pv_w', label: 'Solar', colorVar: '--energy-generation' }

afterEach(() => {
  document.body.replaceChildren()
  vi.restoreAllMocks()
})

describe('a gap survives the reduction and the paint', () => {
  it('lifts the pen over an outage in a series denser than the display', () => {
    // Twice as many readings as pixels, with a day missing out of the middle.
    // The failure this exists to prevent is one stroke straight across it —
    // the same lie as a joined polyline, arrived at by a different route.
    const points = WIDTH * 2
    const column = new Int32Array(points).fill(2000)
    const hole = { from: 300, to: 340 }
    for (let i = hole.from; i < hole.to; i++) column[i] = MISSING_SAMPLE

    const ops = mount([column], ['grid_w'], [GRID], [-4000, 4000])
    const paths = strokedPaths(ops).filter((p) => p.strokeStyle === 'role-import')

    expect(paths.length, 'the outage was drawn as one unbroken stroke').toBeGreaterThan(1)

    // Every pixel the outage covers, with nothing drawn on it.
    const scale = (WIDTH - 1) / (points - 1)
    const from = Math.round(hole.from * scale) + 1
    const to = Math.round((hole.to - 1) * scale) - 1
    expect(to).toBeGreaterThanOrEqual(from)

    for (const path of paths) {
      for (const [x] of path.points) {
        expect(x < from || x > to, `drew at x=${x}, inside the outage`).toBe(true)
      }
      // And no single stroke steps over the hole either.
      for (let i = 1; i < path.points.length; i++) {
        const a = path.points[i - 1]![0]
        const b = path.points[i]![0]
        expect(a < from && b > to, 'one stroke spanned the outage').toBe(false)
      }
    }
  })

  it('still draws a lone pixel of readings between two outages', () => {
    // A reading that exists should be visible. A run one pixel wide has no
    // band to fill and no line to join, and the pen used to be handed a
    // subpath with a single point in it — which browsers disagree about
    // painting at all.
    const points = WIDTH * 2
    const column = new Int32Array(points).fill(MISSING_SAMPLE)
    column[400] = 3000
    column[401] = 1000

    const ops = mount([column], ['grid_w'], [GRID], [-4000, 4000])
    const paths = strokedPaths(ops).filter((p) => p.strokeStyle === 'role-import')

    expect(paths.length, 'the only readings in the window were not drawn').toBe(1)
    expect(paths[0]!.points.length, 'a subpath of one point may paint nothing').toBe(2)

    // And what it draws is the extent of what was read there, not a midpoint.
    const ys = paths[0]!.points.map(([, y]) => y).sort((a, b) => a - b)
    const yOf = (v: number) => HEIGHT - ((v - -4000) / 8000) * HEIGHT
    expect(ys[0]).toBeCloseTo(yOf(3000), 5)
    expect(ys[1]).toBeCloseTo(yOf(1000), 5)
  })
})

describe('readings are joined without sharp corners', () => {
  it('uses bounded cubic edges for a sparse series', () => {
    const column = new Int32Array([0, 2000, 1000, 3000])
    const ops = mount([column], ['grid_w'], [GRID], [-4000, 4000])
    const curves = ops.filter((op) => op.op === 'bezierCurveTo')

    // A straight lineTo-only path would put the sharp joins from the original
    // phone chart back. The old second copy was the heavy fill back to zero.
    expect(curves).toHaveLength(column.length - 1)
  })

  it('strokes the calm trend while the cursor still marks the exact reading', () => {
    const column = new Int32Array(15)
    for (let i = 0; i < column.length; i++) column[i] = i % 2 === 0 ? 0 : 2000

    const cursor = 7
    const ops = mount(
      [column],
      ['grid_w'],
      [GRID],
      [0, 2000],
      ROLES,
      5 * 60_000,
      cursor
    )
    const path = strokedPaths(ops).find((p) => p.strokeStyle === 'role-import')
    const x = (cursor / (column.length - 1)) * (WIDTH - 1)

    // The alternating 0/2 kW pulses have a 1 kW trend at the centre.
    expect(path?.points.some(([px, y]) => Math.abs(px - x) < 0.001 && Math.abs(y - 100) < 0.001)).toBe(
      true
    )

    // But the dot is at the box's exact 2 kW reading, not on the trend.
    const dot = ops.find((op) => op.op === 'arc' && Math.abs(op.args[0]! - x) < 0.001)
    expect(dot?.args[1]).toBe(0)
  })
})

describe('colour comes from the palette', () => {
  it('paints with resolved design roles and never a value of its own', () => {
    // The palette is shared with the box's on-box UI. A hex here is a colour
    // that cannot be changed in one place, and it shows up as a literal.
    const points = WIDTH * 2
    const grid = new Int32Array(points).fill(2000)
    const pv = new Int32Array(points).fill(-1000)
    for (let i = 0; i < 20; i++) pv[i] = MISSING_SAMPLE

    const ops = mount([grid, pv], ['grid_w', 'pv_w'], [GRID, PV], [-4000, 4000])
    const painted = new Set<string>()
    for (const op of ops) {
      if (op.op === 'stroke') painted.add(op.strokeStyle)
      if (op.op === 'fill' || op.op === 'fillRect') painted.add(op.fillStyle)
    }

    expect(painted.size).toBeGreaterThan(0)
    for (const colour of painted) {
      expect(Object.values(ROLES), `painted with ${colour}`).toContain(colour)
    }
  })

  it('falls back to one neutral grey when a role resolves to nothing', () => {
    // An empty resolution is a renamed token or a stylesheet that never
    // mounted. The fallbacks used to be dark-palette hexes, which drew dark
    // rules on a light card in light theme and blended into dark — masking
    // the missing token in exactly one theme each. Wrong has to be visible
    // the same way in both: one grey, everywhere.
    const points = WIDTH * 2
    const grid = new Int32Array(points).fill(2000)
    const pv = new Int32Array(points).fill(-1000)

    const ops = mount([grid, pv], ['grid_w', 'pv_w'], [GRID, PV], [-4000, 4000], {})
    const painted = new Set<string>()
    for (const op of ops) {
      if (op.op === 'stroke') painted.add(op.strokeStyle)
      if (op.op === 'fill' || op.op === 'fillRect') painted.add(op.fillStyle)
    }

    expect(painted.size).toBeGreaterThan(0)
    expect([...painted]).toEqual(['#808080'])
  })
})
