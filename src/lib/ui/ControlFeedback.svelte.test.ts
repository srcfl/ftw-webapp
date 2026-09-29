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
