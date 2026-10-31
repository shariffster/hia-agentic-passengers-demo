import {createGateDemoController,DEMO_INPUTS} from './gate-agent-demo.js';
import {SYNTHETIC_SPATIAL} from './synthetic-graph.js';
import {mountGateDemoPanel} from './gate-demo-panel.js';

const $=id=>document.getElementById(id), svgNS='http://www.w3.org/2000/svg';
let controller=createGateDemoController(SYNTHETIC_SPATIAL),playing=false,focused=null,lastTime=performance.now(),frameId=0,finishing=false;
const groups=new Map();
const time=t=>`${Math.floor(t/60)}:${String(Math.floor(t%60)).padStart(2,'0')}`;
const label=s=>String(s??'').replaceAll('_',' ');
function refresh(){
  const state=controller.gateDemoState();
  $('scene-mode').textContent=state.mode==='baseline'?'Baseline · existing automatic policy':state.policy==='mock'?'Agent · deterministic demo policy':state.providerStatus==='live_response_received'?'Agent · live response received':state.providerStatus==='fallback'?'Agent · deterministic fallback recorded':'Agent · live requested, unverified';
  $('scene-time').textContent='T+'+time(state.time);
  $('left-gate-title').textContent=state.announced?'ORIGINAL GATE':'GATE 1';
  $('right-gate-title').textContent=state.announced?'NEW GATE':'GATE 2';
  const arrived=state.passengers.filter(p=>p.arrivedAt!==null).length;
  $('outcome-count').textContent=`${arrived} / 3 at new gate`;
  $('scene-message').textContent=state.pendingCount?`${state.pendingCount} decisions pending. The simulation clock is held.`:state.time>=DEMO_INPUTS.departureAt?`Outcome: ${state.passengers.filter(p=>p.outcome==='synthetic_departed').length} of 3 synthetic departures. Inspect the other arm at the same achieved time.`:state.announced?'Gate change published. Markers show achieved engine positions; read-board and wait actions take simulation time.':'Ready. Run the gate change, or press Play to reach its scheduled announcement.';
  state.passengers.forEach((p,i)=>{
    let group=groups.get(p.id);
    if(!group){
      group=document.createElementNS(svgNS,'g');group.classList.add('passenger-group');group.setAttribute('tabindex','0');group.setAttribute('role','button');group.setAttribute('aria-label',`Inspect ${p.name}`);
      const ring=document.createElementNS(svgNS,'circle');ring.setAttribute('r','13');ring.setAttribute('class','person-ring');ring.setAttribute('fill',p.color);group.appendChild(ring);
      const initial=document.createElementNS(svgNS,'text');initial.setAttribute('text-anchor','middle');initial.setAttribute('y','4');initial.setAttribute('fill','#fff');initial.setAttribute('font-size','11');initial.setAttribute('font-weight','600');initial.textContent=p.name[0];group.appendChild(initial);
      const name=document.createElementNS(svgNS,'text');name.setAttribute('class','passenger-name');name.setAttribute('x','0');name.setAttribute('y','-20');name.setAttribute('text-anchor','middle');name.textContent=p.name;group.appendChild(name);
      const title=document.createElementNS(svgNS,'title');group.appendChild(title);
      group.addEventListener('click',()=>{focused=p.id;refresh();});group.addEventListener('keydown',e=>{if(e.key==='Enter'||e.key===' '){e.preventDefault();focused=p.id;refresh();}});
      $('passenger-markers').appendChild(group);groups.set(p.id,group);
    }
    const metres=Math.max(0,Math.min(120,p.position?.[0]??120));group.setAttribute('transform',`translate(${100+metres/120*620} ${130+i*50})`);group.classList.toggle('is-focused',focused===p.id);group.querySelector('title').textContent=`${p.name}: ${label(p.state)}; ${metres.toFixed(1)} m along the corridor.`;
    group.setAttribute('opacity',p.outcome==='synthetic_departed'?'.6':'1');
  });
  $('play-pause').textContent=playing?'Pause':'Play';
  $('finish-run').disabled=finishing||state.time>=DEMO_INPUTS.departureAt;
  if(state.time>=DEMO_INPUTS.departureAt){playing=false;$('play-pause').textContent='Play';}
}
const panel=mountGateDemoPanel({
  async start(options){controller.dispose();controller=createGateDemoController(SYNTHETIC_SPATIAL,options);playing=false;focused=null;refresh();},
  getController:()=>controller,focus:id=>{focused=id;refresh();},
  setRepresentation:()=>refresh(),frame:()=>{focused=null;refresh();},refresh,
});
$('play-pause').addEventListener('click',()=>{playing=!playing;lastTime=performance.now();refresh();});
$('finish-run').addEventListener('click',async()=>{
  if(finishing)return;finishing=true;playing=false;const active=controller;refresh();
  try{for(let n=0;n<300&&controller===active&&active.getTime()<DEMO_INPUTS.departureAt;n++){active.step(Math.min(10,DEMO_INPUTS.departureAt-active.getTime()));await active.resolveDecisions();refresh();await new Promise(resolve=>setTimeout(resolve,0));}}
  finally{finishing=false;refresh();panel.render();}
});
function tick(now){const dt=Math.min(.15,Math.max(0,(now-lastTime)/1000));lastTime=now;if(playing&&!finishing){controller.step(Math.min(dt*Number($('play-speed').value),Math.max(0,DEMO_INPUTS.departureAt-controller.getTime())));refresh();}frameId=requestAnimationFrame(tick);}
refresh();frameId=requestAnimationFrame(tick);
addEventListener('pagehide',()=>{cancelAnimationFrame(frameId);controller.dispose();panel.dispose();},{once:true});
// Bounded inspection surface for reproducible local verification; no credentials or arbitrary execution API.
window.__PASSENGER_DEMO={getState:()=>controller.gateDemoState(),getSnapshot:()=>controller.snapshot(),refresh};
