import { fileURLToPath, URL } from 'node:url'
import { defineConfig } from 'vite'
import { svelte } from '@sveltejs/vite-plugin-svelte'

export default defineConfig({
  plugins: [svelte()],

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
