import { createHash } from 'node:crypto'
import { fileURLToPath, URL } from 'node:url'
import { defineConfig, type Plugin } from 'vite'
import { svelte } from '@sveltejs/vite-plugin-svelte'

/**
 * Builds src/sw.ts into dist/sw.js and tells it what this build emitted.
 *
 * The worker is emitted as a chunk of the same build rather than a second
 * Vite run, so it is compiled once, by the same config, and can never be
 * stale relative to the app beside it.
 *
 * The list is injected instead of discovered at runtime because a worker that
 * asks a server what to cache has already lost the guarantee it exists for:
 * the answer can change between two fetches, and then the shell and its assets
 * come from different builds. `v` hashes the bytes, so any change to any
 * precached file changes sw.js — which is what makes the browser notice an
 * update at all.
 */
function serviceWorker(): Plugin {
  return {
    name: 'ftw:service-worker',
    apply: 'build',
    enforce: 'post',

    buildStart() {
      this.emitFile({
        type: 'chunk',
        id: fileURLToPath(new URL('./src/sw.ts', import.meta.url)),
        fileName: 'sw.js',
      })
    },

    generateBundle(_options, bundle) {
      const worker = bundle['sw.js']
      if (worker?.type !== 'chunk') throw new Error('sw.js was not emitted')

      const hash = createHash('sha256')
      const files: string[] = []

      for (const name of Object.keys(bundle).sort()) {
        if (name === 'sw.js' || name.endsWith('.map')) continue
        const output = bundle[name]
        if (!output) continue

        // index.html is cached under the path a launch actually requests.
        const path = name === 'index.html' ? '/' : `/${name}`
        if (path !== '/' && !name.endsWith('.js') && !name.endsWith('.css')) continue

        files.push(path)
        hash.update(output.type === 'chunk' ? output.code : output.source)
      }

      // Copied from public/, so it is not in the bundle. Cached because an
      // installed app reads it on launch and it is a few hundred bytes.
      files.push('/manifest.webmanifest')

      const precache = { v: hash.digest('hex').slice(0, 12), files: files.sort() }
      worker.code = worker.code.replace(/__PRECACHE__/g, JSON.stringify(precache))
    },
  }
}

export default defineConfig({
  plugins: [svelte(), serviceWorker()],

  define: {
    // The build identifier the app announces at handshake, so a box can tell
    // which client it is talking to. Replaced by the release hash in CI.
    __APP_BUILD__: JSON.stringify(process.env['GITHUB_SHA']?.slice(0, 12) ?? 'dev'),
  },

  resolve: {
    alias: {
      $lib: fileURLToPath(new URL('./src/lib', import.meta.url)),
      $views: fileURLToPath(new URL('./src/views', import.meta.url)),
    },
  },

  build: {
    // The service worker pins a bundle by hash, so filenames must stay
    // content-addressed and the manifest must be emitted.
    manifest: true,
    sourcemap: true,
    target: 'es2022',
    // A separate vendor chunk for the crypto core will earn its keep once
    // that layer exists — it changes far less often than the UI. Splitting
    // packages nothing imports yet would only add a config to maintain.
  },
})
