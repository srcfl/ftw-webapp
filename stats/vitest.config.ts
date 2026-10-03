import { fileURLToPath } from 'node:url'
import { cloudflareTest, readD1Migrations } from '@cloudflare/vitest-pool-workers'
import { defineConfig } from 'vitest/config'

const configPath = fileURLToPath(new URL('./wrangler.jsonc', import.meta.url))
const migrationsPath = fileURLToPath(new URL('./migrations', import.meta.url))
const migrations = await readD1Migrations(migrationsPath)

export default defineConfig({
  plugins: [
    cloudflareTest({
      wrangler: { configPath },
      miniflare: {
        bindings: {
          GITHUB_REPOS: 'ftw',
          GITHUB_TOKEN: 'github-test-token',
          CLOUDFLARE_ZONE_ID: '0123456789abcdef0123456789abcdef',
          CLOUDFLARE_ANALYTICS_TOKEN: 'cloudflare-analytics-test-token',
          RELAY_INGEST_SECRET: '0123456789abcdef0123456789abcdef',
          ACCESS_TEAM_DOMAIN: 'https://test.cloudflareaccess.com',
          ACCESS_AUD: 'test-audience',
          TEST_MIGRATIONS: migrations,
        },
      },
    }),
  ],
  test: {
    include: ['stats/test/**/*.test.ts'],
  },
})
