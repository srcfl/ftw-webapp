import { mount } from 'svelte'
import './styles/tokens.css'
import './styles/base.css'
import App from './App.svelte'
import { registerServiceWorker } from '$lib/pwa/service-worker.svelte'
import { markLinkPhase } from '$lib/perf/link'

const target = document.getElementById('app')
if (!target) throw new Error('missing #app')

markLinkPhase('app-open')

// After load, never before: installing a worker re-fetches the whole shell,
// and the first launch is already spending its bandwidth on the box.
addEventListener('load', () => void registerServiceWorker())

export default mount(App, { target })

// The boot script resolves the theme once and never listens, so a switch of
// the OS scheme mid-session would go unnoticed. Follow it for installs with
// no stored choice; an explicit choice always wins. Same storage policy as
// the boot script: blocked storage keeps the theme already resolved.
try {
  matchMedia('(prefers-color-scheme: light)').addEventListener('change', ({ matches }) => {
    try {
      if (!localStorage.getItem('ftw.theme')) {
        document.documentElement.dataset.theme = matches ? 'light' : 'dark'
      }
    } catch {
      /* Storage blocked: leave the boot script's resolution in place. */
    }
  })
} catch {
  /* No live media queries here: the boot script's resolution stands. */
}
