export interface AppEnv {
  DB: D1Database
  GITHUB_OWNER: string
  GITHUB_REPOS: string
  SITE_HOSTNAME: string
  PUBLIC_MIN_REPORTS: string
  GITHUB_TOKEN?: string
  CLOUDFLARE_ZONE_ID?: string
  CLOUDFLARE_ANALYTICS_TOKEN?: string
  RELAY_INGEST_SECRET?: string
  ACCESS_TEAM_DOMAIN?: string
  ACCESS_AUD?: string
}

export interface GitHubSnapshot {
  repo: string
  capturedHour: string
  capturedAt: string
  stars: number
  forks: number
  watchers: number
  openPrs: number
  draftPrs: number
  dependencyPrs: number
  openIssues: number
  mergedPrs30d: number
  closedIssues30d: number
  contributors: number
  pushedAt: string | null
  latestRelease: string | null
  latestReleaseAt: string | null
}

export interface FleetDimensions {
  ftw_versions: Record<string, number>
  channels: Record<string, number>
  drivers: Record<string, number>
  battery_kwh: Record<string, number>
  price_zones: Record<string, number>
  install_age: Record<string, number>
}

export interface FleetDay extends FleetDimensions {
  date: string
  reports: number
}

export interface RelayIngestBody {
  schema: 'ftw.relay-stats/1'
  observed_at: string
  relay: {
    uptime_seconds: number
    rooms: number
    sockets: number
    frames_routed: number
    bytes_routed: number
  }
  fleet: {
    schema: 'ftw.fleet-stats/1'
    meaning: 'reports, not unique boxes'
    days: FleetDay[]
  }
}

export interface AccessIdentity {
  email: string
}
