import {test,expect,vi} from 'vitest'
import '$vendor/ftw/ftw-energy-flow.js'
import type {FtwEnergyFlowElement} from '$vendor/ftw/ftw-energy-flow.js'
import {flowReadingsFromStatus} from '$lib/state/flow'

const row=(extra:Record<string,unknown>)=>({driver:'battery',kind:'battery',status:'following',reason:'power_observed',severity:'info',evidence:'measured',readings_fresh:true,...extra})

test('a combined bubble cannot hide an offline sibling alarm or claim its old watts',async()=>{
 const el=document.createElement('ftw-energy-flow') as FtwEnergyFlowElement
 document.body.append(el)
 try {
  el.setReadings(flowReadingsFromStatus({grid_w:1000,load_w:500,drivers:{a:{status:'ok',bat_w:1000},b:{status:'offline',bat_w:5000}},control_feedback:[
   row({driver:'a',evidence:'confirmed'}),
   row({driver:'b',status:'no_contact',reason:'readings_lost',severity:'alarm',evidence:'accepted',readings_fresh:false,actual_w:null}),
  ]}))
  await vi.waitFor(()=>expect(el.shadowRoot!.querySelector('.ef-control-mark[data-tone="alarm"]')).not.toBeNull())
  const combined=el.shadowRoot!.querySelector('.ef-layer-agg [data-role="battery"]')!
  expect(combined.querySelector('.ef-control-mark[data-tone="alarm"]')).not.toBeNull()
  expect(combined.textContent).not.toContain('6.00 kW')
  expect(el.shadowRoot!.querySelector('.ef-layer[aria-hidden="true"] [tabindex="0"]')).toBeNull()
 } finally {el.remove()}
})

test('the overview marks only what needs a look and stays quiet otherwise',async()=>{
 const el=document.createElement('ftw-energy-flow') as FtwEnergyFlowElement
 document.body.append(el)
 const update=async(extra:Record<string,unknown>,live=true)=>{
  el.setReadings(flowReadingsFromStatus({grid_w:0,load_w:500,drivers:{battery:{status:'ok',bat_w:-500}},control_feedback:[row(extra)]},live))
  await vi.waitFor(()=>expect(el.shadowRoot!.querySelector('[data-role="battery"]')).not.toBeNull())
  await new Promise(resolve=>requestAnimationFrame(resolve))
  return el.shadowRoot!.querySelector('.ef-layer[aria-hidden="false"] [data-role="battery"]')!
 }
 try {
  let node=await update({evidence:'confirmed'})
  expect(node.querySelector('.ef-control-mark')).toBeNull()
  expect(node.getAttribute('aria-label')).not.toMatch(/tier/i)
  node=await update({status:'waiting',reason:'waiting_response',evidence:'accepted'})
  expect(node.querySelector('.ef-control-mark')).toBeNull()
  node=await update({status:'not_following',reason:'setpoint_changed',severity:'warning'})
  expect(node.querySelector('.ef-control-mark[data-tone="warning"]')).not.toBeNull()
  expect(node.getAttribute('aria-label')).toContain('Not following')
  node=await update({status:'not_following',reason:'device_fault',severity:'alarm'})
  expect(node.querySelector('.ef-control-mark[data-tone="alarm"]')).not.toBeNull()
  node=await update({status:'no_contact',reason:'readings_lost',severity:'alarm'},false)
  expect(node.querySelector('.ef-control-mark')).toBeNull()
 } finally {el.remove()}
})
