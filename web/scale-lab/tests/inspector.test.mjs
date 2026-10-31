import test from 'node:test';
import assert from 'node:assert/strict';
import {createScaleController} from '../scale-controller.js';
import {createScaleWorkerHandler} from '../worker-handler.js';

test('any of 1500 IDs exposes a profile, policy, observed state and timestamped action results',()=>{
  const c=createScaleController();c.advanceTo(63);
  for(let i=1;i<=1500;i++){
    const s=c.inspectPassenger(`DEMO-${i}`);
    assert.equal(s.passengerId,`DEMO-${i}`);assert.equal(s.profile.id,s.passengerId);assert.equal(s.controllerType,'adaptive_rule');assert.equal(s.modelDriven,false);assert.equal(s.background,false);
    assert.equal(s.observedAt,63);assert.equal(s.observedState.time,63);assert.equal(s.lastAction.type,'go_to_announced_gate');assert.ok(s.lastDecision.at<=63);
    assert.ok(s.observedState.position[0]>0&&s.observedState.position[0]<120);
  }
  const inspected=c.inspectPassenger('DEMO-1499');assert.equal(inspected.lastDecision.at,16);assert.equal(inspected.lastResult.action,'read_board');assert.equal(inspected.lastResult.at,16);
  inspected.profile.traits.familiarity=1;assert.equal(c.inspectPassenger('DEMO-1499').profile.traits.familiarity,.2);
  c.advanceTo(241);const done=c.exportPassenger('DEMO-1500');assert.equal(done.timestamps.arrivedAt,128);assert.equal(done.outcome.at,241);assert.equal(done.lastResult.action,'go_to_announced_gate');
  assert.throws(()=>c.inspectPassenger('missing'),/Unknown passenger/);
});

test('inspector excludes unannounced gate information and explicitly distinguishes automatic baseline',()=>{
  const c=createScaleController({count:3,mode:'baseline'});c.advanceTo(11);
  const s=c.inspectPassenger('DEMO-1');assert.equal(s.observedState.flight.publishedGateNodeId,'a_0');assert.equal(s.lastDecision,null);assert.equal(s.controllerType,'automatic_baseline');assert.equal(s.modelDriven,false);assert.equal(s.background,false);
  c.advanceTo(13);assert.equal(c.inspectPassenger('DEMO-1').lastDecision.source,'baseline');
});

test('worker inspector uses stable selected ID and rejects old-run requests',()=>{
  const handle=createScaleWorkerHandler(),run=handle({type:'start',requestId:'start',options:{count:1500}});
  handle({type:'advance',requestId:'advance',runId:run.runId,time:63});
  const s=handle({type:'inspect',requestId:'selection-1500',runId:run.runId,passengerId:'DEMO-1500'});
  assert.equal(s.ok,true);assert.equal(s.inspector.selectedPassengerId,'DEMO-1500');assert.equal(s.inspector.observedAt,63);
  assert.equal(handle({type:'inspect',requestId:'stale',runId:'old',passengerId:'DEMO-1500'}).ok,false);
});
