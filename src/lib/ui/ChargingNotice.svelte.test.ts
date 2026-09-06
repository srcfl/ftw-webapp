import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render } from '@testing-library/svelte'
import { flushSync } from 'svelte'
import ChargingNotice from './ChargingNotice.svelte'
import { watchCharging, type ChargingSnapshot } from '$lib/state/charging-watch'
import { toLoadpoint } from '$lib/format/ev'
import type { SiteStore } from '$lib/state/site.svelte'

vi.mock('$lib/state/charging-watch', () => ({ watchCharging: vi.fn() }))
afterEach(() => { cleanup(); vi.restoreAllMocks() })

describe('charging status when the active box changes', () => {
 it('switches the shared subscription and does not resubscribe on each reading', async () => {
  const callbacks: ((snapshot: ChargingSnapshot) => void)[] = []
  const stops: ReturnType<typeof vi.fn>[] = []
  vi.mocked(watchCharging).mockReset().mockImplementation((_site, next) => {
   callbacks.push(next)
   const stop = vi.fn(); stops.push(stop)
   next({points: [], fresh: false})
   return stop
  })
  const first = {session: {phase: 'streaming'}} as SiteStore
  const second = {session: {phase: 'streaming'}} as SiteStore
  const view = render(ChargingNotice, {site: first})
  flushSync()
  expect(watchCharging).toHaveBeenCalledTimes(1)
  flushSync(() => callbacks[0]!({fresh: true, points: [toLoadpoint({id: 'first', plugged_in: true})]}))
  expect(view.getByRole('link').getAttribute('href')).toBe('#/now?charger=first')
  expect(watchCharging).toHaveBeenCalledTimes(1)
  await view.rerender({site: second})
  flushSync()
  expect(stops[0]).toHaveBeenCalledOnce()
  expect(watchCharging).toHaveBeenCalledTimes(2)
  expect(watchCharging).toHaveBeenLastCalledWith(second, expect.any(Function))
  expect(view.queryByRole('link')).toBeNull()
  flushSync(() => callbacks[1]!({fresh: true, points: [toLoadpoint({id: 'second', plugged_in: true})]}))
  expect(view.getByRole('link').getAttribute('href')).toBe('#/now?charger=second')
  view.unmount()
  expect(stops[1]).toHaveBeenCalledOnce()
 })
})
