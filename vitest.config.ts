import { defineConfig, mergeConfig } from 'vitest/config'
import viteConfig from './vite.config.ts'

// Kept separate from vite.config.ts so the build config stays typed against
// Vite alone — a `test` key there fails svelte-check.
export default mergeConfig(
  viteConfig,
  defineConfig({
    test: {
      environment: 'jsdom',
      include: ['tests/**/*.test.ts', 'src/**/*.test.ts', 'relay/**/*.test.ts'],
      globals: false,
    },
    // Component tests mount real Svelte components in jsdom. Without this the
    // resolver picks Svelte's server build and mount() refuses to run.
    resolve: {
      conditions: ['browser'],
    },
  })
)
