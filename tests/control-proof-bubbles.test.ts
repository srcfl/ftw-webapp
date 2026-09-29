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
  await vi.waitFor(()=>expect(el.shadowRoot!.textContent).toContain('⚠ 1 alarm'))
  const combined=el.shadowRoot!.querySelector('.ef-layer-agg [data-role="battery"]')!
  expect(combined.textContent).toContain('—')
  expect(combined.textContent).not.toContain('6.00 kW')
  expect(el.shadowRoot!.querySelector('.ef-layer[aria-hidden="true"] [tabindex="0"]')).toBeNull()
 } finally {el.remove()}
})
