import { defineConfig, mergeConfig } from 'vitest/config'
import viteConfig from './vite.config.ts'

// Kept separate from vite.config.ts so the build config stays typed against
// Vite alone — a `test` key there fails svelte-check.
export default mergeConfig(
  viteConfig,
  defineConfig({
    test: {
      environment: 'jsdom',
      include: ['tests/**/*.test.ts', 'src/**/*.test.ts'],
      globals: false,
    },
  })
)
