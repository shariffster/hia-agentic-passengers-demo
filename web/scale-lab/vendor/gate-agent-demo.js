import {RecoveryWorldSimulation} from './recovery-world.js';

const copy=x=>structuredClone(x);
export const DEMO_INPUTS=Object.freeze({seed:42,walkingSpeedMps:1.2,oldGate:'a_0',newGate:'a_1',changeAt:11,announcementAt:13,departureAt:241});
export const DEFAULT_PROFILES=Object.freeze([
 {id:'DEMO-1',name:'Alex',color:'#12b8a6',traits:{consequenceSensitivity:.95,safetyMarginSeconds:120,familiarity:.9},needs:{fatigue:.15}},
 {id:'DEMO-2',name:'Sam',color:'#e8a13d',traits:{consequenceSensitivity:.8,safetyMarginSeconds:90,familiarity:.2},needs:{fatigue:.25}},
 {id:'DEMO-3',name:'Jo',color:'#a78bfa',traits:{consequenceSensitivity:.35,safetyMarginSeconds:30,familiarity:.7},needs:{fatigue:.5}}
]);
export function normalizeProfiles(profiles=DEFAULT_PROFILES){
 if(!Array.isArray(profiles)||profiles.length!==3)throw Error('Exactly three profiles required');
 return DEFAULT_PROFILES.map((base,i)=>{const p=profiles[i],t=p?.traits??base.traits,n=p?.needs??base.needs;
  for(const [k,min,max] of [['consequenceSensitivity',0,1],['safetyMarginSeconds',0,180],['familiarity',0,1]])if(!Number.isFinite(t[k])||t[k]<min||t[k]>max)throw Error('Invalid profile '+k);
  if(!Number.isFinite(n.fatigue)||n.fatigue<0||n.fatigue>1)throw Error('Invalid fatigue');
  return {...copy(base),traits:copy(t),needs:copy(n)};
 });
}
export function validateAction(raw,observation){
 const a=raw?.action??raw;
 if(!a||typeof a!=='object'||Array.isArray(a))return {ok:false,reason:'Action must be an object'};
 if(Object.keys(a).some(k=>!['type','seconds'].includes(k)))return {ok:false,reason:'Unknown action field'};
 if(!observation.allowedActions.includes(a.type))return {ok:false,reason:'Action unavailable in current state'};
 if(a.type==='wait'){
  if(!Number.isInteger(a.seconds)||a.seconds<1||a.seconds>30)return {ok:false,reason:'Wait must be 1–30 whole seconds'};
  if(a.seconds>observation.constraints.maxWaitSeconds)return {ok:false,reason:'Wait exceeds remaining decision window'};
 }else if(a.seconds!==undefined)return {ok:false,reason:'Only wait accepts seconds'};
 return {ok:true,action:{type:a.type,...(a.type==='wait'?{seconds:a.seconds}:{})}};
}
export function mockDecision(o){
 // Authored deterministic demonstration rules, never presented as live inference.
 if(o.allowedActions.includes('read_board')&&o.traits.familiarity<.4&&o.knowledge.boardReads===0)
  return {action:{type:'read_board'},summary:'Low familiarity: verify the published board before moving.',source:'mock'};
 if(o.allowedActions.includes('wait')&&o.traits.consequenceSensitivity<.5&&o.knowledge.waits===0&&o.routeEstimate.seconds+o.traits.safetyMarginSeconds+15<o.flight.secondsToDeparture)
  return {action:{type:'wait',seconds:15},summary:'The estimated walk still leaves the preferred margin; take a short pause.',source:'mock'};
 return {action:{type:'go_to_announced_gate'},summary:'Move to the published gate using the existing route.',source:'mock'};
}

class GateAgentSimulation extends RecoveryWorldSimulation {
 constructor(spatial,profiles,mode){
  const g=copy(spatial.graph??spatial);g.services=[{id:'demo_desk',nodeId:DEMO_INPUTS.oldGate,counters:3,staff:3,enabled:true,label:'Synthetic setup desk'}];
  const city={schemaVersion:'1',version:'gate-demo-no-city',anchors:[{id:'hia_pickup',mapXY:[0,0]}],sites:[],routes:[],transportDefaults:{fleetVehicles:0,vehiclePassengerCapacity:0,boardingSecondsAssumed:0,alightingSecondsAssumed:0}};
  const flight=(id,gate,destination,departure)=>({id,displayNumber:id==='demo-flight'?'SIM 301':'SIM 302',destination,departureSeconds:departure,seatCapacity:3,gateNodeId:gate,gateResourceId:'resource-'+gate,crewId:'crew-'+id,aircraftId:'aircraft-'+id,crewAvailableFromSeconds:0,crewAvailableUntilSeconds:20000,aircraftOnsiteFromSeconds:0,flightDurationSeconds:600,rampSeconds:5,cateringSeconds:5});
  super(g,city,{seed:DEMO_INPUTS.seed,staff:3,serviceMeanSeconds:.1,walkingSpeedMps:DEMO_INPUTS.walkingSpeedMps,story:{id:'three-selected-gate-change',version:'1',waves:[],disruptions:[]},flights:[flight('demo-flight',DEMO_INPUTS.oldGate,'destination_a',DEMO_INPUTS.departureAt),flight('alternate-gate-resource',DEMO_INPUTS.newGate,'destination_b',1200)],hotelPolicy:'desk_only',hotelEligibilityFraction:0,minimumReservationLeadSeconds:1,flightAnnouncementDelaySeconds:2,flightPreparationLeadSeconds:60,rampStaff:1,cateringStaff:1,gateOccupancySeconds:10,simulationEpochISO:'2026-10-31T09:00:00Z'});
  this.demoMode=mode;this.demoLog=[];this.demoSequence=0;this.demoPending=new Map();this.demoAnnouncementHandled=false;this.demoProfiles=profiles;this.demoAnnounced=false;
  for(const profile of profiles){this.addCase({id:profile.id,destination:'destination_a',originNodeId:DEMO_INPUTS.oldGate,hasPhone:true,profile:{walkingSpeedMps:DEMO_INPUTS.walkingSpeedMps,assistanceSeconds:.1},appearance:{paletteIndex:profiles.indexOf(profile)}});const p=this.cases.get(profile.id);p.demo={profile:copy(profile),knowledge:{publishedGate:DEMO_INPUTS.oldGate,revision:0,boardReads:0,waits:0,confidence:profile.traits.familiarity},decisionCount:0,actionVersion:0,arrivedAt:null,lastAction:null};}
  super.step(1);this.events.push(DEMO_INPUTS.changeAt,'demo_gate_change',{},0);
  this.demoRecord(null,'run_ready','Same seed, speeds, profiles and published information in both arms.');
 }
 demoRecord(passengerId,type,detail,extra={}){this.demoLog.push({sequence:++this.demoSequence,time:this.time,passengerId,type,detail,...copy(extra)});}
 requestDecision(p,reason){if(this.demoPending.has(p.id)||p.modeledDepartureAt!==null)return;p.demo.actionVersion++;this.demoPending.set(p.id,{version:p.demo.actionVersion,reason});this.demoRecord(p.id,'observation',reason);}
 _handleExternalEvent(event){
  if(event.type==='demo_gate_change'){super.disruptCase('DEMO-1',{id:'single-gate-change',type:'gate_change'});return;}
  if(event.type==='demo_wait_complete'){
   const p=this.cases.get(event.data.id);if(!p||p.demo.actionVersion!==event.data.version)return;
   if(event.data.kind==='read_board'){p.demo.knowledge.confidence=.98;p.demo.knowledge.lastSource='published_board';}this._transition(p,'awaiting_recovery');this.demoRecord(p.id,'completed',event.data.kind==='read_board'?'Published board checked; location unchanged.':'Bounded wait completed; location unchanged.',{action:event.data.kind});
   this.requestDecision(p,'Action result received; choose the next permitted action.');return;
  }
  if(event.type==='world_gate_announcement'&&event.data.flightId==='demo-flight'){
   if(this.demoAnnouncementHandled){this.demoRecord(null,'duplicate_ignored','Repeated gate announcement ignored.');return;}
   this.demoAnnouncementHandled=true;this.demoAnnounced=true;const d=event.data,f=this.flights.get(d.flightId);
   for(const p of this.cases.values()){p.demo.knowledge.publishedGate=d.gateNodeId;p.demo.knowledge.lastSource='gate_announcement';p.demo.knowledge.revision++;this.demoRecord(p.id,'announcement','Published gate changed from a_0 to a_1.');}
   if(this.demoMode==='baseline'){
    super._handleExternalEvent(event);
    for(const p of this.cases.values()){p.demo.lastAction='go_to_announced_gate';this.demoRecord(p.id,'accepted','Existing automatic reroute policy.',{action:'go_to_announced_gate',source:'baseline'});}return;
   }
   f.publishedGateNodeId=d.gateNodeId;this.flightAnnouncements.push({time:this.time,observedAt:d.observedAt,flightId:f.id,direction:'departure',status:'gate_changed',gateNodeId:d.gateNodeId});
   for(const p of this.cases.values()){this._disruptionsObserved++;p.disruptions.push({id:d.changeId,type:'gate_change',time:this.time});p.gateNodeId=d.gateNodeId;this._log('gate_change',{caseId:p.id,disruptionId:d.changeId});this.requestDecision(p,'Gate-change announcement received.');}
   return;
  }
  return super._handleExternalEvent(event);
 }
 _walkComplete(p,token){const target=p?.route?.target,valid=p?.routeToken===token&&!!p.route;super._walkComplete(p,token);
  if(valid&&p?.demo&&this.demoAnnounced&&target===p.demo.knowledge.publishedGate&&p.currentNodeId===target&&!p.route){p.demo.arrivedAt=this.time;this.demoRecord(p.id,'completed','Reached the published gate through engine movement.',{action:'go_to_announced_gate'});}
 }
 observe(id){const p=this.cases.get(id),d=p.demo,f=this.flights.get(p.flightId),route=this._routeTo(p,d.knowledge.publishedGate),remaining=(f.announcedEstimatedDepartureSeconds??f.departureSeconds)-this.time;
  const maxWaitSeconds=Math.max(0,Math.min(30,Math.floor(remaining-(route?.durationSeconds??Infinity)-1)));
  const allowedActions=route?['go_to_announced_gate']:[];
  if(d.decisionCount<5&&d.knowledge.boardReads<2)allowedActions.push('read_board');
  if(d.decisionCount<5&&d.knowledge.waits<2&&maxWaitSeconds>=1)allowedActions.push('wait');
  return {passengerId:id,time:this.time,position:this.positionFor(p),currentActivity:p.state,traits:copy(d.profile.traits),needs:{fatigue:Math.min(1,d.profile.needs.fatigue+this.time/7200)},knowledge:copy(d.knowledge),constraints:{walkingSpeedMps:p.profile.walkingSpeedMps,stepFreeRequired:p.profile.stepFreeRequired,maxWaitSeconds,synthetic:true},flight:{id:f.id,publishedGateNodeId:f.publishedGateNodeId,publishedStatus:f.announcedStatus,scheduledDepartureSeconds:f.departureSeconds,secondsToDeparture:remaining},routeEstimate:route?{seconds:route.durationSeconds,metres:route.distanceMeters}:null,allowedActions,previousResults:this.demoLog.filter(e=>e.passengerId===id&&['completed','rejected'].includes(e.type)).slice(-3)};
 }
 applyDecision(id,version,raw,source){const p=this.cases.get(id),pending=this.demoPending.get(id);if(!p||!pending||pending.version!==version)return {ok:false,reason:'Stale decision'};
  const o=this.observe(id),validation=validateAction(raw,o);if(!validation.ok){this.demoRecord(id,'rejected',validation.reason,{source});return validation;}
  const a=validation.action;this.demoPending.delete(id);p.demo.decisionCount++;p.demo.lastAction=a.type;
  const summary=typeof raw.summary==='string'?raw.summary.slice(0,180):'';
  this.demoRecord(id,'accepted',summary||'Validated bounded action.',{action:a.type,seconds:a.seconds,source,observation:o});
  if(a.type==='go_to_announced_gate'){const route=this._routeTo(p,p.demo.knowledge.publishedGate);if(!route){this.demoRecord(id,'failed','No route available.');this.requestDecision(p,'Route failed.');return {ok:false,reason:'No route'};}this._walk(p,route,'walking_to_gate');}
  else{if(a.type==='read_board'){p.demo.knowledge.boardReads++;}else p.demo.knowledge.waits++;
   this._transition(p,'demo_waiting');this.events.push(this.time+(a.type==='read_board'?3:a.seconds),'demo_wait_complete',{id,version,kind:a.type},2);
  }
  this.spatialPresentation.sync(this);return {ok:true,action:a};
 }
}

let runSequence=0;
export function createGateDemoController(spatial,{mode='agent',policy='mock',profiles=DEFAULT_PROFILES,decide,timeoutMs=8500}={}){
 if(!['baseline','agent'].includes(mode)||!['mock','live'].includes(policy))throw Error('Unknown demo mode');
 profiles=normalizeProfiles(profiles);const engine=new GateAgentSimulation(spatial,profiles,mode),runId=`gate-run-${++runSequence}`,abort=new AbortController();let disposed=false,inflight=null,providerStatus=policy==='mock'?'deterministic_mock':'unverified',lastError=null;
 const parameters={gateAgentDemo:true,accommodation:{enabled:false},hotelPolicy:'desk_only',story:{id:'gate-demo',version:'1'},seed:42,mode,policy};
 const defaultDecide=async request=>{const response=await fetch('/api/agent/decide',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(request),signal:abort.signal});if(!response.ok)throw Error(response.status===503?'Model endpoint is not configured.':response.status===504?'Model request timed out.':'Model endpoint rejected the request.');return response.json();};
 async function resolveDecisions(){
  if(disposed||inflight||!engine.demoPending.size)return inflight;
  const entries=[...engine.demoPending];
  const task=Promise.all(entries.map(async([id,pending])=>{const observation=engine.observe(id),request={requestId:`${runId}:${id}:${pending.version}`,runId,passengerId:id,observation,allowedActions:observation.allowedActions};let response,source=policy,timer;
   try{response=policy==='mock'?mockDecision(observation):await Promise.race([(decide??defaultDecide)(request),new Promise((_,reject)=>{timer=setTimeout(()=>reject(Error('Model request timed out.')),timeoutMs);})]);
    if(disposed)return;if(policy==='live'&&providerStatus!=='fallback')providerStatus='live_response_received';
    if(response?.runId!==undefined&&(response.runId!==runId||response.passengerId!==id||response.requestId!==request.requestId))throw Error('Mismatched model response identity.');
    const result=engine.applyDecision(id,pending.version,response,source);if(!result.ok)throw Error(result.reason);
   }catch(error){if(disposed)return;lastError=String(error.message??'Decision failed').slice(0,160);if(policy==='live')providerStatus='fallback';engine.demoRecord(id,'fallback',lastError+' Deterministic go-to-gate fallback used.',{source:'fallback'});engine.applyDecision(id,pending.version,{action:{type:'go_to_announced_gate'},summary:'Fallback: proceed to the published gate.'},'fallback');}
   finally{clearTimeout(timer);}
  }));inflight=task;try{await task;}finally{if(inflight===task)inflight=null;}
 }
 const controller={
  step(seconds=1){if(disposed)return controller.snapshot();if(!Number.isFinite(seconds)||seconds<0)throw Error('Invalid step');let left=Math.min(seconds,1200-engine.time);while(left>1e-8&&!engine.demoPending.size){const dt=Math.min(left,1);engine.step(dt,{includeCases:false,includeAgents:false,includeEncounters:false});left-=dt;}if(engine.demoPending.size)void resolveDecisions();return controller.snapshot();},
  getTime:()=>engine.time,snapshot:options=>({...engine.snapshot(options),scenario:'gate-agent-demo',gateAgentDemo:true}),getParameters:()=>copy(parameters),history:()=>[],insights:()=>({observations:[],recommendations:[]}),
  announce(){if(!engine.demoAnnounced)controller.step(Math.max(0,DEMO_INPUTS.announcementAt-engine.time));return controller.gateDemoState();},resolveDecisions,
  gateDemoState(){const s=engine.snapshot();return {runId,mode,policy,providerStatus,lastError,pendingCount:engine.demoPending.size,time:engine.time,announced:engine.demoAnnounced,...copy(DEMO_INPUTS),profiles:copy(profiles),comparisonInputs:{...copy(DEMO_INPUTS),profiles:copy(profiles)},passengers:s.cases.map(p=>{const d=engine.cases.get(p.id).demo;return {id:p.id,name:d.profile.name,color:d.profile.color,state:p.state,position:p.position,gateNodeId:p.gateNodeId,arrivedAt:d.arrivedAt,decisionCount:d.decisionCount,lastAction:d.lastAction,outcome:p.modeledTravelOutcome,knowledge:copy(d.knowledge),needs:{fatigue:Math.min(1,d.profile.needs.fatigue+engine.time/7200)},constraints:{walkingSpeedMps:DEMO_INPUTS.walkingSpeedMps,stepFreeRequired:p.profile.stepFreeRequired},routeNodeIds:p.routeNodeIds};}),log:copy(engine.demoLog),invariants:engine.assertInvariants()};},
  exportDemo:()=>({schema:'hia.gate-agent-demo/1',createdAt:new Date().toISOString(),synthetic:true,calibrated:false,notice:'Authored illustrative profiles. Reconstructed semantic gates. Declared summaries are not evidence of internal model reasoning.',...controller.gateDemoState()}),
  assertInvariants:()=>engine.assertInvariants(),dispose(){disposed=true;abort.abort();},
  // Deliberately bounded diagnostics for CPU regression, not arbitrary model tools.
  reviewRepeatAnnouncement(){engine._handleExternalEvent({type:'world_gate_announcement',data:{flightId:'demo-flight',gateNodeId:DEMO_INPUTS.newGate,changeId:'single-gate-change',observedAt:DEMO_INPUTS.changeAt}});},
 };
 return controller;
}
