import test from 'node:test';
import assert from 'node:assert/strict';
import {createScaleController} from '../scale-controller.js';
import {aggregateMacroFrame} from '../macro-density.js';
import {createScaleWorkerHandler} from '../worker-handler.js';

test('macro aggregation conserves all cases and selected identities at every event boundary',()=>{
  const c=createScaleController();
  for(const t of [1,11,13,16,28,63,113,116,128,241]){
    c.advanceTo(t);const frame=c.frame(),density=aggregateMacroFrame(frame);
    assert.equal(density.time,t);assert.equal(density.cells.reduce((s,x)=>s+x.count,0),1500);
    assert.deepEqual(density.cells.flatMap(x=>x.selectedIds).sort(),['DEMO-1','DEMO-2','DEMO-3']);
    assert.deepEqual(density.selected,frame.selected);assert.equal(density.policyCounts.liveLLM,0);
  }
});

test('worker protocol reset rejects stale commands and uses the same clock for macro/micro',()=>{
  const handle=createScaleWorkerHandler();
  const old=handle({type:'start',requestId:'first',options:{count:1500}});assert.equal(old.ok,true);
  const current=handle({type:'start',requestId:'second',options:{count:1500}});assert.equal(current.ok,true);assert.notEqual(old.runId,current.runId);
  assert.equal(handle({type:'advance',requestId:'stale',runId:old.runId,time:100}).ok,false);
  const moved=handle({type:'advance',requestId:'advance',runId:current.runId,time:63,densityOnly:true});
  assert.equal(moved.ok,true);assert.equal(moved.frame.time,63);assert.equal(moved.frame.population,1500);assert.equal(moved.frame.selected.length,3);
  assert.equal(handle({type:'start',requestId:'invalid',options:{count:1501}}).ok,false);
  const kept=handle({type:'frame',requestId:'retained',runId:current.runId});assert.equal(kept.ok,true);assert.equal(kept.frame.time,63);
  assert.equal(handle({type:'dispose',requestId:'dispose',runId:current.runId}).ok,true);
  assert.equal(handle({type:'frame',requestId:'after',runId:current.runId}).ok,false);
});
