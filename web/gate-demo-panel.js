const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const finite = value => typeof value === 'number' && Number.isFinite(value);
const clock = value => finite(value) ? `${Math.floor(value / 60)}:${String(Math.floor(value % 60)).padStart(2, '0')}` : '—';
const words = value => String(value ?? 'unknown').replaceAll('_', ' ');
const short = value => (typeof value === 'string' ? value : value == null ? '' : JSON.stringify(value)).slice(0, 240);
const color = value => /^#[a-f\d]{3,8}$/i.test(value ?? '') ? value : '#672f43';
const clone = value => structuredClone(value);
const gateLabel = value => ({a_0:'Gate 1 · old',a_1:'Gate 2 · new'}[value] ?? value ?? 'unknown');

/** A read-only inspector between explicit user controls. It never ticks the engine. */
export function mountGateDemoPanel({start, getController, focus, setRepresentation, frame, refresh} = {}) {
  document.getElementById('gate-demo-panel')?.remove();
  if (!document.querySelector('link[data-gate-demo-style]')) {
    const link = document.createElement('link');
    link.rel = 'stylesheet'; link.href = new URL('./gate-demo-panel.css', import.meta.url).href;
    link.dataset.gateDemoStyle = ''; document.head.appendChild(link);
  }
  const root = document.createElement('aside');
  root.id = 'gate-demo-panel'; root.className = 'gate-demo-panel';
  root.setAttribute('aria-label', 'Gate change experiment');
  root.innerHTML = `
    <header class="gd-header"><div><span class="gd-eyebrow">Passenger decision experiment</span><h2>One change. Three choices.</h2></div><button class="gd-collapse" type="button" aria-expanded="true" aria-controls="gd-body" title="Collapse experiment">−</button></header>
    <div id="gd-body" class="gd-body">
      <p class="gd-intro">A gate changes. Watch three passengers act on the same announcement.</p>
      <div class="gd-tabs" role="group" aria-label="Controller"><button type="button" data-mode="baseline" aria-pressed="false">Baseline</button><button type="button" data-mode="agent" aria-pressed="true">Agent</button></div>
      <div class="gd-policy-row"><label for="gd-policy">Decision source</label><select id="gd-policy"><option value="mock">Deterministic demo policy</option><option value="live" disabled>Live model · not configured</option></select></div>
      <div class="gd-status" role="status"><span class="gd-status-dot"></span><span id="gd-source-status">Deterministic demo policy · no model call</span><button id="gd-check" type="button" title="Check endpoint configuration">↻</button></div>
      <div class="gd-scenario"><div><span>Published gate</span><strong id="gd-gate">Before announcement</strong></div><div><span>Simulation time</span><strong id="gd-clock">0:00</strong></div></div>
      <p id="gd-clock-note" class="gd-clock-note">The same seed, profiles and event are used in both arms.</p>
      <div class="gd-actions"><button id="gd-announce" class="gd-primary" type="button">Run gate change</button><button id="gd-restart" type="button">Restart</button></div>
      <div class="gd-small-actions"><button id="gd-step10" type="button">+10 sec</button><button id="gd-step60" type="button">+60 sec</button><button id="gd-frame" type="button">Frame corridor</button><button id="gd-export" type="button">Export</button></div>
      <div class="gd-view-row"><span>View</span><button type="button" data-view="scene" aria-pressed="true">Schematic</button><button type="button" data-view="flow" aria-pressed="false">Flow</button><span id="gd-departure">Departure —</span></div>
      <p id="gd-error" class="gd-error" role="alert" hidden></p>
      <section class="gd-passengers" aria-label="Passenger inspectors"><div class="gd-section-title"><h3>Three authored profiles</h3><span>Inspect or focus</span></div><div id="gd-passenger-list"><p class="gd-empty">Start the experiment to inspect passengers.</p></div></section>
      <details class="gd-comparison"><summary>Baseline / agent comparison</summary><div id="gd-comparison-body"><p class="gd-empty">Run each arm to retain its achieved results here.</p></div></details>
      <section class="gd-log-section"><div class="gd-section-title"><h3>Decision &amp; action log</h3><span id="gd-log-count">0 events</span></div><p class="gd-log-help">Declared decision summaries and engine outcomes. These are not internal thought traces.</p><ol id="gd-log" class="gd-log"><li class="gd-empty">No gate-change decisions yet.</li></ol></section>
      <footer class="gd-footer">Illustrative profiles · synthetic scenario · synthetic gate nodes. This demonstrates a decision loop, not calibrated passenger behavior.</footer>
    </div>`;
  (document.getElementById('experience') ?? document.body).appendChild(root);
  const $ = selector => root.querySelector(selector);
  let mode = 'agent', policy = 'mock', busy = false, disposed = false, lastState = null, lastLogKey = '', lastRunId = '', lastProfileKey = '', endpoint = null, checkBusy = false;
  const retained = {baseline:null,agent:null};
  const cards = new Map();
  const error = message => { $('#gd-error').textContent = message ?? ''; $('#gd-error').hidden = !message; };
  const controller = () => getController?.() ?? null;
  const state = () => controller()?.gateDemoState?.() ?? null;
  const syncDisabled = () => {
    for (const el of root.querySelectorAll('button:not(.gd-collapse):not([data-view]):not(#gd-check),select')) el.disabled = busy;
    $('#gd-announce').disabled = busy || !!lastState?.announced;
    for (const id of ['#gd-step10','#gd-step60','#gd-export']) $(id).disabled = busy || !lastState;
    $('#gd-policy').disabled = busy || mode === 'baseline';
    $('#gd-policy option[value="live"]').disabled = endpoint?.configured !== true;
  };
  const readProfiles = () => {
    if (!lastState?.profiles?.length) return undefined;
    return lastState.profiles.map(p => {
      const next = clone(p), card = cards.get(p.id);
      if (!card) return next;
      next.traits = {...next.traits};
      for (const name of ['consequenceSensitivity','safetyMarginSeconds','familiarity']) {
        const input = card.querySelector(`[data-trait="${name}"]`), value = Number(input?.value);
        if (finite(value)) next.traits[name] = Math.min(name === 'safetyMarginSeconds' ? 180 : 1, Math.max(0, value));
      }
      return next;
    });
  };
  const remember = s => { if (s?.mode === 'baseline' || s?.mode === 'agent') retained[s.mode] = clone(s); };
  const task = async fn => {
    if (busy || disposed) return;
    busy = true; error(''); syncDisabled();
    try { await fn(); refresh?.(); render(); }
    catch (e) { error(e?.message || 'The action could not complete. The current run is retained.'); }
    finally { busy = false; syncDisabled(); }
  };
  const reset = async () => {
    remember(state());
    const profiles = readProfiles();
    await start?.({mode,policy, ...(profiles ? {profiles} : {})});
    lastRunId = ''; lastProfileKey = ''; lastLogKey = ''; render();
  };
  for (const button of root.querySelectorAll('[data-mode]')) button.addEventListener('click', () => task(async () => {
    mode = button.dataset.mode;
    for (const b of root.querySelectorAll('[data-mode]')) b.setAttribute('aria-pressed', String(b.dataset.mode === mode));
    await reset();
  }));
  $('#gd-policy').addEventListener('change', () => task(async () => { policy = $('#gd-policy').value; await reset(); }));
  $('#gd-restart').addEventListener('click', () => task(reset));
  $('#gd-announce').addEventListener('click', () => task(async () => {
    if (!controller()?.gateDemoState) await reset();
    await controller()?.announce?.();
  }));
  for (const [id,seconds] of [['#gd-step10',10],['#gd-step60',60]]) $(id).addEventListener('click', () => task(async () => { await controller()?.step?.(seconds); }));
  $('#gd-frame').addEventListener('click', () => { frame?.(); refresh?.(); });
  for (const button of root.querySelectorAll('[data-view]')) button.addEventListener('click', () => {
    setRepresentation?.(button.dataset.view);
    for (const b of root.querySelectorAll('[data-view]')) b.setAttribute('aria-pressed', String(b === button));
    refresh?.();
  });
  $('.gd-collapse').addEventListener('click', () => {
    const collapsed = root.classList.toggle('is-collapsed');
    $('#gd-body').hidden = collapsed; $('.gd-collapse').textContent = collapsed ? '+' : '−';
    $('.gd-collapse').setAttribute('aria-expanded', String(!collapsed));
    $('.gd-collapse').title = collapsed ? 'Expand experiment' : 'Collapse experiment';
  });
  $('#gd-export').addEventListener('click', () => task(async () => {
    remember(state());
    const payload = {schema:'hia-gate-demo-inspection/1',exportedAt:new Date().toISOString(),notice:'Synthetic authored profiles and synthetic gate nodes. Declared decision summaries are not internal thought traces.',run:controller()?.exportDemo?.() ?? state(),retainedComparison:retained};
    const url = URL.createObjectURL(new Blob([JSON.stringify(payload,null,2)], {type:'application/json'}));
    const a = document.createElement('a'); a.href = url; a.download = `hia-gate-demo-${mode}-${new Date().toISOString().replace(/[:.]/g,'-')}.json`; a.click(); setTimeout(() => URL.revokeObjectURL(url),1000);
  }));
  async function checkEndpoint() {
    if (checkBusy || disposed) return;
    checkBusy = true; $('#gd-check').disabled = true;
    try {
      const abort = new AbortController(), timer = setTimeout(() => abort.abort(),3500);
      try {
        const response = await fetch('/api/agent/status',{signal:abort.signal,cache:'no-store'});
        if (!response.ok) throw Error('Status unavailable');
        const value = await response.json(); endpoint = {configured:value.configured === true,status:value.status};
      } finally { clearTimeout(timer); }
    } catch { endpoint = {configured:false,status:'status_unavailable'}; }
    finally { checkBusy = false; $('#gd-check').disabled = false; }
    if (disposed) return;
    const option = $('#gd-policy option[value="live"]');
    option.textContent = endpoint.configured ? 'Live model · configured, unverified' : 'Live model · not configured';
    if (policy === 'live' && !endpoint.configured) error('The live endpoint is not configured or its status is unavailable. The engine will report any fallback explicitly.');
    render(); syncDisabled();
  }
  $('#gd-check').addEventListener('click', checkEndpoint);
  function makeCard(p, i) {
    const card = document.createElement('article'); card.className = 'gd-passenger'; card.dataset.passengerId = p.id;
    card.style.setProperty('--gd-person',color(p.color ?? ['#a13c52','#337f88','#a76d26'][i]));
    card.innerHTML = `<div class="gd-person-top"><span class="gd-person-dot"></span><strong class="gd-person-name"></strong><button class="gd-follow" type="button">Focus</button></div><div class="gd-person-state"></div><div class="gd-person-result"></div><details class="gd-person-details"><summary>Profile &amp; observation</summary><div class="gd-traits"><label>Missed-flight consequence <input data-trait="consequenceSensitivity" type="number" min="0" max="1" step="0.1"></label><label>Safety margin (seconds) <input data-trait="safetyMarginSeconds" type="number" min="0" max="180" step="15"></label><label>Airport familiarity <input data-trait="familiarity" type="number" min="0" max="1" step="0.1"></label></div><p class="gd-edit-note">Authored values; edits apply on Restart in either arm.</p><dl><dt>Current needs</dt><dd class="gd-needs"></dd><dt>Known gate</dt><dd class="gd-known-gate"></dd><dt>Info confidence</dt><dd class="gd-confidence"></dd><dt>Walking speed</dt><dd class="gd-speed"></dd><dt>Last action</dt><dd class="gd-last-action"></dd><dt>Decisions</dt><dd class="gd-decision-count"></dd></dl></details>`;
    card.querySelector('.gd-follow').addEventListener('click', () => { focus?.(p.id); refresh?.(); });
    cards.set(p.id,card); return card;
  }
  function renderComparison(s) {
    if (s) remember(s);
    const a = retained.baseline, b = retained.agent;
    if (!a && !b) return;
    const fingerprint = x => JSON.stringify({inputs:x?.comparisonInputs,profiles:x?.profiles?.map(p=>({id:p.id,traits:p.traits,needs:p.needs}))});
    const matched = !!a && !!b && fingerprint(a) === fingerprint(b);
    const metric = (x, kind) => {
      if (!x) return '—';
      const ps = x.passengers ?? [];
      if (kind === 'arrived') return ps.filter(p => finite(p.arrivedAt)).length + ' / ' + ps.length;
      if (kind === 'departed') return ps.filter(p => /departed/.test(p.outcome ?? p.state ?? '') && !/not_departed/.test(p.outcome ?? p.state ?? '')).length + ' / ' + ps.length;
      return clock(x.time);
    };
    $('#gd-comparison-body').innerHTML = `<table><thead><tr><th>Achieved result</th><th>Baseline</th><th>Agent</th></tr></thead><tbody><tr><th>Time</th><td>${metric(a,'time')}</td><td>${metric(b,'time')}</td></tr><tr><th>At new gate</th><td>${metric(a,'arrived')}</td><td>${metric(b,'arrived')}</td></tr><tr><th>Departed</th><td>${metric(a,'departed')}</td><td>${metric(b,'departed')}</td></tr></tbody></table><p class="gd-comparison-note">${!a||!b?'Run the other arm to retain a comparison.':matched?'Matched initial inputs. Compare at the same achieved time; no improvement is presumed.':'Inputs differ. Restart both arms with matching profiles before comparing.'}</p>${b?`<p class="gd-comparison-note">Agent source: ${b.policy==='live'?'live requested; inspect log for fallbacks':'deterministic demo policy'}.</p>`:''}`;
  }
  function render() {
    if (disposed) return;
    const s = state();
    if (!s) { lastState = null; syncDisabled(); return; }
    lastState = s; mode = s.mode ?? mode; policy = s.policy ?? policy;
    for (const b of root.querySelectorAll('[data-mode]')) b.setAttribute('aria-pressed',String(b.dataset.mode===mode));
    $('#gd-policy').value = policy;
    const entries = s.log ?? [];
    const fallback = entries.some(e=>/fallback/i.test(`${e.source ?? ''} ${e.type ?? ''}`));
    const live = entries.some(e=>e.source === 'live');
    const providerText = typeof s.providerStatus === 'string' ? s.providerStatus : s.providerStatus?.status ?? '';
    let status = mode==='baseline'?'Baseline · existing automatic gate policy':policy==='mock'?'Deterministic demo policy · no model call':fallback?'Live requested · fallback recorded':live?'Live model response received':s.pendingCount?'Live request pending · clock held':'Live configured · response not yet verified';
    if (policy==='live' && /missing|unavailable|timeout|error|failed/.test(providerText) && !live) status = `Live unavailable · ${words(providerText)}`;
    $('#gd-source-status').textContent = status;
    $('.gd-status').dataset.source = mode==='baseline'?'baseline':policy==='mock'?'mock':live&&!fallback?'live':'unverified';
    $('#gd-clock').textContent = clock(s.time);
    $('#gd-gate').textContent = gateLabel(s.announced?s.newGate:s.oldGate);
    $('#gd-departure').textContent = `Departure ${clock(s.departureAt)}`;
    $('#gd-clock-note').textContent = s.pendingCount ? `${s.pendingCount} decision${s.pendingCount===1?'':'s'} pending · simulation clock held.` : `Seed ${s.comparisonInputs?.seed ?? 42} · same scenario and profiles in both arms.`;
    $('#gd-announce').textContent = s.announced?'Gate change announced':'Run gate change';
    const ps = s.profiles ?? [], key = ps.map(p=>p.id).join('|');
    if (key !== lastProfileKey || s.runId !== lastRunId) {
      $('#gd-passenger-list').replaceChildren(); cards.clear();
      ps.forEach((p,i)=>$('#gd-passenger-list').appendChild(makeCard(p,i)));
      for (const p of ps) { const card=cards.get(p.id); for(const [name,input] of [...card.querySelectorAll('[data-trait]')].map(x=>[x.dataset.trait,x])) input.value=p.traits?.[name]??0; }
      lastProfileKey=key; lastRunId=s.runId;
    }
    for (const p of ps) {
      const card=cards.get(p.id), passenger=(s.passengers??[]).find(v=>v.id===p.id)??{};
      card.querySelector('.gd-person-name').textContent = p.name ?? passenger.name ?? p.id;
      card.querySelector('.gd-person-state').textContent = passenger.state==='walking_to_gate'?'Walking to announced gate':passenger.state==='demo_waiting'?(passenger.lastAction==='read_board'?'Checking the flight board':'Waiting briefly'):passenger.state==='modeled_departed'?'Departed · simulated':finite(passenger.arrivedAt)?'At the new gate':'Waiting at the original gate';
      card.querySelector('.gd-person-result').textContent = finite(passenger.arrivedAt) ? `Reached new gate at ${clock(passenger.arrivedAt)}` : s.announced?'Responding to the shared announcement':'Waiting for the shared announcement';
      card.querySelector('.gd-known-gate').textContent = gateLabel(passenger.gateNodeId ?? p.knowledge?.gateNodeId ?? (s.announced?s.newGate:s.oldGate));
      card.querySelector('.gd-last-action').textContent = words(typeof passenger.lastAction==='object'?passenger.lastAction?.type:passenger.lastAction??'none');
      card.querySelector('.gd-decision-count').textContent = passenger.decisionCount ?? 0;
      card.querySelector('.gd-confidence').textContent = Number(passenger.knowledge?.confidence??0).toFixed(2)+' · '+words(passenger.knowledge?.lastSource??'initial knowledge');
      card.querySelector('.gd-speed').textContent = (passenger.constraints?.walkingSpeedMps??1.2)+' m/s · same in both arms';
      const needs = passenger.needs ?? p.needs ?? {};
      card.querySelector('.gd-needs').textContent = Object.entries(needs).map(([k,v])=>`${words(k)} ${finite(v)?v.toFixed(2):short(v)}`).join(' · ') || 'No additional need authored';
    }
    const logKey = `${s.runId}:${entries.length}:${entries.at(-1)?.sequence ?? ''}:${entries.at(-1)?.type ?? ''}`;
    if (logKey!==lastLogKey) {
      lastLogKey=logKey; $('#gd-log-count').textContent=`${entries.length} events`;
      $('#gd-log').innerHTML=entries.length?entries.slice(-12).reverse().map(e=>{
        const person=ps.find(p=>p.id===e.passengerId), action=typeof e.action==='object'?e.action?.type:e.action;
        return `<li><div class="gd-log-meta"><time>${clock(e.time)}</time><strong>${esc(person?.name ?? e.passengerId ?? 'Scenario')}</strong><span>${esc(words(e.source ?? e.type))}</span></div><p>${esc(words(action ?? e.type))}${e.action?.seconds?` · ${esc(e.action.seconds)}s`:''}</p>${e.detail?`<small>${esc(short(e.detail))}</small>`:''}</li>`;
      }).join(''):'<li class="gd-empty">No gate-change decisions yet.</li>';
    }
    renderComparison(s); syncDisabled();
  }
  const timer=setInterval(render,250); void checkEndpoint(); render();
  return {render, getState:()=>({mode,policy,endpoint,retained:clone(retained)}), dispose(){disposed=true;clearInterval(timer);root.remove();}};
}
