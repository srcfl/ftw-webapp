import { afterEach, expect, it, vi } from 'vitest'
import { cleanup, render } from '@testing-library/svelte'
import NowOutlook from './NowOutlook.svelte'
import { SiteStore } from '$lib/state/site.svelte'
import { LoopbackCarrier } from '$lib/carrier/loopback'
import { SimBox } from '$lib/sim/box'

afterEach(() => { cleanup(); vi.useRealTimers(); vi.restoreAllMocks() })

it('requests only seven savings days and keeps the same today and week amounts', async () => {
  vi.useFakeTimers()
  vi.setSystemTime(Date.UTC(2026, 6, 31, 18, 30))
  const site = new SiteStore('test')
  site.connect(new LoopbackCarrier(new SimBox({ now: () => Date.now() }), { latencyMs: 5 }))
  for (let i = 0; i < 100 && site.session.phase !== 'streaming'; i++) await vi.advanceTimersByTimeAsync(10)
  const month = Array.from({ length: 31 }, (_, i) => ({
    day: `2026-07-${String(i + 1).padStart(2, '0')}`,
    saved_ore: (i + 1) * 100,
    resolution: 'slot',
  }))
  const requested: string[] = []
  const api = site.api.bind(site)
  vi.spyOn(site, 'api').mockImplementation(async req => {
    if (req.path !== '/api/savings/daily') return api(req)
    const days = String(req.query?.days)
    requested.push(days)
    return { status: 200, headers: {}, body: new TextEncoder().encode(JSON.stringify({ days: month.slice(-Number(days)) })) }
  })
  render(NowOutlook, { props: { site, status: { energy: { today: { import_wh: 0, export_wh: 0, pv_wh: 0 } } } } })
  await vi.advanceTimersByTimeAsync(1_000)
  expect(requested).toEqual(['7'])
  expect(document.querySelector('.card.today')?.textContent).toContain('+31.0')
  expect(document.querySelector('.card.today')?.textContent).toContain('+196 this week')
  await vi.advanceTimersByTimeAsync(60_000)
  expect(requested).toEqual(['7'])
})
