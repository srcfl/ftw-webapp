import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ApiResponse } from '$lib/protocol/session'
import { EnergyStore } from './energy.svelte'
import { SiteStore } from './site.svelte'

describe('energy period changes', () => {
  afterEach(() => vi.restoreAllMocks())

  it('does not call a new period empty because the previous period was empty', async () => {
    const site = new SiteStore('test')
    const api = vi.spyOn(site, 'api').mockResolvedValue({
      status: 200, headers: {},
      body: new TextEncoder().encode('{"days":[]}'),
    })
    const energy = new EnergyStore(site)
    await energy.load()
    expect(energy.loaded).toBe(true)

    energy.select('today')
    expect(energy.loaded).toBe(false)
    expect(energy.days).toEqual([])
    expect(api).toHaveBeenCalledTimes(1)
    site.destroy()
  })

  it.each(['success', 'failure'] as const)('ignores a late %s before the next period can be fetched', async outcome => {
    const site = new SiteStore('test')
    let answer!: (response: ApiResponse) => void
    vi.spyOn(site, 'api').mockReturnValue(new Promise(resolve => { answer = resolve }))
    const energy = new EnergyStore(site)
    const pending = energy.load()

    // The new range may be selected offline, before another load can start.
    energy.select('today')
    answer({
      status: outcome === 'success' ? 200 : 503,
      headers: {},
      body: new TextEncoder().encode(JSON.stringify({ days: [{ day: '2026-07-15', load_wh: 308_000 }] })),
    })
    await expect(pending).resolves.toBeUndefined()
    expect(energy.spec.title).toBe('Today')
    expect(energy.days).toEqual([])
    expect(energy.loaded).toBe(false)
    expect(energy.loading).toBe(false)
    expect(energy.error).toBeNull()
    site.destroy()
  })
})
