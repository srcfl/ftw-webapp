import { test } from 'vitest';
import assert from 'node:assert/strict';
import { feedbackValues, feedbackSite } from './control-feedback.mjs';

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
