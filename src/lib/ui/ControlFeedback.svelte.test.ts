// @vitest-environment jsdom
import {render,screen,cleanup} from '@testing-library/svelte'
import {afterEach,expect,it} from 'vitest'
import ControlFeedback from './ControlFeedback.svelte'
afterEach(cleanup)
it('shows device limits even while charging and keeps proof levels distinct',()=>{
 render(ControlFeedback,{value:[{driver:'Garage',kind:'ev',reason:'device_limit',severity:'warning',verification_tier:0,device_limit_a:8,requested_a:16,actual_w:5500,site_confirmation:'device_response_unconfirmed'}]})
 expect(screen.getByText('Charger limit',{selector:'h3'})).toBeTruthy()
 expect(screen.getByText('8.0 A')).toBeTruthy()
 expect(screen.getByText(/Tier 0/)).toBeTruthy()
 expect(screen.queryByText(/Tier 2/)).toBeNull()
})
it('withdraws independent confirmation when status is stale',()=>{
 render(ControlFeedback,{live:false,value:[{driver:'Battery',kind:'battery',reason:'power_observed',verification_tier:2,actual_w:1000}]})
 expect(screen.queryByText(/Tier 2/)).toBeNull()
 expect(screen.getByText('Current effect unknown')).toBeTruthy()
 expect(screen.queryByText('1.0 kW charge')).toBeNull()
})
it('renders device reasons as text',()=>{
 render(ControlFeedback,{value:[{driver:'<script>bad</script>',reason:'device_fault',device_reason:'<img onerror=bad>'}]})
 expect(document.querySelector('script')).toBeNull()
 expect(document.querySelector('img')).toBeNull()
 expect(screen.getByText('Device reports: <img onerror=bad>')).toBeTruthy()
})
it('shows the measured comparison curve and removes it when status expires',async()=>{
 const value=[{driver:'Battery',reason:'power_observed',verification_tier:2,site_evidence:{samples:3,window_s:10,unexplained_change_w:10,trace:[0,1,2].map(i=>({at_ms:1000+i*5000,device_change_w:i*500,adjusted_site_change_w:i*500+10}))}}]
 const view=render(ControlFeedback,{value})
 expect(screen.getByRole('img',{name:/Measured changes over 10 seconds/})).toBeTruthy()
 expect(screen.getByText('Unexplained change')).toBeTruthy()
 await view.rerender({value,live:false})
 expect(screen.queryByRole('img')).toBeNull()
 expect(screen.queryByText(/Tier 2/)).toBeNull()
})
