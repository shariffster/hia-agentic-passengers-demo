import test from 'node:test';
import assert from 'node:assert/strict';
import {createMockTrace,runComparison,validateTrace,traceFromExport} from '../scenario.mjs';
import {buildBundle} from '../bundle.mjs';
import {executeDaytona} from '../transport.mjs';
import {fileURLToPath} from 'node:url';
const root=fileURLToPath(new URL('..',import.meta.url));
test('same engine replay preserves arrivals and deterministic complete results',async()=>{
 const trace=await createMockTrace(),first=await runComparison(trace),second=await runComparison(trace);
 assert.deepEqual(first,second);
 assert.deepEqual(first.comparison.map(p=>p.baselineArrivalSeconds),[113,113,113]);
 assert.deepEqual(first.comparison.map(p=>p.agentArrivalSeconds),[113,116,128]);
 assert.equal(first.inferenceExecuted,false);
 assert.equal(first.traceProvenance,'authored_mock');
 assert.equal(first.agent.invariants,true);
});
test('trace cannot silently fall back, skip actions, alter timing, carry extra data or change graph',async()=>{
 const trace=await createMockTrace();
 for(const change of [
  t=>{t.actions.pop();},t=>{t.actions[0].time++;},
  t=>{t.actions[0].action={type:'execute_code'};},
  t=>{t.actions[0].secret='not permitted';},
  t=>{t.graphId='private-airport';},
  t=>{t.profiles[0].name='Real Person';},
  t=>{t.actions.push(structuredClone(t.actions[0]));}
 ]){
  const bad=structuredClone(trace);change(bad);await assert.rejects(()=>runComparison(bad));
 }
});
test('bundle is explicit allowlist, engine hashes pinned and has no credential/server files',async()=>{
 const bundle=await buildBundle(root,await createMockTrace());
 assert.equal(bundle.files.length,10);
 assert.equal(bundle.files.some(f=>/runtime|server|credential|node_modules|\.env/.test(f.path)),false);
 assert.equal(bundle.manifest.length,10);
});
async function fixture(failAt){
 const trace=await createMockTrace(),expected=await runComparison(trace),bundle=await buildBundle(root,trace),calls=[];
 const fail=stage=>{calls.push(stage);if(failAt===stage)throw Error('SECRET_MUST_NEVER_LEAK');};
 const sandbox={id:'test-sandbox',cpu:1,memory:1,disk:3,fs:{createFolder:async()=>fail('folder'),uploadFiles:async()=>fail('upload'),downloadFile:async()=>{fail('download');return Buffer.from(JSON.stringify(expected));}},process:{executeCommand:async()=>{fail('execute');return {exitCode:0};}}};
 const client={create:async p=>{assert.equal(p.networkBlockAll,true);assert.equal(p.ttlMinutes,5);fail('create');return sandbox;},get:async()=>{calls.push('get');return sandbox;},delete:async(_s,_timeout,wait)=>{assert.equal(wait,true);fail('delete');}};
 return {client,bundle,expected,calls};
}
test('Daytona lifecycle only claims live after matching remote result AND confirmed deletion',async()=>{
 const f=await fixture();const result=await executeDaytona(f);
 assert.equal(result.execution.status,'live_verified');
 assert.equal(result.execution.cleanup,'deleted');
 assert.deepEqual(f.calls,['create','folder','upload','execute','download','delete']);
});
test('upload, process, download and uncertain creation failures all attempt cleanup without leaking errors',async()=>{
 for(const stage of ['create','upload','execute','download']){
  const f=await fixture(stage),result=await executeDaytona(f);
  assert.equal(result.execution.status,'failed');
  assert.equal(result.execution.cleanup,'deleted');
  assert.equal(JSON.stringify(result).includes('SECRET_MUST_NEVER_LEAK'),false);
  assert.equal(f.calls.at(-1),'delete');
 }
});
test('cleanup failure never becomes live_verified; insufficient or excessive cap cannot create',async()=>{
 const f=await fixture('delete'),result=await executeDaytona(f);
 assert.equal(result.execution.status,'execution_verified');
 assert.equal(result.execution.cleanup,'delete_unconfirmed');
 for(const cap of [0.001,51,NaN]){
  const f=await fixture();await assert.rejects(()=>executeDaytona({...f,creditCapUsd:cap}));assert.deepEqual(f.calls,[]);
 }
});

test('remote mismatch never verifies and still deletes sandbox',async()=>{
 const f=await fixture();f.expected={tampered:true};const result=await executeDaytona(f);
 assert.equal(result.execution.status,'failed');assert.equal(result.execution.resultMatchesLocal,false);assert.equal(result.execution.cleanup,'deleted');
});

test('mixed recorded actions preserve live and fallback sources without another model call',async()=>{
 const trace=await createMockTrace();trace.provenance='recorded_mixed';trace.actions=trace.profiles.map((p,i)=>({passengerId:p.id,time:13,action:{type:'go_to_announced_gate'},source:i===1?'fallback':'live'}));
 const result=await runComparison(trace);
 assert.deepEqual(result.sourceCounts,{live:2,fallback:1,mock:0});assert.equal(result.externalModelCalls,0);
 assert.deepEqual(result.recordedActions.map(a=>a.source),['live','fallback','live']);
 assert.deepEqual(result.comparison.map(p=>p.arrivalDeltaSeconds),[0,0,0]);
 const bad=structuredClone(trace);delete bad.actions[1].source;assert.throws(()=>validateTrace(bad));
});
