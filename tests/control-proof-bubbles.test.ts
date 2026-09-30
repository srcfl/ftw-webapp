import {test,expect,vi} from 'vitest'
import '$vendor/ftw/ftw-energy-flow.js'
import type {FtwEnergyFlowElement} from '$vendor/ftw/ftw-energy-flow.js'
import {flowReadingsFromStatus} from '$lib/state/flow'

test('a combined bubble cannot hide an offline sibling alarm or claim its old watts',async()=>{
 const el=document.createElement('ftw-energy-flow') as FtwEnergyFlowElement
 document.body.append(el)
 try {
  el.setReadings(flowReadingsFromStatus({grid_w:1000,load_w:500,drivers:{a:{status:'ok',bat_w:1000},b:{status:'offline',bat_w:5000}},control_feedback:[
   {driver:'a',kind:'battery',reason:'power_observed',verification_tier:2},
   {driver:'b',kind:'battery',reason:'telemetry_stale',verification_tier:0,verification_lost:true,actual_w:null},
  ]}))
  await vi.waitFor(()=>expect(el.shadowRoot!.querySelector('[data-tone="alarm"]')).not.toBeNull())
  const combined=el.shadowRoot!.querySelector('.ef-layer-agg [data-role="battery"]')!
  expect(combined.textContent).toContain('—')
  expect(combined.textContent).not.toContain('6.00 kW')
  expect(el.shadowRoot!.querySelector('.ef-layer[aria-hidden="true"] [tabindex="0"]')).toBeNull()
 } finally {el.remove()}
})

test('setpoint waits do not flash a tier label or alarm, and inactive devices have no mark',async()=>{
 const el=document.createElement('ftw-energy-flow') as FtwEnergyFlowElement
 document.body.append(el)
 const update=async(reason:string,tier:number|null,severity='info',live=true)=>{
  el.setReadings(flowReadingsFromStatus({grid_w:0,load_w:500,drivers:{battery:{status:'ok',bat_w:-500}},control_feedback:[
   {driver:'battery',kind:'battery',reason,verification_tier:tier,severity},
  ]},live))
  await vi.waitFor(()=>expect(el.shadowRoot!.querySelector('[data-role="battery"]')).not.toBeNull())
  await new Promise(resolve=>requestAnimationFrame(resolve))
  return el.shadowRoot!.querySelector('.ef-layer[aria-hidden="false"] [data-role="battery"]')!
 }
 try {
  let node=await update('power_observed',1)
  const color=node.querySelector('.ef-control-proof')!.getAttribute('style')
  node=await update('power_observed',2)
  expect(node.querySelector('.ef-control-proof')!.getAttribute('style')).toBe(color)
  expect(node.querySelector('.ef-control-proof text')).toBeNull()
  expect(node.getAttribute('aria-label')).toContain('Tier 2')
  node=await update('waiting_response',0)
  expect(node.getAttribute('aria-label')).toContain('Verifying the response')
  expect(node.querySelector('[data-tone="alarm"]')).toBeNull()
  node=await update('device_fault',2,'warning')
  expect(node.querySelector('[data-tone="alarm"]')).not.toBeNull()
  node=await update('not_connected',null)
  expect(node.querySelector('.ef-control-proof')).toBeNull()
  node=await update('power_observed',2,'info',false)
  expect(node.getAttribute('aria-label')).toContain('No live proof')
  expect(node.querySelector('[data-tone="confirmed"]')).toBeNull()
 } finally {el.remove()}
})
