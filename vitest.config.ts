import { defineConfig, mergeConfig } from 'vitest/config'
import viteConfig from './vite.config.ts'

/**
 * The timezone the whole suite runs in, wherever it is run.
 *
 * Local time is not decoration in this app: the price window starts at local
 * midnight, the publish hour is local, and the day the chart draws is the
 * local one. Under TZ=UTC getHours() and getUTCHours() return the same number,
 * so every assertion that says "local" passes just as well against code
 * reading UTC — and a suite that is only honest on a machine that happens to
 * sit at an offset is a suite people learn to ignore when it goes red.
 *
 * A half-hour offset rather than a whole-hour one, because a day boundary
 * computed by flooring to a UTC hour lands inside the local day at +05:30 and
 * nowhere in Europe. No daylight saving either, so the same instant is the
 * same local hour in January as in July. The control at the top of
 * tests/price-e2e.test.ts fails if this ever goes away.
 */
const TZ = 'Asia/Kolkata'

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
            env: { TZ },
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
            env: { TZ },
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
