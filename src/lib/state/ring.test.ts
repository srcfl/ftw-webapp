import { describe, expect, it } from 'vitest'
import {
  doing, flowHeight, labelHeight, nodeWidth, quantised, quantisedHolding, ringArc, ringFill, ringGeometry, ringKey, ringReadings,
  ringSpot, type RingReading,
} from './ring'
import { FLOW_IDLE_W, flowReadingsFromStatus, type FlowPlanet, type FlowReadings } from './flow'
import { FLOW_IDLE_W as BOX_IDLE_W } from '$vendor/ftw/ftw-energy-flow.js'

const planet = (p: Partial<FlowPlanet> & Pick<FlowPlanet, 'id' | 'role'>): FlowPlanet => ({
  corner: 'top-left', title: '', kw: 0, toHub: true, color: '', sub: '', ...p,
})

const node = (rs: RingReading[], n: RingReading['node']) => rs.find((r) => r.node === n)

describe('the ring’s nodes', () => {
  it('calls a flow idle where the box does', () => {
    expect(FLOW_IDLE_W).toBe(BOX_IDLE_W)
  })

  it('always draws the grid and the home, and other kinds only when present', () => {
    const rs = ringReadings({ load: 0.5, planets: [planet({ id: 'grid', role: 'grid', kw: 1, toHub: true })] }, true)
    expect(rs.map((r) => r.node)).toEqual(['home', 'grid'])
  })

  it('folds several batteries into one node by their signed sum', () => {
    // Two packs discharging 1 kW each and a third charging 0.5 kW: the home
    // gets 1.5 kW. Magnitudes alone would add to 2.5 kW of charge.
    const r: FlowReadings = {
      load: 2,
      planets: [
        planet({ id: 'grid', role: 'grid', kw: 0, toHub: true }),
        planet({ id: 'bat-a', role: 'battery', name: 'a', kw: 1, toHub: true, soc: 40 }),
        planet({ id: 'bat-b', role: 'battery', name: 'b', kw: 1, toHub: true, soc: 60 }),
        planet({ id: 'bat-c', role: 'battery', name: 'c', kw: 0.5, toHub: false, soc: null }),
      ],
    }
    const bat = node(ringReadings(r, true), 'battery')!
    expect(bat.watts).toBeCloseTo(1500)
    expect(bat.word).toBe('giving power')
    expect(bat.towardHome).toBe(true)
    expect(bat.color).toBe('var(--energy-gives)')
    expect(bat.levelPct).toBe(50)
    expect(bat.scope).toEqual({ role: 'battery', name: null, id: 'agg-battery' })
  })

  it('folds batteries the same way from the box’s snapshot, where watts are signed', () => {
    const rs = ringReadings(flowReadingsFromStatus({
      grid_w: 0, load_w: 2_000,
      drivers: { a: { status: 'ok', bat_w: -1_000, bat_soc: 0.4 }, b: { status: 'ok', bat_w: 500, bat_soc: 0.6 } },
    }), true)
    const bat = node(rs, 'battery')!
    expect([bat.watts, bat.word, bat.towardHome, bat.levelPct]).toEqual([500, 'giving power', true, 50])
  })

  it('does not call a sum live when one device of the kind has no reading', () => {
    const rs = ringReadings(flowReadingsFromStatus({
      grid_w: 0, load_w: 500,
      drivers: { a: { status: 'ok', bat_w: -1_000 }, b: { status: 'ok', bat_w: 0 } },
      control_feedback: [{ driver: 'b', kind: 'battery', status: 'no_contact', reason: 'readings_lost', severity: 'info', evidence: 'accepted', readings_fresh: false }],
    }), true)
    const bat = node(rs, 'battery')!
    expect(bat.watts).toBe(1_000)
    expect(bat.live).toBe(false)
  })

  it('opens nothing from a placeholder the box would not open', () => {
    const rs = ringReadings({
      load: 1,
      planets: [
        planet({ id: 'grid', role: 'grid', kw: 1 }),
        planet({ id: 'control-battery-x', role: 'battery', name: 'x', placeholder: true, sub: 'no data' }),
      ],
    }, true)
    expect(node(rs, 'battery')!.scope).toBeNull()
    const marked = ringReadings({
      load: 1,
      planets: [planet({ id: 'control-battery-x', role: 'battery', name: 'x', placeholder: true, controlMark: { tone: 'alarm', label: 'Lost' } })],
    }, true)
    expect(node(marked, 'battery')!.scope).toEqual({ role: 'battery', name: 'x', id: 'control-battery-x' })
  })

  it('shows the home as unknown when the box sends no use, not as a live 0 W', () => {
    const home = node(ringReadings(flowReadingsFromStatus({ grid_w: 100 }), true), 'home')!
    expect(home.watts).toBeNull()
    expect(home.live).toBe(false)
    expect(home.word).toBe('no reading')
  })

  it('treats a reading that is not a number as none', () => {
    const rs = ringReadings({ load: 1, planets: [planet({ id: 'grid', role: 'grid' }), planet({ id: 'pv', role: 'pv', kw: Number.NaN })] }, true)
    expect(node(rs, 'solar')!.watts).toBeNull()
  })

  it('names the grid buying or selling, one colour both ways, never a sign', () => {
    const buy = node(ringReadings({ load: 1, planets: [planet({ id: 'grid', role: 'grid', kw: 2, toHub: true })] }, true), 'grid')!
    const sell = node(ringReadings({ load: 1, planets: [planet({ id: 'grid', role: 'grid', kw: 2, toHub: false })] }, true), 'grid')!
    expect([buy.word, buy.watts, buy.towardHome]).toEqual(['buying', 2000, true])
    expect([sell.word, sell.watts, sell.towardHome]).toEqual(['selling', 2000, false])
    expect(buy.color).toBe(sell.color)
  })

  it('says a meter it cannot read has no reading, and does not claim it live', () => {
    const g = node(ringReadings({ load: 1, planets: [planet({ id: 'grid', role: 'grid', sub: 'no data', clickable: false })] }, true), 'grid')!
    expect(g.watts).toBeNull()
    expect(g.word).toBe('no reading')
    expect(g.live).toBe(false)
    expect(g.scope).toBeNull()
  })

  it('carries the cache as not live', () => {
    const rs = ringReadings({ load: 1, planets: [planet({ id: 'grid', role: 'grid', kw: 1 })] }, false)
    expect(rs.every((r) => !r.live)).toBe(true)
  })

  it('keeps one charger’s name, so a tap opens that charger', () => {
    const rs = ringReadings(flowReadingsFromStatus({ grid_w: 0, load_w: 500, drivers: { easee: { status: 'ok', ev_w: 7200 } } }), true)
    expect(node(rs, 'car')!.scope).toEqual({ role: 'ev', name: 'easee', id: 'ev-easee' })
    expect(node(rs, 'car')!.word).toBe('charging')
  })

  it('takes the strongest control mark of a kind', () => {
    const rs = ringReadings({
      load: 1,
      planets: [
        planet({ id: 'grid', role: 'grid' }),
        planet({ id: 'bat-a', role: 'battery', controlMark: { tone: 'warning', label: 'a' } }),
        planet({ id: 'bat-b', role: 'battery', controlMark: { tone: 'alarm', label: 'b' } }),
      ],
    }, true)
    expect(node(rs, 'battery')!.mark).toEqual({ tone: 'alarm', label: '1 device needs attention' })
  })

  it('keeps an observe-only battery from opening controls', () => {
    const rs = ringReadings(flowReadingsFromStatus({ grid_w: 0, load_w: 500, drivers: { a: { status: 'ok', bat_w: 0, observe_only: true } } }), true)
    expect(node(rs, 'battery')!.scope).toBeNull()
  })
})

describe('where the nodes sit', () => {
  it('puts a node whose partner across the middle is missing on the axis', () => {
    const all = ['solar', 'battery', 'home', 'grid', 'car'] as const
    expect(all.map((n) => ringSpot(n, all))).toEqual(['topLeading', 'topTrailing', 'center', 'bottomLeading', 'bottomTrailing'])
    expect(ringSpot('solar', ['solar', 'home', 'grid', 'car'])).toBe('top')
    expect(ringSpot('grid', ['solar', 'battery', 'home', 'grid'])).toBe('bottom')
  })

  it('gives each node the quarter facing it, lit from the middle out', () => {
    expect(ringArc('topLeading', 1)).toEqual({ track: [187, 263], lit: [187, 263] })
    expect(ringArc('bottomTrailing', 0.5).lit).toEqual([26, 64])
    expect(ringArc('top', 0).lit).toBeNull()
  })

  it('lights at least a quarter, half at 1.8 kW and nine tenths at 6 kW', () => {
    expect(ringFill(0.04)).toBe(0)
    expect(ringFill(0.05)).toBe(0.25)
    expect(ringFill(0.7)).toBe(0.25)
    expect(ringFill(0.8)).toBeGreaterThan(0.25)
    expect(ringFill(1.8)).toBeCloseTo(0.51, 2)
    expect(ringFill(6)).toBeCloseTo(0.91, 2)
    expect(ringFill(-6)).toBe(ringFill(6))
  })
})

describe('the room it takes', () => {
  it('keeps every corner label clear of the ring at phone and desktop widths', () => {
    for (const width of [320, 351, 390, 600]) {
      const height = flowHeight(width, false)
      const label = labelHeight()
      const g = ringGeometry(width, height, label, nodeWidth(width), false)
      expect(g.labelScale).toBe(1)
      // A corner label's inner corner is at least 10 px outside the ring.
      const dx = width / 2 - nodeWidth(width)
      const dy = g.box / 2 - label
      expect(Math.hypot(dx, dy)).toBeGreaterThanOrEqual(g.radius + g.thickness / 2 + 10 - 0.01)
      expect(height).toBeGreaterThanOrEqual(232)
      expect(height).toBeLessThanOrEqual(420)
    }
  })

  it('keeps the whole ring and its glow inside the flow at any width', () => {
    for (const width of [320, 560, 580, 600, 700, 900]) {
      for (const axis of [false, true]) {
        const height = flowHeight(width, axis)
        const g = ringGeometry(width, height, labelHeight(), nodeWidth(width), axis)
        expect(g.diameter + 3 * g.thickness, `${width} px, axis ${axis}`).toBeLessThanOrEqual(height)
      }
    }
  })

  it('shrinks the labels rather than let them touch the least ring', () => {
    const g = ringGeometry(320, 240, labelHeight(), nodeWidth(320), true)
    expect(g.diameter).toBe(120)
    expect(g.labelScale).toBeLessThan(1)
    expect(g.labelScale).toBeGreaterThanOrEqual(0.7)
  })
})

describe('the figures', () => {
  it('rolls in steps of 10 W, 0.1 kW and 1 kW', () => {
    expect(quantised(634)).toBe(630)
    expect(quantised(7_240)).toBe(7_200)
    expect(quantised(11_600)).toBe(12_000)
  })

  it('holds still on a rounding edge', () => {
    let shown = quantisedHolding(1_450, null)
    for (const w of [1_440, 1_460, 1_449]) shown = quantisedHolding(w, shown)
    expect(shown).toBe(1_500)
    expect(quantisedHolding(1_380, shown)).toBe(1_400)
  })

  it('keys a reading by what it draws, so a 1 W wobble is the same ring', () => {
    const at = (w: number) => ringReadings({ load: 1, planets: [planet({ id: 'grid', role: 'grid', kw: w / 1000 })] }, true)
    expect(ringKey(at(1_401))).toBe(ringKey(at(1_402)))
    expect(ringKey(at(1_401))).not.toBe(ringKey(at(1_480)))
  })

  it('writes what a node does with its level', () => {
    const r = { word: 'charging', levelPct: 68 } as RingReading
    expect(doing(r)).toBe('Charging · 68%')
    expect(doing({ ...r, levelPct: null })).toBe('Charging')
    expect(doing({ ...r, word: '', levelPct: null })).toBe(' ')
  })
})
