import { defineConfig, mergeConfig } from 'vitest/config'
import viteConfig from './vite.config.ts'

// Kept separate from vite.config.ts so the build config stays typed against
// Vite alone — a `test` key there fails svelte-check.
//
// Two projects, because component tests and unit tests want opposite module
// resolution. Mounting a Svelte component needs the browser condition, or the
// resolver hands vitest Svelte's server build and mount() refuses. But the
// browser condition also steers @noble away from its node:crypto fast path,
// which pushed the transport privacy sweep past its timeout on CI. So the
// browser condition applies exactly where components mount — *.svelte.test.ts
// — and nowhere else.
export default mergeConfig(
  viteConfig,
  defineConfig({
    test: {
      projects: [
        {
          extends: true,
          test: {
            name: 'unit',
            environment: 'jsdom',
            include: ['tests/**/*.test.ts', 'src/**/*.test.ts', 'relay/**/*.test.ts'],
            exclude: ['**/node_modules/**', '**/*.svelte.test.ts'],
            globals: false,
          },
        },
        {
          extends: true,
          test: {
            name: 'components',
            environment: 'jsdom',
            include: ['src/**/*.svelte.test.ts'],
            globals: false,
          },
          resolve: {
            conditions: ['browser'],
          },
        },
      ],
    },
  })
)
