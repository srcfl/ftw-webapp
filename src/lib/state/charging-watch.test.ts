import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { watchCharging, refreshCharging, type ChargingSnapshot } from './charging-watch'
import { callBox } from './box-api'
import { CAP_API_PASSTHROUGH } from '$lib/protocol/contract'
import type { SiteStore } from './site.svelte'

vi.mock('./box-api', () => ({ callBox: vi.fn() }))
const read = vi.mocked(callBox)
const stops: (() => void)[] = []
function site() { return { session: { phase: 'streaming', caps: new Set([CAP_API_PASSTHROUGH]) } } as unknown as SiteStore }
const plugged = { id: 'garage', plugged_in: true, current_power_w: 4300, charger: { available: true } }

beforeEach(() => { vi.useFakeTimers(); read.mockReset(); vi.spyOn(document, 'hidden', 'get').mockReturnValue(false) })
afterEach(() => { stops.splice(0).forEach(stop => stop()); vi.restoreAllMocks(); vi.useRealTimers() })

describe('shared charging status', () => {
  it('uses one request for two views and stops after both leave', async () => {
    read.mockResolvedValue({ loadpoints: [plugged] })
    const home = site(), a = vi.fn(), b = vi.fn()
    const stopA = watchCharging(home, a), stopB = watchCharging(home, b)
    stops.push(stopA, stopB)
    await vi.advanceTimersByTimeAsync(0)
    expect(read).toHaveBeenCalledTimes(1)
    expect(a.mock.lastCall?.[0].fresh).toBe(true)
    expect(b.mock.lastCall?.[0].points[0].pluggedIn).toBe(true)
    stopA()
    await vi.advanceTimersByTimeAsync(5000)
    expect(read).toHaveBeenCalledTimes(2)
    stopB()
    await vi.advanceTimersByTimeAsync(30000)
    expect(read).toHaveBeenCalledTimes(2)
  })
  it('refreshes both views after an action without waiting for the poll', async () => {
    read.mockResolvedValueOnce({ loadpoints: [plugged] })
      .mockResolvedValue({ loadpoints: [{ ...plugged, current_power_w: 0, manual_active: true, manual: { state: 'paused' } }] })
    const home = site(), listener = vi.fn()
    stops.push(watchCharging(home, listener))
    await vi.advanceTimersByTimeAsync(0)
    expect(listener.mock.lastCall?.[0].points[0].powerW).toBe(4300)
    refreshCharging(home)
    await vi.advanceTimersByTimeAsync(0)
    expect(read).toHaveBeenCalledTimes(2)
    expect(listener.mock.lastCall?.[0].points[0].manual?.state).toBe('paused')
  })
  it('re-asks after an older in-flight read when an action requests a refresh', async () => {
    let finish!: (value: unknown) => void
    read.mockReturnValueOnce(new Promise(resolve => { finish = resolve }))
      .mockResolvedValue({ loadpoints: [{ ...plugged, current_power_w: 0 }] })
    const home = site(), listener = vi.fn()
    stops.push(watchCharging(home, listener))
    refreshCharging(home)
    finish({ loadpoints: [plugged] })
    await vi.advanceTimersByTimeAsync(1)
    expect(read).toHaveBeenCalledTimes(2)
    expect(listener.mock.lastCall?.[0].points[0].powerW).toBe(0)
  })
  it('expires the last reading while the next request is still waiting', async () => {
    read.mockResolvedValueOnce({ loadpoints: [plugged] }).mockReturnValue(new Promise(() => {}))
    let latest: ChargingSnapshot | undefined
    stops.push(watchCharging(site(), next => { latest = next }))
    await vi.advanceTimersByTimeAsync(0)
    expect(latest?.fresh).toBe(true)
    await vi.advanceTimersByTimeAsync(15001)
    expect(latest?.fresh).toBe(false)
    expect(latest?.points[0]?.pluggedIn).toBe(true)
  })
  it('keeps connection evidence on failed or unavailable reads, then accepts a fresh unplug', async () => {
    read.mockResolvedValueOnce({ loadpoints: [plugged] })
      .mockRejectedValueOnce(new Error('offline'))
      .mockResolvedValueOnce({ loadpoints: [{ ...plugged, plugged_in: false, charger: { available: false } }] })
      .mockResolvedValue({ loadpoints: [{ ...plugged, plugged_in: false }] })
    let latest: ChargingSnapshot | undefined
    stops.push(watchCharging(site(), next => { latest = next }))
    await vi.advanceTimersByTimeAsync(5000)
    expect(latest?.fresh).toBe(false)
    expect(latest?.points[0]?.pluggedIn).toBe(true)
    await vi.advanceTimersByTimeAsync(5000)
    expect(latest?.points[0]?.pluggedIn).toBe(true)
    expect(latest?.points[0]?.charger?.available).toBe(false)
    await vi.advanceTimersByTimeAsync(5000)
    expect(latest?.points[0]?.pluggedIn).toBe(false)
  })
  it('marks hidden status stale, stops polling, and refreshes on return', async () => {
    const hidden = vi.spyOn(document, 'hidden', 'get').mockReturnValue(false)
    read.mockResolvedValue({ loadpoints: [plugged] })
    const listener = vi.fn()
    stops.push(watchCharging(site(), listener))
    await vi.advanceTimersByTimeAsync(0)
    hidden.mockReturnValue(true)
    document.dispatchEvent(new Event('visibilitychange'))
    expect(listener.mock.lastCall?.[0].fresh).toBe(false)
    await vi.advanceTimersByTimeAsync(30000)
    expect(read).toHaveBeenCalledTimes(1)
    hidden.mockReturnValue(false)
    document.dispatchEvent(new Event('visibilitychange'))
    await vi.advanceTimersByTimeAsync(0)
    expect(read).toHaveBeenCalledTimes(2)
    expect(listener.mock.lastCall?.[0].fresh).toBe(true)
  })
})
