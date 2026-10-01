import {test,expect,vi} from 'vitest'
import {render,cleanup} from '@testing-library/svelte'
import Now from './Now.svelte'
import {SiteStore} from '$lib/state/site.svelte'
import {LoopbackCarrier} from '$lib/carrier/loopback'
import {SimBox} from '$lib/sim/box'

test('opens the device panel with the answer first and keeps an open receipt through an alarm',async()=>{
  vi.useFakeTimers()
  vi.setSystemTime(new Date(2026,6,15,12))
  const box=new SimBox({now:()=>Date.now()})
  const site=new SiteStore('proof-test')
  const api=site.api.bind(site)
  let lost=false
  vi.spyOn(site,'api').mockImplementation(req=>{
    if(req.path!=='/api/status') return api(req)
    const status={grid_w:1000,load_w:500,drivers:{sungrow:{status:'ok',bat_w:1000}},control_feedback:[
      lost
        ? {driver:'sungrow',kind:'battery',mode:'planner_arbitrage',status:'no_contact',reason:'readings_lost',severity:'alarm',evidence:'accepted',readings_fresh:false,actual_w:null}
        : {driver:'sungrow',kind:'battery',mode:'planner_arbitrage',status:'following',reason:'power_observed',severity:'info',evidence:'confirmed',readings_fresh:true,actual_w:1000,confirmed_at_ms:Date.now()},
      {driver:'easee',kind:'ev',status:'no_contact',reason:'readings_lost',severity:'alarm',evidence:'accepted',readings_fresh:false,actual_w:null},
    ]}
    return Promise.resolve({status:200,headers:{},body:new TextEncoder().encode(JSON.stringify(status))})
  })
  try {
    site.connect(new LoopbackCarrier(box,{latencyMs:0}))
    const view=render(Now,{props:{site}})
    for(let i=0;i<200;i++){box.tick(20);await vi.advanceTimersByTimeAsync(20)}
    expect(view.queryByText('Are we in control?')).toBeNull()
    const flow=document.querySelector('ftw-energy-flow')!
    const button=flow.shadowRoot!.querySelector('.ef-layer[aria-hidden="false"] [data-role="battery"]')!
    expect(button.getAttribute('aria-label')).not.toMatch(/tier/i)
    button.dispatchEvent(new MouseEvent('click',{bubbles:true}))
    await vi.advanceTimersByTimeAsync(10)
    const dialog=document.querySelector('[role="dialog"]')!
    expect(dialog.textContent).toContain('Following FTW')
    expect(dialog.textContent).toContain('Charging 1.0 kW as planned.')
    expect(dialog.textContent).not.toContain('easee')
    expect(dialog.getAttribute('aria-label')).toBe('Battery')
    const evidence=dialog.querySelector('details')!
    expect(evidence.open).toBe(false)
    evidence.open=true
    lost=true
    for(let i=0;i<150;i++){box.tick(20);await vi.advanceTimersByTimeAsync(20)}
    expect(dialog.textContent).toContain('Lost control')
    expect(evidence.open).toBe(true)
    window.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape'}))
    await vi.advanceTimersByTimeAsync(10)
    expect(document.querySelector('[role="dialog"]')).toBeNull()
  } finally {
    cleanup(); site.destroy(); vi.useRealTimers(); vi.restoreAllMocks()
  }
})

test('an EV tap goes straight to charging controls even when status carries evidence',async()=>{
 vi.useFakeTimers();vi.setSystemTime(new Date(Date.UTC(2026,6,15,18,30)));
 const box=new SimBox({now:()=>Date.now()});const site=new SiteStore('ev-proof-test');
 const api=site.api.bind(site);
 vi.spyOn(site,'api').mockImplementation(req=>req.path==='/api/status' ? Promise.resolve({status:200,headers:{},body:new TextEncoder().encode(JSON.stringify({drivers:{easee:{status:'ok',ev_w:7200}},control_feedback:[{driver:'easee',kind:'ev',status:'following',reason:'power_observed',severity:'info',evidence:'measured',readings_fresh:true,actual_w:7200}]}))}) : api(req));
 try {
  site.connect(new LoopbackCarrier(box,{latencyMs:0}));render(Now,{props:{site}});
  for(let i=0;i<200;i++){box.tick(20);await vi.advanceTimersByTimeAsync(20)}
  document.querySelector('ftw-energy-flow')!.dispatchEvent(new CustomEvent('ftw-planet-click',{detail:{role:'ev',name:'easee'},bubbles:true}));
  for(let i=0;i<200;i++){box.tick(20);await vi.advanceTimersByTimeAsync(20)}
  const dialog=document.querySelector('[role="dialog"]')!;
  expect(dialog?.getAttribute('aria-label')).toBe('EV charger');
  expect(dialog.textContent).toContain('Charge now');
  expect(document.querySelectorAll('[role="dialog"]')).toHaveLength(1);
 } finally {cleanup();site.destroy();vi.useRealTimers();vi.restoreAllMocks()}
});
