import {ScaleSimulation} from './scale-engine.js';
import {DEFAULT_PROFILES,DEMO_INPUTS,mockDecision} from './vendor/gate-agent-demo.js';
import {SYNTHETIC_SPATIAL} from './vendor/synthetic-graph.js';

export const SCALE_NOTICE = 'Synthetic CPU scale experiment: independent stateful cases on an invented 120 m corridor, 500 copies of three authored profile types at N=1500. Deterministic rules; zero live LLM agents. Scaled synthetic seat/setup capacity is a load-test device, not an actual flight schedule. No crowd collisions, empirical psychology, congestion or rendered-FPS claim.';
const copy=x=>structuredClone(x);
export function createProfiles(count=1500){
  if(!Number.isInteger(count)||count<3||count>1500)throw Error('Count must be an integer from 3 to 1500');
  return Array.from({length:count},(_,i)=>({...copy(DEFAULT_PROFILES[i%3]),id:`DEMO-${i+1}`,name:i<3?DEFAULT_PROFILES[i].name:`Synthetic ${i+1}`,profileType:DEFAULT_PROFILES[i%3].name}));
}

/** No fetch or model adapter exists in this controller. A browser can consume snapshot()
 * for the existing engine schema, or frame() for bounded macro/micro presentation.
 * The same engine time owns both. Do not overlay this run on a separate live clock. */
export function createScaleController({count=1500,mode='agent',spatial=SYNTHETIC_SPATIAL,profiles=createProfiles(count)}={}){
  if(!Number.isInteger(count)||count<3||count>1500)throw Error('Count must be an integer from 3 to 1500');
  if(!['agent','baseline'].includes(mode))throw Error('Unknown mode');
  if(profiles.length!==count||new Set(profiles.map(p=>p.id)).size!==count||profiles[0]?.id!=='DEMO-1')throw Error('Invalid population identities');
  for(const p of profiles){
    if(typeof p.id!=='string'||p.id.length>128)throw Error('Invalid identity');
    for(const [k,max] of [['consequenceSensitivity',1],['familiarity',1],['safetyMarginSeconds',180]])if(!Number.isFinite(p.traits?.[k])||p.traits[k]<0||p.traits[k]>max)throw Error('Invalid trait');
    if(!Number.isFinite(p.needs?.fatigue)||p.needs.fatigue<0||p.needs.fatigue>1)throw Error('Invalid need');
  }
  const engine=new ScaleSimulation(copy(spatial),copy(profiles),mode);
  const initialInputs={...copy(DEMO_INPUTS),profiles:copy(profiles),graph:copy(spatial.graph??spatial),capacity:count,events:[{at:11,type:'gate_change'},{at:13,type:'published_announcement'},{at:241,type:'synthetic_departure'}]};
  let disposed=false;
  function resolveDecisions(){
    if(disposed)return;
    for(const [id,pending] of [...engine.demoPending]){
      const reply=mockDecision(engine.observe(id));
      const result=engine.applyDecision(id,pending.version,reply,'deterministic_rule');
      if(!result.ok)throw Error(`Deterministic action rejected: ${result.reason}`);
    }
  }
  function advanceTo(target){
    if(disposed)throw Error('Disposed run');
    if(!Number.isFinite(target)||target<engine.time||target>1200)throw Error('Invalid target time');
    resolveDecisions();
    while(engine.time<target-1e-8){
      const eventTime=engine.events.peek()?.time??Infinity;
      const dt=Math.min(target-engine.time,Math.max(0,eventTime-engine.time));
      engine.step(dt,{includeCases:false,includeAgents:false,includeEncounters:false});
      resolveDecisions();
    }
    return engine.time;
  }
  function passenger(p){return {id:p.id,profileType:p.demo.profile.profileType??p.demo.profile.name,state:p.state,position:engine.positionFor(p),gateNodeId:p.gateNodeId,arrivedAt:p.demo.arrivedAt,decisionCount:p.demo.decisionCount,lastAction:p.demo.lastAction,outcome:p.modeledDepartureAt===null?'not_departed':'synthetic_departed',knowledge:copy(p.demo.knowledge),routeNodeIds:p.route?.nodeIds??[]};}
  function passengers(){return [...engine.cases.values()].map(passenger);}
  function inspectPassenger(id){
    const p=engine.cases.get(id);if(!p)throw Error('Unknown passenger');
    const d=p.demo,f=engine.flights.get(p.flightId);
    const latest=engine.demoLog.findLast(e=>e.passengerId===id&&e.type==='accepted');
    const result=(engine.recentResults.get(id)??[]).at(-1);
    return {schema:'hia.scale.passenger-inspector/1',passengerId:id,selectedPassengerId:id,
      controllerType:mode==='agent'?'adaptive_rule':'automatic_baseline',
      policyLabel:mode==='agent'?'Deterministic authored rules':'Automatic reroute baseline',
      modelDriven:false,background:false,liveModel:null,readOnly:true,
      profile:copy(d.profile),observedAt:engine.time,
      observedState:{time:engine.time,currentActivity:p.state,position:engine.positionFor(p),knowledge:copy(d.knowledge),
        needs:{fatigue:Math.min(1,d.profile.needs.fatigue+engine.time/7200)},
        constraints:{walkingSpeedMps:p.profile.walkingSpeedMps,stepFreeRequired:p.profile.stepFreeRequired,synthetic:true},
        flight:f?{id:f.id,publishedGateNodeId:f.publishedGateNodeId,publishedStatus:f.announcedStatus,scheduledDepartureSeconds:f.departureSeconds}:null},
      decisionCount:d.decisionCount,
      lastDecision:latest?{at:latest.time,sequence:latest.sequence,source:latest.source,action:{type:latest.action,...(latest.seconds===undefined?{}:{seconds:latest.seconds})},summary:latest.detail}:null,
      lastAction:latest?{type:latest.action,...(latest.seconds===undefined?{}:{seconds:latest.seconds}),acceptedAt:latest.time}:null,
      lastResult:result?{at:result.time,sequence:result.sequence,type:result.type,action:result.action??null,detail:result.detail}:null,
      timestamps:{createdAt:p.createdAt,observedAt:engine.time,lastDecisionAt:latest?.time??null,lastResultAt:result?.time??null,arrivedAt:d.arrivedAt,modeledDepartureAt:p.modeledDepartureAt},
      outcome:{type:p.modeledDepartureAt===null?'not_departed':'synthetic_departed',at:p.modeledDepartureAt},
      notice:'Authored illustrative profile; current observed information and declared rule summary, not measured psychology or hidden model reasoning. Times are seconds on this run clock.'};
  }
  function frame(){
    const points=[],counts={};
    for(const p of engine.cases.values()){
      counts[p.state]=(counts[p.state]??0)+1;
      points.push({id:p.id,position:engine.positionFor(p),state:p.state,policy:mode==='baseline'?'automatic_reroute':'deterministic_rule',selected:['DEMO-1','DEMO-2','DEMO-3'].includes(p.id)});
    }
    return {schema:'hia.scale.frame/1',time:engine.time,population:count,counts,policyCounts:{liveLLM:0,deterministicRule:mode==='agent'?count:0,automaticReroute:mode==='baseline'?count:0},points,selected:[...engine.cases.values()].slice(0,3).map(passenger),rendered:false,notice:SCALE_NOTICE};
  }
  return {
    getTime:()=>engine.time,advanceTo,step:seconds=>{if(!Number.isFinite(seconds)||seconds<0)throw Error('Invalid seconds');advanceTo(engine.time+seconds);return frame();},
    announce:()=>advanceTo(Math.max(engine.time,DEMO_INPUTS.announcementAt)),resolveDecisions,
    snapshot:options=>engine.snapshot(options),frame,passengers,inspectPassenger,exportPassenger:inspectPassenger,
    comparisonInputs:()=>copy(initialInputs),log:()=>copy(engine.demoLog),
    observe:id=>{if(!engine.cases.has(id))throw Error('Unknown passenger');return engine.observe(id);},
    assertInvariants:()=>{engine.assertInvariants();if(engine.cases.size!==count)throw Error('Population changed');return true;},
    dispose:()=>{disposed=true;},
    exportRun:()=>({schema:'hia.scale.run/1',synthetic:true,calibrated:false,rendered:false,liveCalls:0,notice:SCALE_NOTICE,mode,inputs:copy(initialInputs),time:engine.time,passengers:passengers(),log:copy(engine.demoLog)}),
  };
}
