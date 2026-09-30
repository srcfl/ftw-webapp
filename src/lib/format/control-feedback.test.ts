import { test } from 'vitest';
import assert from 'node:assert/strict';
import { feedbackStatus, feedbackValues, feedbackSite } from './control-feedback.mjs';

test('comparison time gaps use milliseconds and require measured evidence',()=>{
 const gap=(e: {samples:number;max_skew_ms:number|null})=>feedbackValues({driver:'hybrid',reason:'power_observed',site_evidence:e}).find(v=>v[0]==='Largest time gap');
 assert.equal(gap({samples:0,max_skew_ms:0}),undefined);
 assert.equal(gap({samples:3,max_skew_ms:null}),undefined);
 assert.deepEqual(gap({samples:3,max_skew_ms:0}),['Largest time gap','0 ms']);
 assert.deepEqual(gap({samples:3,max_skew_ms:37}),['Largest time gap','37 ms']);
 assert.deepEqual(gap({samples:3,max_skew_ms:1250}),['Largest time gap','1250 ms']);
});

test('a missing measurement names the source holding back site confirmation',()=>{
 const row={driver:'hybrid',reason:'power_observed',site_confirmation:'measurement_sources_unclear',site_source_issue:'missing_fresh_power:easee:ev'};
 assert.match(feedbackSite(row),/Fresh power readings from easee \(ev\) are missing/);
 assert.doesNotMatch(feedbackSite(row,false),/Fresh power readings/);
});

test('each device has its own status and unknown background is not a veto',()=>{
 const row={driver:'battery',reason:'power_observed',verification_tier:2,site_confirmation:'confirmed',site_evidence:{unmeasured_flows:['offline-ev:ev']}};
 assert.equal(feedbackStatus(row).tone,'confirmed');
 assert.match(feedbackSite(row),/separate site meter/);
 assert.deepEqual(feedbackValues(row).find(v=>v[0]==='Background, not required sources'),['Background, not required sources','offline-ev:ev']);
 assert.equal(feedbackStatus({driver:'ev',reason:'waiting_response',verification_tier:0}).tone,'waiting');
 assert.equal(feedbackStatus({driver:'ev',reason:'telemetry_stale',verification_tier:0,verification_lost:true}).tone,'alarm');
 assert.equal(feedbackStatus(row,false).tone,'unknown');
});

test('embedded on-box evidence preserves the open disclosure and focus across updates',async()=>{
 const {renderFeedback}=await import('./control-feedback.mjs');
 const root=document.createElement('section');document.body.append(root);
 const row={driver:'battery',kind:'battery',reason:'power_observed',verification_tier:2};
 try {
  renderFeedback(root,[row],true,{embedded:true});
  const disclosure=root.querySelector('details')!;
  const summary=disclosure.querySelector('summary')!;
  assert.equal(disclosure.open,false);
  assert.match(summary.textContent!,/Are we in control\?/);
  disclosure.open=true;summary.tabIndex=0;summary.focus();
  renderFeedback(root,[{...row,reason:'telemetry_stale',verification_lost:true,verification_tier:0}],true,{embedded:true});
  assert.equal(root.querySelector('details'),disclosure);
  assert.equal(disclosure.open,true);
  assert.equal(document.activeElement,summary);
  assert.match(summary.textContent!,/Alarm/);
  renderFeedback(root,[row],false,{embedded:true});
  assert.match(summary.textContent!,/No live proof/);
 } finally {root.remove()}
});
