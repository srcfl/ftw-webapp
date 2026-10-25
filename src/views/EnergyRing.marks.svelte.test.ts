import {test,expect,afterEach} from 'vitest'
import {render} from '@testing-library/svelte'
import EnergyRing from './EnergyRing.svelte'
import {flowReadingsFromStatus, type SiteStatus} from '$lib/state/flow'
import {ringReadings} from '$lib/state/ring'

HTMLCanvasElement.prototype.getContext = (() => null) as never

const row=(extra:Record<string,unknown>)=>({driver:'battery',kind:'battery',status:'following',reason:'power_observed',severity:'info',evidence:'measured',readings_fresh:true,...extra})

const battery=(status:SiteStatus,live=true)=>{
 document.body.replaceChildren()
 render(EnergyRing,{props:{readings:ringReadings(flowReadingsFromStatus(status,live),live)}})
 return document.querySelector<HTMLElement>('[data-node="battery"]')!
}

afterEach(()=>document.body.replaceChildren())

test('a folded node cannot hide an offline sibling alarm or claim its old watts',()=>{
 const node=battery({grid_w:1000,load_w:500,drivers:{a:{status:'ok',bat_w:1000},b:{status:'offline',bat_w:5000}},control_feedback:[
  row({driver:'a',evidence:'confirmed'}),
  row({driver:'b',status:'no_contact',reason:'readings_lost',severity:'alarm',evidence:'accepted',readings_fresh:false,actual_w:null}),
 ]})
 expect(node.querySelector('.mark')?.getAttribute('data-tone')).toBe('alarm')
 expect(node.textContent).not.toContain('6.0 kW')
 // One pack is missing, so the sum is not the whole reading.
 expect(node.getAttribute('aria-label')).toMatch(/not live/)
})

test('the ring marks only what needs a look and stays quiet otherwise',()=>{
 const update=(extra:Record<string,unknown>,live=true)=>
  battery({grid_w:0,load_w:500,drivers:{battery:{status:'ok',bat_w:-500}},control_feedback:[row(extra)]},live)
 let node=update({evidence:'confirmed'})
 expect(node.querySelector('.mark')).toBeNull()
 node=update({status:'waiting',reason:'waiting_response',evidence:'accepted'})
 expect(node.querySelector('.mark')).toBeNull()
 node=update({status:'not_following',reason:'setpoint_changed',severity:'warning'})
 expect(node.querySelector('.mark')?.getAttribute('data-tone')).toBe('warning')
 expect(node.getAttribute('aria-label')).toContain('Not following')
 node=update({status:'not_following',reason:'device_fault',severity:'alarm'})
 expect(node.querySelector('.mark')?.getAttribute('data-tone')).toBe('alarm')
 // A cached snapshot raises no alarm it cannot stand behind.
 node=update({status:'no_contact',reason:'readings_lost',severity:'alarm'},false)
 expect(node.querySelector('.mark')).toBeNull()
})
