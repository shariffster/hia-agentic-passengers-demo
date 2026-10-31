import test from 'node:test';
import assert from 'node:assert/strict';
import {SYNTHETIC_SPATIAL as spatial} from '../web/synthetic-graph.js';
import {
  createGateDemoController, DEFAULT_PROFILES, DEMO_INPUTS,
  normalizeProfiles, validateAction,
} from '../web/gate-agent-demo.js';

// Same controller/engine; a new three-node synthetic graph replaces private airport geometry.
// No external assets, network requests or credentials.
const clone = value => structuredClone(value);
const state = controller => controller.gateDemoState();
const accepted = controller => state(controller).log.filter(entry => entry.type === 'accepted');

async function advanceTo(controller, target) {
  for (let n = 0; controller.getTime() < target && n < 200; n++) {
    controller.step(Math.min(10, target - controller.getTime()));
    await controller.resolveDecisions();
    assert.equal(controller.assertInvariants(), true);
  }
  assert.equal(controller.getTime(), target, 'run reaches the requested achieved time');
}

function liveReply(request, action = { type: 'go_to_announced_gate' }) {
  return { requestId: request.requestId, runId: request.runId, passengerId: request.passengerId, action, summary: 'Proceed to the published gate.' };
}

test('baseline and agent arms start with identical passengers, inputs and flight information', t => {
  const baseline = createGateDemoController(spatial, { mode: 'baseline' });
  const agent = createGateDemoController(spatial, { mode: 'agent' });
  t.after(() => { baseline.dispose(); agent.dispose(); });
  assert.deepEqual(state(baseline).comparisonInputs, state(agent).comparisonInputs);
  assert.deepEqual(state(baseline).passengers, state(agent).passengers);
  assert.deepEqual(baseline.snapshot().cases, agent.snapshot().cases);
  assert.deepEqual(baseline.snapshot().flights, agent.snapshot().flights);
  assert.notEqual(state(baseline).runId, state(agent).runId);
  assert.equal(state(agent).providerStatus, 'deterministic_mock');
  assert.equal(state(agent).comparisonInputs.seed, 42);
  assert.equal(state(agent).passengers.length, 3);
  assert.ok(state(agent).passengers.every(p => p.knowledge.publishedGate === DEMO_INPUTS.oldGate));
  assert.ok(agent.snapshot().cases.every(p => p.profile.walkingSpeedMps === 1.2));
});

test('validated actions cause real route movement and distinct arrivals; both arms conserve and depart all three', async t => {
  const baseline = createGateDemoController(spatial, { mode: 'baseline' });
  const agent = createGateDemoController(spatial, { mode: 'agent' });
  t.after(() => { baseline.dispose(); agent.dispose(); });
  baseline.announce(); agent.announce();
  await agent.resolveDecisions();
  assert.deepEqual(accepted(agent).map(e => e.action), ['go_to_announced_gate', 'read_board', 'wait']);
  assert.ok(state(agent).passengers.every(p => p.position[0] === 0), 'acceptance never teleports a passenger');
  assert.deepEqual(state(agent).passengers.map(p => p.state), ['walking_to_gate', 'demo_waiting', 'demo_waiting']);
  await advanceTo(baseline, 63);
  await advanceTo(agent, 63);
  const midway = state(agent).passengers;
  assert.ok(midway.every(p => p.position[0] > 0 && p.position[0] < 120));
  assert.ok(midway[0].position[0] > midway[1].position[0] && midway[1].position[0] > midway[2].position[0]);
  await advanceTo(baseline, DEMO_INPUTS.departureAt);
  await advanceTo(agent, DEMO_INPUTS.departureAt);
  assert.deepEqual(state(baseline).passengers.map(p => p.arrivedAt), [113, 113, 113]);
  assert.deepEqual(state(agent).passengers.map(p => p.arrivedAt), [113, 116, 128]);
  assert.deepEqual(state(agent).passengers.map(p => p.decisionCount), [1, 2, 2]);
  for (const c of [baseline, agent]) {
    assert.ok(state(c).passengers.every(p => p.outcome === 'synthetic_departed' && p.state === 'modeled_departed'));
    assert.equal(c.snapshot().metrics.modeledDepartures, 3);
    assert.equal(c.snapshot().metrics.conservation, true);
    assert.equal(c.snapshot().flights[0].departureEvidence.boardedCaseIds.length, 3);
  }
  const sam = state(agent).log.filter(e => e.passengerId === 'DEMO-2');
  const boardResult = sam.findIndex(e => e.type === 'completed' && e.action === 'read_board');
  const moveDecision = sam.findIndex(e => e.type === 'accepted' && e.action === 'go_to_announced_gate');
  assert.ok(boardResult >= 0 && moveDecision > boardResult, 'an observed action result precedes redecision');
  assert.ok(sam[moveDecision].observation.previousResults.some(e => e.action === 'read_board'));
});

test('repeat announcements are idempotent in both arms', async t => {
  for (const mode of ['baseline', 'agent']) {
    const c = createGateDemoController(spatial, { mode }); t.after(() => c.dispose());
    c.announce(); await c.resolveDecisions();
    const before = state(c);
    c.announce(); c.reviewRepeatAnnouncement(); await c.resolveDecisions();
    const after = state(c);
    assert.deepEqual(after.passengers, before.passengers);
    assert.equal(after.log.filter(e => e.type === 'announcement').length, 3);
    assert.equal(after.log.filter(e => e.type === 'accepted').length, before.log.filter(e => e.type === 'accepted').length);
    assert.equal(after.log.filter(e => e.type === 'duplicate_ignored').length, 1);
    assert.equal(c.assertInvariants(), true);
  }
});

test('invalid model actions are rejected, logged and replaced with honest deterministic fallback', async t => {
  const c = createGateDemoController(spatial, { policy: 'live', decide: async r => liveReply(r, { type: 'teleport', destination: [0, 0, 0] }) });
  t.after(() => c.dispose());
  c.announce(); await c.resolveDecisions();
  const s = state(c);
  assert.equal(s.providerStatus, 'fallback');
  assert.equal(s.pendingCount, 0);
  assert.equal(s.log.filter(e => e.type === 'rejected').length, 3);
  assert.equal(s.log.filter(e => e.type === 'fallback').length, 3);
  assert.ok(accepted(c).every(e => e.source === 'fallback' && e.action === 'go_to_announced_gate'));
  assert.ok(s.passengers.every(p => p.position[0] === 0));
  c.step(10);
  assert.ok(state(c).passengers.every(p => p.position[0] > 0));
  assert.equal(c.assertInvariants(), true);
});

test('missing endpoint and timeout each produce explicit fallback without needing network', async t => {
  for (const [name, decide, expected] of [
    ['missing', async () => { throw Error('Model endpoint is not configured.'); }, /not configured/],
    ['timeout', () => new Promise(() => {}), /timed out/],
  ]) {
    const c = createGateDemoController(spatial, { policy: 'live', decide, timeoutMs: 5 }); t.after(() => c.dispose());
    c.announce(); await c.resolveDecisions();
    const s = state(c);
    assert.equal(s.providerStatus, 'fallback', name);
    assert.match(s.lastError, expected);
    assert.equal(s.pendingCount, 0);
    assert.equal(accepted(c).length, 3);
    assert.ok(accepted(c).every(e => e.source === 'fallback'));
    assert.equal(c.assertInvariants(), true);
  }
});

test('a partially successful model batch keeps fallback visible at run level', async t => {
  const c = createGateDemoController(spatial, { policy: 'live', decide: async request => {
    if (request.passengerId === 'DEMO-1') return liveReply(request, { type: 'invented_action' });
    return liveReply(request);
  } });
  t.after(() => c.dispose());
  c.announce(); await c.resolveDecisions();
  const s = state(c);
  assert.equal(s.log.filter(e => e.type === 'fallback').length, 1);
  assert.equal(accepted(c).filter(e => e.source === 'live').length, 2);
  assert.equal(accepted(c).filter(e => e.source === 'fallback').length, 1);
  assert.ok(['fallback', 'mixed_live_fallback'].includes(s.providerStatus), 'later successes must not hide a fallback in the same run');
  assert.equal(c.assertInvariants(), true);
});

test('the world clock pauses while model decisions are pending, then valid replies control movement', async t => {
  const requests = [], releases = [];
  const c = createGateDemoController(spatial, { policy: 'live', decide: request => {
    requests.push(clone(request)); return new Promise(resolve => releases.push(() => resolve(liveReply(request))));
  } });
  t.after(() => c.dispose());
  c.step(1000);
  assert.equal(c.getTime(), DEMO_INPUTS.announcementAt);
  assert.equal(state(c).pendingCount, 3);
  c.step(100); assert.equal(c.getTime(), DEMO_INPUTS.announcementAt);
  assert.equal(requests.length, 3);
  releases.forEach(release => release()); await c.resolveDecisions();
  assert.equal(state(c).providerStatus, 'live_response_received');
  assert.equal(state(c).pendingCount, 0);
  assert.ok(accepted(c).every(e => e.source === 'live'));
  c.step(10); assert.equal(c.getTime(), DEMO_INPUTS.announcementAt + 10);
  assert.ok(state(c).passengers.every(p => p.position[0] > 0));
});

test('disposed-run responses cannot mutate that run or a fresh run', async t => {
  const releases = [];
  const old = createGateDemoController(spatial, { policy: 'live', decide: request => new Promise(resolve => releases.push(() => resolve(liveReply(request)))) });
  old.announce(); const pending = old.resolveDecisions();
  old.dispose(); const oldBefore = state(old);
  const fresh = createGateDemoController(spatial); t.after(() => fresh.dispose());
  const freshBefore = state(fresh);
  releases.forEach(release => release()); await pending;
  assert.deepEqual(state(old), oldBefore);
  assert.deepEqual(state(fresh), freshBefore);
  old.step(20); assert.deepEqual(state(old), oldBefore);
  assert.notEqual(state(old).runId, state(fresh).runId);
  assert.equal(state(fresh).time, 1);
  assert.equal(state(fresh).announced, false);
  assert.equal(state(fresh).log.length, 1);
  fresh.announce(); await fresh.resolveDecisions();
  assert.equal(accepted(fresh).length, 3);
});

test('mismatched reply identity is rejected before it changes the passenger', async t => {
  const c = createGateDemoController(spatial, { policy: 'live', decide: async request => ({ ...liveReply(request), runId: 'another-run' }) });
  t.after(() => c.dispose());
  c.announce(); await c.resolveDecisions();
  assert.equal(state(c).providerStatus, 'fallback');
  assert.match(state(c).lastError, /Mismatched model response identity/);
  assert.ok(accepted(c).every(e => e.source === 'fallback'));
  assert.equal(c.assertInvariants(), true);
});

test('model observations contain published information only, and never leak the preannouncement gate change', async t => {
  const requests = [];
  const c = createGateDemoController(spatial, { policy: 'live', decide: async request => { requests.push(clone(request)); return liveReply(request); } });
  t.after(() => c.dispose());
  c.step(10); // Time 11: actual gate changed; announcement remains scheduled for 13.
  assert.equal(c.getTime(), DEMO_INPUTS.changeAt);
  assert.equal(requests.length, 0);
  assert.equal(c.snapshot().flights[0].gateNodeId, DEMO_INPUTS.newGate, 'test establishes the hidden operational change occurred');
  assert.equal(c.snapshot().flights[0].publishedGateNodeId, DEMO_INPUTS.oldGate);
  assert.ok(state(c).passengers.every(p => p.knowledge.publishedGate === DEMO_INPUTS.oldGate && p.gateNodeId === DEMO_INPUTS.oldGate));
  c.announce(); await c.resolveDecisions();
  assert.equal(requests.length, 3);
  for (const request of requests) {
    const o = request.observation;
    assert.equal(o.time, DEMO_INPUTS.announcementAt);
    assert.equal(o.flight.publishedGateNodeId, DEMO_INPUTS.newGate);
    assert.equal(o.knowledge.publishedGate, DEMO_INPUTS.newGate);
    assert.deepEqual(Object.keys(o.flight).sort(), ['id', 'publishedGateNodeId', 'publishedStatus', 'scheduledDepartureSeconds', 'secondsToDeparture'].sort());
    assert.deepEqual(Object.keys(o.routeEstimate).sort(), ['metres', 'seconds']);
    assert.deepEqual(request.allowedActions, o.allowedActions);
    assert.equal(o.flight.secondsToDeparture, DEMO_INPUTS.departureAt - DEMO_INPUTS.announcementAt);
    for (const forbidden of ['operationalStatus', 'gateResourceId', 'failureReasons', 'crewCurrentlyAvailable', 'aircraftCurrentlyOnsite', 'rampReady', 'cateringReady', 'events', 'futureEvents']) {
      assert.equal(JSON.stringify(o).includes('"' + forbidden + '"'), false, forbidden);
    }
  }
});

test('action validator enforces whitelist, exact action fields, state availability and whole-second wait bounds', () => {
  const o = { allowedActions: ['go_to_announced_gate', 'read_board', 'wait'], constraints: { maxWaitSeconds: 12 } };
  for (const action of [null, [], 'wait', {}, { type: 'execute_code' }, { type: 'go_to_announced_gate', seconds: 1 }, { type: 'go_to_announced_gate', target: 'hidden' }, { type: 'wait' }, { type: 'wait', seconds: 0 }, { type: 'wait', seconds: -1 }, { type: 'wait', seconds: 1.5 }, { type: 'wait', seconds: 13 }, { type: 'wait', seconds: 31 }, { type: 'wait', seconds: NaN }]) {
    assert.equal(validateAction(action, o).ok, false, JSON.stringify(action));
  }
  assert.deepEqual(validateAction({ action: { type: 'wait', seconds: 12 } }, o), { ok: true, action: { type: 'wait', seconds: 12 } });
  assert.equal(validateAction({ type: 'read_board' }, o).ok, true);
  assert.equal(validateAction({ type: 'wait', seconds: 1 }, { ...o, allowedActions: ['go_to_announced_gate'] }).ok, false);
  assert.equal(validateAction({ type: 'go_to_announced_gate' }, { ...o, allowedActions: [] }).ok, false);
});

test('repeated model waits cannot exceed the bounded action budget', async t => {
  const observations = [];
  const c = createGateDemoController(spatial, { policy: 'live', decide: async r => { observations.push(clone(r.observation)); return liveReply(r, { type: 'wait', seconds: 30 }); } });
  t.after(() => c.dispose());
  c.announce(); await c.resolveDecisions();
  await advanceTo(c, 200);
  assert.ok(state(c).passengers.every(p => p.knowledge.waits === 2 && p.arrivedAt === 173));
  assert.equal(state(c).pendingCount, 0);
  assert.equal(state(c).log.filter(e => e.type === 'rejected').length, 3);
  assert.ok(observations.filter(o => o.knowledge.waits === 2).every(o => !o.allowedActions.includes('wait')));
  assert.equal(c.assertInvariants(), true);
});

test('profile edits and exported/snapshot objects cannot leak across runs', t => {
  const custom = clone(DEFAULT_PROFILES); custom[0].traits.safetyMarginSeconds = 75;
  const c = createGateDemoController(spatial, { profiles: custom }); t.after(() => c.dispose());
  custom[0].traits.safetyMarginSeconds = 1;
  const exported = c.exportDemo();
  assert.equal(exported.synthetic, true); assert.equal(exported.calibrated, false);
  assert.equal(exported.profiles[0].traits.safetyMarginSeconds, 75);
  exported.profiles[0].traits.safetyMarginSeconds = 0; exported.passengers[0].knowledge.publishedGate = 'tampered'; exported.log[0].detail = 'tampered';
  assert.equal(state(c).profiles[0].traits.safetyMarginSeconds, 75);
  assert.equal(state(c).passengers[0].knowledge.publishedGate, DEMO_INPUTS.oldGate);
  assert.notEqual(state(c).log[0].detail, 'tampered');
  assert.equal(DEFAULT_PROFILES[0].traits.safetyMarginSeconds, 120);
  assert.throws(() => normalizeProfiles([]), /Exactly three/);
  const invalid = clone(DEFAULT_PROFILES); invalid[1].traits.familiarity = 1.1;
  assert.throws(() => normalizeProfiles(invalid), /Invalid profile/);
  assert.throws(() => c.step(-1), /Invalid step/);
  assert.throws(() => c.step(Infinity), /Invalid step/);
});
