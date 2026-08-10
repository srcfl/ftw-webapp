import { mount } from 'svelte'
import './styles/tokens.css'
import './styles/base.css'
import App from './App.svelte'
import { registerServiceWorker } from '$lib/pwa/service-worker.svelte'

const target = document.getElementById('app')
if (!target) throw new Error('missing #app')

// After load, never before: installing a worker re-fetches the whole shell,
// and the first launch is already spending its bandwidth on the box.
addEventListener('load', () => void registerServiceWorker())

export default mount(App, { target })
