import test from 'node:test';
import assert from 'node:assert/strict';
import {createScaleController,createProfiles} from '../scale-controller.js';
import {createGateDemoController,validateAction} from '../vendor/gate-agent-demo.js';
import {SYNTHETIC_SPATIAL} from '../vendor/synthetic-graph.js';

test('three-case scale fork matches the retained original controller in both arms',async()=>{
  for(const mode of ['baseline','agent']){
    const scale=createScaleController({count:3,mode});
    const original=createGateDemoController(SYNTHETIC_SPATIAL,{mode});
    for(const target of [11,13,16,28,63,113,116,128,241]){
      scale.advanceTo(target);
      while(original.getTime()<target){original.step(target-original.getTime());await original.resolveDecisions();}
      for(const [i,p] of scale.passengers().entries()){
        const q=original.gateDemoState().passengers[i];
        for(const key of ['id','state','position','arrivedAt','decisionCount','lastAction','knowledge'])assert.deepEqual(p[key],q[key],`${mode} ${target} ${p.id} ${key}`);
      }
    }
    assert.ok(scale.assertInvariants());original.dispose();scale.dispose();
  }
});

test('1500 paired cases share exact inputs and initial state; every accepted rule action validates',()=>{
  const a=createScaleController({count:1500,mode:'baseline'}),b=createScaleController({count:1500});
  assert.deepEqual(a.comparisonInputs(),b.comparisonInputs());
  assert.deepEqual(a.snapshot(),b.snapshot());
  for(const target of [11,13,16,28,63,128,241]){a.advanceTo(target);b.advanceTo(target);assert.ok(a.assertInvariants());assert.ok(b.assertInvariants());}
  assert.equal(new Set(b.passengers().map(p=>p.id)).size,1500);
  assert.equal(a.snapshot({includeCases:false}).metrics.modeledDepartures,1500);
  assert.equal(b.snapshot({includeCases:false}).metrics.modeledDepartures,1500);
  assert.ok(a.passengers().every(p=>p.arrivedAt===113));
  assert.deepEqual(b.passengers().reduce((r,p)=>(r[p.arrivedAt]=(r[p.arrivedAt]??0)+1,r),{}),{113:500,116:500,128:500});
  const accepted=b.log().filter(e=>e.type==='accepted');
  assert.equal(accepted.length,2500);
  assert.equal(b.log().filter(e=>e.type==='rejected').length,0);
  assert.equal(b.passengers().reduce((sum,p)=>sum+p.decisionCount,0),2500);
  for(const e of accepted){const action={type:e.action,...(e.action==='wait'?{seconds:e.seconds}:{})};assert.ok(validateAction(action,e.observation).ok);assert.equal(e.source,'deterministic_rule');}
  assert.deepEqual(b.frame().policyCounts,{liveLLM:0,deterministicRule:1500,automaticReroute:0});
});

test('same seed reproduces all 1500 outcomes and logs regardless of step partition',()=>{
  const a=createScaleController(),b=createScaleController();
  a.advanceTo(241);
  for(let target=1.5;target<241;target+=7.25)b.advanceTo(target);
  b.advanceTo(241);
  assert.deepEqual(a.exportRun(),b.exportRun());
});

test('one profile edit changes that case without leaking mutable state into 1499 others',()=>{
  const base=createProfiles(),edited=structuredClone(base);edited[0].traits.familiarity=.1;
  const a=createScaleController({profiles:base}),b=createScaleController({profiles:edited});
  base[0].traits.familiarity=0;
  a.advanceTo(128);b.advanceTo(128);
  assert.equal(a.passengers()[0].arrivedAt,113);assert.equal(b.passengers()[0].arrivedAt,116);
  assert.deepEqual(a.passengers().slice(1),b.passengers().slice(1));
  const external=b.passengers();external[1].knowledge.publishedGate='tampered';
  assert.equal(b.passengers()[1].knowledge.publishedGate,'a_1');
});

test('published observations, shared clock and route positions remain truthful',()=>{
  const c=createScaleController();c.advanceTo(11);
  assert.equal(c.observe('DEMO-1').knowledge.publishedGate,'a_0');
  assert.equal(c.log().filter(e=>e.type==='accepted').length,0);
  c.advanceTo(13);assert.ok(c.passengers().every(p=>p.position[0]===0));
  c.advanceTo(63);const f=c.frame();assert.equal(f.time,c.getTime());
  assert.equal(f.points.length,1500);assert.equal(f.selected.length,3);
  assert.equal(f.points.filter(p=>p.selected).length,3);
  assert.ok(f.points.every(p=>p.position[0]>0&&p.position[0]<120));
  for(const selected of f.selected)assert.deepEqual(selected.position,f.points.find(p=>p.id===selected.id).position);
  for(const e of c.log().filter(e=>e.observation)){
    assert.equal(e.observation.knowledge.publishedGate,'a_1');
    for(const forbidden of ['operationalStatus','futureEvents','crewCurrentlyAvailable','rampReady'])assert.equal(JSON.stringify(e.observation).includes('"'+forbidden+'"'),false);
  }
});

test('disposed, malformed and out-of-bound requests cannot advance a run',()=>{
  for(const count of [0,2,1501,3.5,NaN])assert.throws(()=>createScaleController({count}));
  const c=createScaleController({count:3});
  for(const time of [0,NaN,Infinity,1201])assert.throws(()=>c.advanceTo(time));
  for(const dt of [-1,NaN,Infinity])assert.throws(()=>c.step(dt));
  c.dispose();assert.throws(()=>c.advanceTo(10),/Disposed/);assert.equal(c.getTime(),1);
});
