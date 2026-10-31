// Isolated adaptation of the retained three-passenger controller. See ENGINE-MANIFEST and README.
import {RecoveryWorldSimulation} from './vendor/recovery-world.js';
import {DEMO_INPUTS,validateAction} from './vendor/gate-agent-demo.js';
const copy=x=>structuredClone(x);
class ScaleSimulation extends RecoveryWorldSimulation {
 constructor(spatial,profiles,mode){
  const g=copy(spatial.graph??spatial);g.services=[{id:'demo_desk',nodeId:DEMO_INPUTS.oldGate,counters:profiles.length,staff:profiles.length,enabled:true,label:'Synthetic setup desk'}];
  const city={schemaVersion:'1',version:'gate-demo-no-city',anchors:[{id:'hia_pickup',mapXY:[0,0]}],sites:[],routes:[],transportDefaults:{fleetVehicles:0,vehiclePassengerCapacity:0,boardingSecondsAssumed:0,alightingSecondsAssumed:0}};
  const flight=(id,gate,destination,departure)=>({id,displayNumber:id==='demo-flight'?'SIM 301':'SIM 302',destination,departureSeconds:departure,seatCapacity:profiles.length,gateNodeId:gate,gateResourceId:'resource-'+gate,crewId:'crew-'+id,aircraftId:'aircraft-'+id,crewAvailableFromSeconds:0,crewAvailableUntilSeconds:20000,aircraftOnsiteFromSeconds:0,flightDurationSeconds:600,rampSeconds:5,cateringSeconds:5});
  super(g,city,{seed:DEMO_INPUTS.seed,staff:profiles.length,serviceMeanSeconds:.1,walkingSpeedMps:DEMO_INPUTS.walkingSpeedMps,story:{id:'synthetic-scale-gate-change',version:'1',waves:[],disruptions:[]},flights:[flight('demo-flight',DEMO_INPUTS.oldGate,'destination_a',DEMO_INPUTS.departureAt),flight('alternate-gate-resource',DEMO_INPUTS.newGate,'destination_b',1200)],hotelPolicy:'desk_only',hotelEligibilityFraction:0,minimumReservationLeadSeconds:1,flightAnnouncementDelaySeconds:2,flightPreparationLeadSeconds:60,rampStaff:1,cateringStaff:1,gateOccupancySeconds:10,simulationEpochISO:'2026-10-31T09:00:00Z'});
  this.demoMode=mode;this.demoLog=[];this.demoSequence=0;this.demoPending=new Map();this.demoAnnouncementHandled=false;this.demoProfiles=profiles;this.demoAnnounced=false;this.recentResults=new Map();
  for(const profile of profiles){this.addCase({id:profile.id,destination:'destination_a',originNodeId:DEMO_INPUTS.oldGate,hasPhone:true,profile:{walkingSpeedMps:DEMO_INPUTS.walkingSpeedMps,assistanceSeconds:.1},appearance:{paletteIndex:profiles.indexOf(profile)}});const p=this.cases.get(profile.id);p.demo={profile:copy(profile),knowledge:{publishedGate:DEMO_INPUTS.oldGate,revision:0,boardReads:0,waits:0,confidence:profile.traits.familiarity},decisionCount:0,actionVersion:0,arrivedAt:null,lastAction:null};}
  super.step(1);this.events.push(DEMO_INPUTS.changeAt,'demo_gate_change',{},0);
  this.demoRecord(null,'run_ready','Same seed, speeds, profiles and published information in both arms.');
 }
 demoRecord(passengerId,type,detail,extra={}){this.demoLog.push({sequence:++this.demoSequence,time:this.time,passengerId,type,detail,...copy(extra)});if(passengerId&&['completed','rejected'].includes(type)){const recent=this.recentResults.get(passengerId)??[];recent.push(this.demoLog.at(-1));this.recentResults.set(passengerId,recent.slice(-3));}}
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
  return {passengerId:id,time:this.time,position:this.positionFor(p),currentActivity:p.state,traits:copy(d.profile.traits),needs:{fatigue:Math.min(1,d.profile.needs.fatigue+this.time/7200)},knowledge:copy(d.knowledge),constraints:{walkingSpeedMps:p.profile.walkingSpeedMps,stepFreeRequired:p.profile.stepFreeRequired,maxWaitSeconds,synthetic:true},flight:{id:f.id,publishedGateNodeId:f.publishedGateNodeId,publishedStatus:f.announcedStatus,scheduledDepartureSeconds:f.departureSeconds,secondsToDeparture:remaining},routeEstimate:route?{seconds:route.durationSeconds,metres:route.distanceMeters}:null,allowedActions,previousResults:copy(this.recentResults.get(id)??[])};
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

export {ScaleSimulation};
