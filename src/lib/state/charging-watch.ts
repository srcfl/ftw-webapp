import { callBox } from './box-api'
import { toLoadpoint, type Loadpoint, type WireLoadpoint } from '$lib/format/ev'
import { CAP_API_PASSTHROUGH } from '$lib/protocol/contract'
import type { SiteStore } from './site.svelte'

export interface ChargingSnapshot { points: Loadpoint[]; fresh: boolean }
type Listener = (snapshot: ChargingSnapshot) => void
const watches = new WeakMap<SiteStore, { subscribe: (listener: Listener) => () => void; refresh: () => void }>()

/** A confirmed action should reach the home card before its next timer. */
export function refreshCharging(site: SiteStore): void { watches.get(site)?.refresh() }

/** One read for the home card and power diagram. Hidden phones stop polling. */
export function watchCharging(site: SiteStore, listener: Listener): () => void {
  let watch = watches.get(site)
  if (!watch) {
    const listeners = new Set<Listener>()
    let snapshot: ChargingSnapshot = { points: [], fresh: false }
    let timer: ReturnType<typeof setTimeout> | undefined
    let reading = false
    let refreshPending = false
    let staleTimer: ReturnType<typeof setTimeout> | undefined
    const expire = () => { snapshot = { ...snapshot, fresh: false }; publish() }
    const publish = () => { for (const fn of listeners) fn(snapshot) }
    const tick = async () => {
      clearTimeout(timer)
      if (!listeners.size || reading || document.hidden) return
      reading = true
      refreshPending = false
      try {
        if (site.session.phase !== 'streaming' || !site.session.caps.has(CAP_API_PASSTHROUGH)) {
          snapshot = { ...snapshot, fresh: false }
        } else {
          const wire = await callBox<{ loadpoints?: WireLoadpoint[] }>(site, { method: 'GET', path: '/api/loadpoints' })
          if (!Array.isArray(wire.loadpoints)) throw new Error('Missing charger status')
          const points = wire.loadpoints.map(toLoadpoint).map(lp => {
            const previous = snapshot.points.find(p => p.id === lp.id)
            return lp.charger?.available === false && previous?.pluggedIn ? { ...lp, pluggedIn: true } : lp
          })
          snapshot = { points, fresh: !document.hidden && site.session.phase === 'streaming' }
          clearTimeout(staleTimer)
          if (listeners.size) staleTimer = setTimeout(expire, 15_000)
        }
      } catch { snapshot = { ...snapshot, fresh: false } }
      finally {
        reading = false
        if (listeners.size) { publish(); timer = setTimeout(() => void tick(), refreshPending ? 0 : 5_000) }
      }
    }
    const visibility = () => {
      clearTimeout(timer)
      snapshot = { ...snapshot, fresh: false }
      publish()
      if (!document.hidden) void tick()
    }
    watch = { refresh() {
      if (reading) refreshPending = true
      else void tick()
    }, subscribe(fn) {
      listeners.add(fn)
      fn({ ...snapshot, fresh: false })
      if (listeners.size === 1) { document.addEventListener('visibilitychange', visibility); void tick() }
      return () => {
        listeners.delete(fn)
        if (!listeners.size) { clearTimeout(timer); clearTimeout(staleTimer); document.removeEventListener('visibilitychange', visibility) }
      }
    } }
    watches.set(site, watch)
  }
  return watch.subscribe(listener)
}
