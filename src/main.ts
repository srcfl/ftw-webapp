import { mount } from 'svelte'
import './styles/tokens.css'
import './styles/base.css'
import App from './App.svelte'
import { registerServiceWorker } from '$lib/pwa/service-worker.svelte'
import { markIfReserved } from '$lib/pwa/reserved'

const target = document.getElementById('app')
if (!target) throw new Error('missing #app')

// Before the first paint: whether the tab bar has to clear the home
// indicator itself, or the system already did it. One class, read once.
markIfReserved()

// After load, never before: installing a worker re-fetches the whole shell,
// and the first launch is already spending its bandwidth on the box.
addEventListener('load', () => void registerServiceWorker())

export default mount(App, { target })
