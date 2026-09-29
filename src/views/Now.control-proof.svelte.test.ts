import {test,expect,vi} from 'vitest'
import {render,cleanup} from '@testing-library/svelte'
import Now from './Now.svelte'
import {SiteStore} from '$lib/state/site.svelte'
import {LoopbackCarrier} from '$lib/carrier/loopback'
import {SimBox} from '$lib/sim/box'

test('keeps proof inside each bubble and opens only that device, including after proof expires',async()=>{
  vi.useFakeTimers()
  vi.setSystemTime(new Date(2026,6,15,12))
  Object.defineProperties(HTMLDialogElement.prototype,{
    showModal:{configurable:true,value:function(this:HTMLDialogElement){this.setAttribute('open','')}},
    close:{configurable:true,value:function(this:HTMLDialogElement){this.removeAttribute('open')}},
  })
  const box=new SimBox({now:()=>Date.now()})
  const site=new SiteStore('proof-test')
  const api=site.api.bind(site)
  let lost=false
  vi.spyOn(site,'api').mockImplementation(req=>{
    if(req.path!=='/api/status') return api(req)
    const status={grid_w:1000,load_w:500,drivers:{sungrow:{status:'ok',bat_w:1000}},control_feedback:[
      {driver:'sungrow',kind:'battery',reason:lost?'telemetry_stale':'power_observed',verification_tier:lost?0:2,verification_lost:lost,actual_w:lost?null:1000},
      {driver:'easee',kind:'ev',reason:'telemetry_stale',verification_tier:0,verification_lost:true,actual_w:null},
    ]}
    return Promise.resolve({status:200,headers:{},body:new TextEncoder().encode(JSON.stringify(status))})
  })
  try {
    site.connect(new LoopbackCarrier(box,{latencyMs:0}))
    const view=render(Now,{props:{site}})
    for(let i=0;i<200;i++){box.tick(20);await vi.advanceTimersByTimeAsync(20)}
    expect(view.queryByText('Are you in control?')).toBeNull()
    const flow=document.querySelector('ftw-energy-flow')!
    const button=flow.shadowRoot!.querySelector('.ef-layer[aria-hidden="false"] [data-role="battery"]')!
    expect(button.getAttribute('aria-label')).toContain('Tier 2')
    button.dispatchEvent(new MouseEvent('click',{bubbles:true}))
    await vi.advanceTimersByTimeAsync(10)
    const dialog=document.querySelector('dialog[open]')!
    expect(dialog.textContent).toContain('sungrow · battery')
    expect(dialog.textContent).not.toContain('easee')
    expect(dialog.querySelector('details')?.open).toBe(true)
    lost=true
    for(let i=0;i<150;i++){box.tick(20);await vi.advanceTimersByTimeAsync(20)}
    expect(dialog.textContent).toContain('Alarm · Measured control lost')
    dialog.dispatchEvent(new Event('cancel',{cancelable:true}))
    await vi.advanceTimersByTimeAsync(10)
    expect(document.querySelector('dialog')).toBeNull()
  } finally {
    cleanup(); site.destroy(); vi.useRealTimers(); vi.restoreAllMocks()
  }
})
