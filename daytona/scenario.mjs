import {createGateDemoController, DEFAULT_PROFILES, DEMO_INPUTS, normalizeProfiles, validateAction} from './vendor/gate-agent-demo.js';
import {SYNTHETIC_SPATIAL} from './vendor/synthetic-graph.js';
import {createHash} from 'node:crypto';
import {isDeepStrictEqual} from 'node:util';

export const GRAPH_ID = 'synthetic-corridor-120m-v1';
export const hash = value => createHash('sha256').update(typeof value === 'string' ? value : JSON.stringify(value)).digest('hex');
const fail = message => { throw Error(message); };
const exact = (object, keys) => object && typeof object === 'object' && !Array.isArray(object) && Object.keys(object).every(k => keys.includes(k));
export function validateTrace(input) {
  if (!exact(input,['schema','graphId','provenance','profiles','inputs','horizonSeconds','actions']) || input.schema !== 'hia.daytona.replay/1' || input.graphId !== GRAPH_ID) fail('Invalid replay schema or synthetic graph');
  if (!['authored_mock','recorded_live','recorded_fallback','recorded_mixed'].includes(input.provenance)) fail('Invalid trace provenance');
  if (!isDeepStrictEqual(input.inputs, DEMO_INPUTS)) fail('Scenario inputs differ from pinned engine');
  if (!Array.isArray(input.profiles) || input.profiles.some(p => !exact(p,['id','name','color','traits','needs']) || !exact(p.traits,['consequenceSensitivity','safetyMarginSeconds','familiarity']) || !exact(p.needs,['fatigue']))) fail('Unexpected profile fields');
  const profiles = normalizeProfiles(input.profiles);
  if (!isDeepStrictEqual(profiles,input.profiles)) fail('Use the three canonical synthetic identities');
  if (!Number.isInteger(input.horizonSeconds) || input.horizonSeconds < 200 || input.horizonSeconds > 600) fail('Horizon must be 200–600 seconds');
  if (!Array.isArray(input.actions) || input.actions.length > 30 || input.actions.length < 3) fail('Invalid action count');
  const actions = input.actions.map(a => {
    if (!exact(a,['passengerId','time','action','source']) || !profiles.some(p => p.id === a.passengerId) || !Number.isFinite(a.time) || a.time < 13 || a.time > input.horizonSeconds) fail('Invalid replay entry');
    const result = validateAction(a.action,{allowedActions:['go_to_announced_gate','read_board','wait'],constraints:{maxWaitSeconds:30}});
    if (!result.ok) fail('Invalid recorded action');
    const source=a.source??(input.provenance==='authored_mock'?'mock':input.provenance==='recorded_live'?'live':input.provenance==='recorded_fallback'?'fallback':null);
    if(!['mock','live','fallback'].includes(source))fail('Every mixed-trace action needs a source');
    return {passengerId:a.passengerId,time:a.time,action:result.action,source};
  });
  return {schema:input.schema,graphId:GRAPH_ID,provenance:input.provenance,profiles,inputs:structuredClone(DEMO_INPUTS),horizonSeconds:input.horizonSeconds,actions};
}
async function advance(controller, horizon) {
  for (let i=0; i<1000 && controller.getTime()<horizon; i++) {
    controller.step(Math.min(1,horizon-controller.getTime()));
    await controller.resolveDecisions();
    if (controller.assertInvariants() !== true) fail('Engine invariant failed');
  }
  if (controller.getTime() !== horizon) fail('Scenario did not reach horizon');
}
function selectState(controller, policy) {
  const state = controller.gateDemoState();
  return {
    policy, time:state.time, invariants:state.invariants,
    passengers: state.passengers.map(p => ({id:p.id,arrivedAt:p.arrivedAt,state:p.state,outcome:p.outcome,position:p.position,decisionCount:p.decisionCount,lastAction:p.lastAction})),
    log:state.log.map(e => ({sequence:e.sequence,time:e.time,passengerId:e.passengerId,type:e.type,detail:e.type==='accepted'?'Bounded engine action':e.detail,...(e.action?{action:e.action}:{}),...(e.seconds!==undefined?{seconds:e.seconds}:{})}))
  };
}
export async function createMockTrace() {
  const c = createGateDemoController(SYNTHETIC_SPATIAL,{mode:'agent',policy:'mock'});
  try {
    await advance(c,260);
    const state = c.gateDemoState();
    return validateTrace({schema:'hia.daytona.replay/1',graphId:GRAPH_ID,provenance:'authored_mock',profiles:state.profiles,inputs:DEMO_INPUTS,horizonSeconds:260,
      actions:state.log.filter(e=>e.type==='accepted').map(e=>({passengerId:e.passengerId,time:e.time,source:e.source,action:{type:e.action,...(e.seconds!==undefined?{seconds:e.seconds}:{})}}))});
  } finally { c.dispose(); }
}
export async function runComparison(input) {
  const trace = validateTrace(input);
  const consumed = new Set(), replayErrors=[];
  const baseline = createGateDemoController(SYNTHETIC_SPATIAL,{mode:'baseline',profiles:trace.profiles});
  const agent = createGateDemoController(SYNTHETIC_SPATIAL,{mode:'agent',policy:'live',profiles:trace.profiles,decide:async request=>{
    const idx=trace.actions.findIndex((a,i)=>!consumed.has(i)&&a.passengerId===request.passengerId&&a.time===request.observation.time);
    if(idx<0){replayErrors.push('Missing or out-of-time action');throw Error('Missing replay action');}
    consumed.add(idx);
    return {requestId:request.requestId,runId:request.runId,passengerId:request.passengerId,action:trace.actions[idx].action,summary:'Recorded action replay; no inference in this run.'};
  }});
  try {
    await advance(baseline,trace.horizonSeconds); await advance(agent,trace.horizonSeconds);
    if(replayErrors.length || consumed.size!==trace.actions.length || agent.gateDemoState().log.some(e=>['fallback','rejected'].includes(e.type))) fail('Replay mismatch: missing, extra, unavailable or out-of-time actions');
    const b=selectState(baseline,'existing_baseline'), a=selectState(agent,'recorded_action_replay');
    return {schema:'hia.daytona.comparison/1',synthetic:true,calibrated:false,graphId:GRAPH_ID,traceHash:hash(trace),traceProvenance:trace.provenance,
      inferenceExecuted:false,externalModelCalls:0,operation:'recorded_action_replay',recordedActions:trace.actions,sourceCounts:Object.fromEntries(['live','fallback','mock'].map(source=>[source,trace.actions.filter(a=>a.source===source).length])),inputs:trace.inputs,profiles:trace.profiles,baseline:b,agent:a,
      comparison:b.passengers.map((p,i)=>({passengerId:p.id,baselineArrivalSeconds:p.arrivedAt,agentArrivalSeconds:a.passengers[i].arrivedAt,arrivalDeltaSeconds:p.arrivedAt===null||a.passengers[i].arrivedAt===null?null:a.passengers[i].arrivedAt-p.arrivedAt})),
      note:'Same engine, graph, seed, walking speed, profiles and published information. Positive delta means replay arrived later. No claim of agent superiority.'};
  } finally { baseline.dispose(); agent.dispose(); }
}
export function traceFromExport(exported) {
  if(exported?.schema!=='hia.gate-agent-demo/1'||exported.synthetic!==true||exported.mode!=='agent'||!Array.isArray(exported.log)) fail('Expected synthetic agent export');
  if(exported.pendingCount!==0)fail('Export still has pending decisions');
  const accepted=exported.log.filter(e=>e.type==='accepted');
  // Verify route compatibility, then discard all original geometry/positions/observations.
  const first=accepted.filter(e=>e.time===DEMO_INPUTS.announcementAt);
  if(first.length!==3||first.some(e=>e.observation?.routeEstimate?.metres!==120||e.observation?.routeEstimate?.seconds!==100)) fail('Export actions need an initial route compatible with the 120m/100s synthetic corridor');
  const sources=new Set(accepted.map(e=>e.source));
  const provenance=sources.size>1?'recorded_mixed':sources.has('live')?'recorded_live':sources.has('fallback')?'recorded_fallback':'authored_mock';
  return validateTrace({schema:'hia.daytona.replay/1',graphId:GRAPH_ID,provenance,profiles:exported.profiles,inputs:Object.fromEntries(Object.keys(DEMO_INPUTS).map(k=>[k,exported.comparisonInputs[k]])),horizonSeconds:260,
    actions:accepted.map(e=>({passengerId:e.passengerId,time:e.time,source:e.source,action:{type:e.action,...(e.seconds!==undefined?{seconds:e.seconds}:{})}}))});
}
