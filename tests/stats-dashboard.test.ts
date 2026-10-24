import { afterEach, describe, expect, it, vi } from 'vitest'
import { dashboardDocument } from '../stats/src/dashboard.ts'

afterEach(() => {
  vi.unstubAllGlobals()
  document.documentElement.innerHTML = ''
})

async function render(privateView = false, extra: Record<string, unknown> = {}) {
  const now = Date.now()
  const hoursAgo = (hours: number) => new Date(now - hours * 3600_000).toISOString()
  const data = {
    mode: privateView ? 'private' : 'public',
    generated_at: hoursAgo(0),
    coverage: { repositories: ['ftw', 'device-drivers', 'ftw-cloud', 'ftw-app', 'ftw-webapp', 'ftw-web'], pending_repositories: ['ftw-cloud', 'ftw-app', 'ftw-web'] },
    freshness: { github: hoursAgo(6), github_traffic: hoursAgo(6), site: hoursAgo(0), fleet: hoursAgo(1), relay: hoursAgo(0) },
    github: { repositories: [{ repo: 'ftw', latest_release: 'v0.144.1-beta.1' }, { repo: 'ftw-cloud' }], totals: { stars: 21 }, history: [{repo:'ftw',date:'2026-10-15',stars:20},{repo:'ftw',date:'2026-10-16',stars:21},{repo:'ftw',date:'2026-10-17',stars:21},{repo:'ftw-cloud',date:'2026-10-17',stars:1}], traffic:[{repo:'ftw',date:'2026-10-16',views:9}] },
    site: { hostname: 'app.ftw.energy', totals: { visits_7d: 227 } },
    fleet: { state: 'withheld', minimum: 10, reports_30d: null, days: [] },
    relay_activity: { state: 'reporting', rooms_band: '10–99' },
    relay: { state: 'visible', latest: { rooms: 17, sockets: 20, observed_at: hoursAgo(0) } },
  }
  Object.assign(data, extra)
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(Response.json(data)))
  const html = dashboardDocument(privateView).html
  document.documentElement.innerHTML = html
  const script = document.querySelector('script')!.textContent!
  new Function(script)()
  await vi.waitFor(() => expect(document.getElementById('stars')!.textContent).toBe('21'))
}

describe('stats dashboard coverage', () => {
  it('distinguishes a seven-day installation estimate from paused energy collection', async () => {
    await render(false, {
      installation_estimate: {state:'estimated',value:22,reports:156,days:7,window_start:'2026-10-10',window_end:'2026-10-16',source:'cloud.ftw.energy'},
      usage: {state:'paused'},
    })
    expect(document.getElementById('overview-installations')!.textContent).toBe('≈ 22')
    expect(document.getElementById('installation-period')!.textContent).toContain('2026-10-10 to 2026-10-16')
    expect(document.getElementById('installation-method')!.textContent).toContain('not people or all-time installs')
    expect(document.getElementById('usage-age')!.textContent).toBe('Waiting for review')
    expect(document.getElementById('usage-note')!.textContent).toContain('off pending privacy review')
    expect(document.getElementById('usage-power')!.textContent).toBe('—')
  })

  it('shows the whole configured stack, names missing sources and keeps relay load out of the public view', async () => {
    await render()
    const rows = document.querySelectorAll('#repositories tr')
    expect(rows).toHaveLength(6)
    expect(document.querySelector('#repositories a[href="https://github.com/srcfl/ftw-app"]')).not.toBeNull()
    expect(document.querySelector('#repositories a[href="https://github.com/srcfl/ftw-cloud"]')).not.toBeNull()
    expect(rows[3]!.textContent).toContain('Awaiting first collection')
    expect(rows[0]!.textContent).toContain('v0.144.1-beta.1')
    expect(document.getElementById('site-hostname')!.textContent).toBe('app.ftw.energy')
    expect(document.getElementById('relay-section')!.hidden).toBe(true)
    expect(document.getElementById('coverage-title')!.parentElement!.parentElement!.parentElement!.textContent).toContain('App Store installs are not collected')
    expect(document.getElementById('overview-installations')!.textContent).toBe('—')
    expect(document.querySelectorAll('#star-chart circle')).toHaveLength(3)
    expect(document.querySelectorAll('#star-chart polyline')).toHaveLength(2)
    expect(document.querySelector('#traffic-chart .bar-wrap')!.getAttribute('title')).toContain('1/2 repos')
    expect(document.getElementById('fleet-source')!.textContent).toContain('retired relay')
  })

  it('grades the daily GitHub traffic feed separately from hourly sources', async () => {
    await render()
    const items = [...document.querySelectorAll('#freshness .freshness-item')]
    expect(items.find((item) => item.textContent!.startsWith('Repo traffic'))!.querySelector('.dot.ok')).not.toBeNull()
    expect(items.find((item) => item.textContent!.startsWith('GitHub'))!.querySelector('.dot.warn')).not.toBeNull()
    // The hourly usage feed and the daily energy feed each have their own dot.
    expect(items.find((item) => item.textContent!.startsWith('Hourly energy'))!.querySelector('.dot.idle')).not.toBeNull()
    expect(items.find((item) => item.textContent!.startsWith('Daily energy'))!.querySelector('.dot.idle')).not.toBeNull()
    expect(items.some(item => item.textContent!.includes('Legacy'))).toBe(false)
  })

  it('keeps the old relay counters available as private migration diagnostics', async () => {
    await render(true)
    expect(document.getElementById('relay-section')!.hidden).toBe(false)
    expect(document.getElementById('relay-title')!.textContent).toBe('Legacy relay load')
    expect(document.getElementById('relay-rooms')!.textContent).toBe('17')
    expect(document.getElementById('relay-note')!.textContent).toContain('do not measure FTW Cloud')
  })
})
