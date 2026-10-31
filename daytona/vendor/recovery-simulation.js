import { RebookingSimulation, seededRandom } from './simulation.js';
import { StationaryAllocator } from './holding-layout.js';

export const RECOVERY_VERSION = '1.3.0';
export const RECOVERY_NOTICE = 'Synthetic repeated-disruption assistance experiment. Cases persist across encounters. Assistance is not ticket resolution or travel. Flight, crew, aircraft, security, hotel and transport dependencies are explicitly unimplemented; no departure is inferred.';
export const RECOVERY_DEFAULTS = Object.freeze({
  seed: 42, staff: 24, serviceMeanSeconds: 360, walkingSpeedMps: 1.2,
  dispatchPolicy: 'fifo', carryoverCapSeconds: 3600, routing: 'least_expected_delay',
  virtualCallbacks: false, callbackPolicy: 'work_conserving', phoneAccessFraction: 0.85, callbackDeliveryFailureFraction: 0.15,
  callbackNoShowFraction: 0.08, callbackGraceSeconds: 900,
  behaviorProfiles: false, reliefVisits: false, reliefFacilities: [], reliefReturnBufferSeconds: 120, reliefReturnPolicy: 'restore_previous_queue',
  stepFreeFraction: 0.15, partyFraction: 0.35, walkingSpeedVariation: 0.25, assistanceTimeVariation: 0.3,
  reliefNeedFractions: { prayer: 0.2, rest: 0.3, care: 0.15, sensory: 0.08, toilet: 0.25, play: 0.1 },
  accessClass: 'airside', stepFree: false,
  movementModel: 'free_flow', approachCapacityPerMinute: 6, approachObstructionFactor: 1,
});
export const RECOVERY_IMPLEMENTATION = Object.freeze({
  persistentCases: true, incomingAndExistingCohorts: true, disruptionWaves: true,
  gateChangesWithoutAutomaticRebooking: true, cappedPriorQueueCredit: true,
  finiteAirlineAssistanceStaffAndWorkstations: true, virtualCallbackFailuresAndReservations: true,
  nonPhonePhysicalAssistanceAlternative: true, workConservingProtectedCallbackTokens: true,
  ticketInventory: false, flightFeasibility: false, securityProcessing: false,
  crewWindows: false, aircraftReadiness: false, groundHandling: false, cateringReadiness: false,
  hotelEligibilityAndRooms: false, hotelStayAndCallback: false, transportAndReturn: false,
  boundedApproachEntryTiming: true, physicalPedestrianDynamics: false, illustrativeHoldingAllocation: true,
});

/** Hypothetical counts and times for software experiments; not calibrated passenger behavior. */
export function createRecoveryStory() {
  return {
    id: 'airside-repeat-disruption', version: '1.0.0', horizonSeconds: 10800,
    waves: [
      { id: 'already-airside', atSeconds: 0, durationSeconds: 300, count: 160, cohort: 'already_airside' },
      { id: 'incoming-connections', atSeconds: 300, durationSeconds: 1800, count: 260, cohort: 'incoming_connection' },
      { id: 'later-connections', atSeconds: 3600, durationSeconds: 1800, count: 180, cohort: 'incoming_connection' },
    ],
    disruptions: [
      { id: 'gate-information-change', atSeconds: 1800, type: 'gate_change', cohort: 'already_airside', fraction: 0.4 },
      { id: 'first-cancellation-wave', atSeconds: 3000, type: 'cancellation', cohort: 'already_airside', fraction: 0.65 },
      { id: 'delay-information', atSeconds: 4200, type: 'delay', fraction: 0.35 },
      { id: 'later-cancellation-wave', atSeconds: 6000, type: 'cancellation', fraction: 0.5 },
    ],
  };
}

const EPS = 1e-8;
const clone = (value) => structuredClone(value);
const activeQueueStates = new Set(['physical_queue', 'virtual_queue']);
const activeHelpStates = new Set(['help_pending', 'walking_to_help', 'physical_queue', 'virtual_queue', 'callback_returning', 'callback_no_show_pending']);
const walkingStates = new Set(['walking_to_help', 'walking_to_gate', 'callback_returning']);
const reliefStates = new Set(['walking_to_facility', 'facility_queue', 'facility_dwell', 'facility_returning', 'facility_regrouping']);
for (const state of reliefStates) activeHelpStates.add(state);
walkingStates.add('walking_to_facility'); walkingStates.add('facility_returning');
function finite(value, name, positive = false) {
  if (!Number.isFinite(value) || value < 0 || (positive && value === 0)) throw new Error(`${name} must be finite and ${positive ? 'positive' : 'nonnegative'}`);
  return value;
}
function integer(value, name) { finite(value, name); if (!Number.isInteger(value)) throw new Error(`${name} must be an integer`); return value; }
function fraction(value, name) { finite(value, name); if (value > 1) throw new Error(`${name} must be <= 1`); return value; }
function mean(values) { return values.length ? values.reduce((a, b) => a + b, 0) / values.length : null; }
function percentile(values, q = 0.95) { const sorted = [...values].sort((a, b) => a - b); return sorted.length ? sorted[Math.max(0, Math.ceil(sorted.length * q) - 1)] : null; }

class Events {
  constructor() { this.items = []; this.sequence = 0; }
  push(time, type, data = {}, priority = 2) {
    const event = { time, type, data, priority, sequence: this.sequence++ };
    let low = 0, high = this.items.length;
    while (low < high) {
      const mid = (low + high) >> 1, other = this.items[mid];
      const after = other.time < time || (other.time === time && (other.priority < priority || (other.priority === priority && other.sequence < event.sequence)));
      if (after) low = mid + 1; else high = mid;
    }
    this.items.splice(low, 0, event);
  }
  peek() { return this.items[0]; }
  pop() { return this.items.shift(); }
}

/** Cases, encounter queues and resource reservations; intentionally no flight inventory. */
export class RecoverySimulation {
  constructor(graph, parameters = {}) {
    this.params = { ...RECOVERY_DEFAULTS, ...clone(parameters) };
    const p = this.params;
    integer(p.staff, 'staff'); finite(p.serviceMeanSeconds, 'serviceMeanSeconds', true);
    finite(p.walkingSpeedMps, 'walkingSpeedMps', true); finite(p.carryoverCapSeconds, 'carryoverCapSeconds');
    finite(p.callbackGraceSeconds, 'callbackGraceSeconds', true);
    if (!['free_flow', 'bounded_approach'].includes(p.movementModel)) throw new Error('Unknown movementModel');
    finite(p.approachCapacityPerMinute, 'approachCapacityPerMinute', true);
    fraction(p.approachObstructionFactor, 'approachObstructionFactor');
    if (!p.approachObstructionFactor) throw new Error('approachObstructionFactor must be positive; closure is not modeled');
    finite(p.reliefReturnBufferSeconds, 'reliefReturnBufferSeconds');
    for (const key of ['stepFreeFraction', 'partyFraction', 'walkingSpeedVariation', 'assistanceTimeVariation']) fraction(p[key], key);
    for (const [key, value] of Object.entries(p.reliefNeedFractions)) fraction(value, `reliefNeedFractions.${key}`);
    for (const key of ['phoneAccessFraction', 'callbackDeliveryFailureFraction', 'callbackNoShowFraction']) fraction(p[key], key);
    if (!['fifo', 'capped_carryover'].includes(p.dispatchPolicy)) throw new Error('Unknown dispatchPolicy');
    if (!['work_conserving', 'reserved_station'].includes(p.callbackPolicy)) throw new Error('Unknown callbackPolicy');
    if (!['restore_previous_queue', 'physical_ready'].includes(p.reliefReturnPolicy)) throw new Error('Unknown reliefReturnPolicy');
    if (p.reliefVisits && p.callbackPolicy !== 'work_conserving') throw new Error('Relief visits require work_conserving callback tokens');
    if (!['nearest', 'least_expected_delay'].includes(p.routing)) throw new Error('Unknown routing');
    this.router = new RebookingSimulation(graph, { seed: p.seed, arrivalRatePerMinute: 0, staff: p.staff, walkingSpeedMps: p.walkingSpeedMps, accessClass: p.accessClass, stepFree: p.stepFree });
    this.nodes = this.router.nodes;
    this.services = new Map([...this.router.services].map(([id, service]) => {
      if (!Number.isFinite(service.counters)) throw new Error(`Recovery service ${id} requires explicit finite workstations`);
      return [id, { id, nodeId: service.nodeId, label: service.label ?? id, proposed: !!service.proposed, enabled: service.enabled, counters: service.counters, staff: service.staff, queue: [], busy: new Map(), reserved: new Map(), pendingCallbacks: new Map(), awayTokens: new Map(), completed: 0, maximumConcurrent: 0 }];
    }));
    this.origins = [...this.nodes.values()].filter((node) => node.kind === 'gate' || node.spawnWeight > 0).map((node) => ({ nodeId: node.id, weight: node.spawnWeight ?? 1 }));
    if (!this.origins.length) this.origins = [{ nodeId: this.nodes.keys().next().value, weight: 1 }];
    if (!this.origins.some((origin) => origin.weight > 0)) throw new Error('Need a positive-weight gate origin');
    this.time = 0; this.cases = new Map(); this.events = new Events(); this._nextCase = 1; this._queueSequence = 0;
    this.spatialPresentation = new StationaryAllocator(this.nodes, graph.services);
    this._approachNextEntry = 0; this._approachAdmissions = 0; this._approachDelayedCases = new Set();
    this._approachRequests = new Map(); this._approachArrivals = 0;
    this._travelDisplayGroups = new Map();
    this._assistanceCompleted = 0; this._observedEvents = []; this._disruptionsObserved = 0; this._coalescedDisruptions = 0;
    this._callbackCounts = { offered: 0, nonPhoneAlternative: 0, deliveryFailures: 0, noShows: 0, lateReturns: 0, returned: 0 };
    this._maximumQueue = 0; this._physicalQueueArea = 0; this._accountingTime = 0;
    this.parties = new Map(); this.facilities = new Map(); this.reliefGroups = new Map(); this._reliefSequence = 0;
    for (const raw of p.reliefFacilities) {
      if (!raw.id || this.facilities.has(raw.id) || !this.nodes.has(raw.nodeId)) throw new Error('Relief facilities require unique IDs and graph nodes');
      integer(raw.capacityPersons, 'Synthetic facility capacity'); finite(raw.dwellSeconds, 'Synthetic facility dwell', true);
      if (!Array.isArray(raw.functions) || !raw.functions.length) throw new Error('Relief facility requires declared functions');
      this.facilities.set(raw.id, { ...clone(raw), queue: [], occupants: new Map(), maximumOccupancy: 0, visitsCompleted: 0 });
    }
    const story = p.story ?? createRecoveryStory();
    this.story = clone(story);
    this._scheduleStory(story);
    if (p.mobileActivation) {
      finite(p.mobileActivation.atSeconds, 'mobile activation');
      if (!this.services.has(p.mobileActivation.serviceId)) throw new Error('Unknown mobile service');
      this.events.push(p.mobileActivation.atSeconds, 'enable_service', { id: p.mobileActivation.serviceId }, 0);
    }
  }

  _scheduleStory(story) {
    const ids = new Set();
    for (const [index, wave] of (story.waves ?? []).entries()) {
      const id = String(wave.id ?? `wave-${index}`);
      if (ids.has(id)) throw new Error(`Duplicate wave ${id}`); ids.add(id);
      finite(wave.atSeconds, 'wave time'); finite(wave.durationSeconds ?? 0, 'wave duration'); integer(wave.count, 'wave count');
      for (let n = 0; n < wave.count;) {
        const rng = seededRandom(`${this.params.seed}:party:${id}:${n}`);
        const partySize = this.params.behaviorProfiles && rng() < this.params.partyFraction ? Math.min(wave.count - n, 2 + Math.floor(rng() * 2)) : 1;
        const partyId = `${id}:party:${n}`, draw = seededRandom(`${this.params.seed}:wave:${id}:${n}`)();
        for (let member = 0; member < partySize; member++) this.events.push(wave.atSeconds + draw * (wave.durationSeconds ?? 0), 'arrival', {
          cohort: wave.cohort ?? 'incoming_connection', originNodeId: wave.originNodeId ?? (this.params.behaviorProfiles ? this._chooseOrigin(partyId) : undefined), waveId: id, partyId, partySize, partyMemberIndex: member,
        }, 2);
        n += partySize;
      }
    }
    for (const [index, disruption] of (story.disruptions ?? []).entries()) {
      const id = String(disruption.id ?? `disruption-${index}`);
      if (ids.has(id)) throw new Error(`Duplicate event ${id}`); ids.add(id);
      finite(disruption.atSeconds, 'disruption time'); fraction(disruption.fraction ?? 1, 'disruption fraction');
      if (!['cancellation', 'gate_change', 'delay'].includes(disruption.type)) throw new Error('Unknown disruption type');
      this.events.push(disruption.atSeconds, 'disruption', { ...disruption, id }, 0);
    }
  }

  _log(type, data = {}) {
    this._observedEvents.push({ time: this.time, type, ...data });
    if (this._observedEvents.length > 250) this._observedEvents.shift();
  }
  _chooseOrigin(caseId) {
    let value = seededRandom(`${this.params.seed}:origin:${caseId}`)() * this.origins.reduce((sum, origin) => sum + origin.weight, 0);
    for (const origin of this.origins) { value -= origin.weight; if (value < 0) return origin.nodeId; }
    return this.origins.at(-1).nodeId;
  }
  addCase({ id = `case-${String(this._nextCase++).padStart(5, '0')}`, cohort = 'incoming_connection', originNodeId, waveId = 'manual', hasPhone, partyId = id, partySize = 1, partyMemberIndex = 0, profile = {}, appearance } = {}) {
    this._advance(this.time);
    if (this.cases.has(id)) throw new Error(`Duplicate case ${id}`);
    const origin = originNodeId ?? this._chooseOrigin(id);
    if (!this.nodes.has(origin)) throw new Error(`Unknown case origin ${origin}`);
    integer(partySize, 'partySize'); if (!partySize) throw new Error('partySize must be positive');
    const draw = (field) => seededRandom(`${this.params.seed}:profile:${id}:${field}`)();
    const enabled = this.params.behaviorProfiles;
    const behavior = { communicationAccess: (hasPhone ?? draw('communication') < this.params.phoneAccessFraction) ? 'own_phone' : 'assisted_only',
      stepFreeRequired: enabled ? draw('mobility') < this.params.stepFreeFraction : this.params.stepFree,
      walkingSpeedMps: this.params.walkingSpeedMps * (enabled ? 1 + (2 * draw('walking') - 1) * this.params.walkingSpeedVariation : 1),
      assistanceSeconds: this.params.serviceMeanSeconds * (enabled ? 1 + (2 * draw('assistance') - 1) * this.params.assistanceTimeVariation : 1),
      needs: Object.fromEntries(Object.entries(this.params.reliefNeedFractions).map(([need, chance]) => [need, enabled && draw(`need:${need}`) < chance])), ...clone(profile) };
    // Preserve the previous keyed phone draw when behavior profiles are disabled.
    if (!enabled && profile.communicationAccess === undefined) behavior.communicationAccess = (hasPhone ?? seededRandom(`${this.params.seed}:phone:${id}`)() < this.params.phoneAccessFraction) ? 'own_phone' : 'assisted_only';
    if (!['own_phone', 'assisted_only'].includes(behavior.communicationAccess)) throw new Error('Unknown communication access profile');
    finite(behavior.walkingSpeedMps, 'profile walkingSpeedMps', true); finite(behavior.assistanceSeconds, 'profile assistanceSeconds', true);
    const passenger = {
      id, cohort, waveId, createdAt: this.time, originNodeId: origin, gateNodeId: origin, currentNodeId: origin,
      state: 'awaiting_recovery', stateSince: this.time, route: null, routeToken: 0,
      hasPhone: behavior.communicationAccess === 'own_phone', profile: behavior, partyId, partySize, partyMemberIndex,
      appearance: appearance ?? { paletteIndex: Math.floor(seededRandom(`${this.params.seed}:appearance:${id}`)() * 8) },
      reliefAttempted: false, reliefGroupId: null, reliefVisits: [], needsMet: {}, reliefUnmetReason: null,
      facilityQueueSeconds: 0, facilityDwellSeconds: 0, reliefWalkingSeconds: 0, reliefMissedCallbacks: 0,
      encounters: [], activeEncounter: null, assistanceCount: 0, disruptions: [],
      physicalQueueSeconds: 0, assistanceQueueWaitSeconds: 0, totalHelpWaitSeconds: 0, walkingSeconds: 0,
      ticketResolution: 'unknown', travelOutcome: 'unknown', accommodationOutcome: 'unknown',
      movementDelayIntervals: [], movementWaitUntil: null, movementWaitNodeId: null,
    };
    const party = this.parties.get(partyId) ?? { id: partyId, expectedSize: partySize, memberIds: [], serviceId: null };
    if (party.expectedSize !== partySize || party.memberIds.length >= partySize) throw new Error('Inconsistent or overfull party');
    party.memberIds.push(id); this.parties.set(partyId, party);
    this.cases.set(id, passenger); this._openEncounter(passenger, 'initial_help');
    if (!this._processingEvent) this.spatialPresentation.sync(this);
    return id;
  }
  _transition(passenger, next) {
    const elapsed = this.time - passenger.stateSince;
    if (passenger.state === 'physical_queue') passenger.physicalQueueSeconds += elapsed;
    if (activeQueueStates.has(passenger.state)) {
      passenger.assistanceQueueWaitSeconds += elapsed;
      if (passenger.activeEncounter) passenger.activeEncounter.queueWaitSeconds += elapsed;
    }
    if (activeHelpStates.has(passenger.state)) passenger.totalHelpWaitSeconds += elapsed;
    if (walkingStates.has(passenger.state)) passenger.walkingSeconds += elapsed;
    if (passenger.state === 'facility_queue') passenger.facilityQueueSeconds += elapsed;
    if (passenger.state === 'facility_dwell') passenger.facilityDwellSeconds += elapsed;
    if (['walking_to_facility', 'facility_returning'].includes(passenger.state)) passenger.reliefWalkingSeconds += elapsed;
    passenger.state = next; passenger.stateSince = this.time;
  }
  _priorQueueWait(passenger) { return passenger.encounters.filter((encounter) => encounter.assistanceCompletedAt !== null).reduce((sum, encounter) => sum + encounter.queueWaitSeconds, 0); }
  _openEncounter(passenger, reason) {
    if (passenger.activeEncounter) throw new Error('Cannot open concurrent assistance encounters');
    const encounter = { id: `${passenger.id}:visit-${passenger.encounters.length + 1}`, number: passenger.encounters.length + 1,
      openedAt: this.time, reason, serviceId: null, queueEnteredAt: null, queueSequence: null, queueWaitSeconds: 0,
      priorQueueWaitSeconds: this._priorQueueWait(passenger), appliedCarryoverSeconds: 0,
      assistanceStartedAt: null, assistanceCompletedAt: null, callbackAttempted: false, callbackFallback: false };
    passenger.encounters.push(encounter); passenger.activeEncounter = encounter;
    this._transition(passenger, 'help_pending');
    const choice = this._chooseService(passenger);
    if (!choice) { this._log('unreachable_help', { caseId: passenger.id, encounterId: encounter.id }); return; }
    encounter.serviceId = choice.service.id;
    if (this.params.virtualCallbacks && passenger.hasPhone && !passenger.route) {
      this._callbackCounts.offered++; this._joinQueue(passenger, true);
    } else {
      if (this.params.virtualCallbacks && !passenger.hasPhone) this._callbackCounts.nonPhoneAlternative++;
      this._walk(passenger, choice.route, 'walking_to_help');
    }
  }

  _routeOrigin(passenger) {
    if (!passenger.route) return { nodeId: passenger.currentNodeId, prefix: [] };
    let elapsed = Math.max(0, this.time - passenger.walkStartedAt);
    for (const segment of passenger.route.segments) {
      if (elapsed < segment.durationSeconds - EPS) {
        const from = segment.fromPosition ?? this.nodes.get(segment.from).position;
        const to = this.nodes.get(segment.to).position;
        const ratio = segment.durationSeconds ? elapsed / segment.durationSeconds : 1;
        return { nodeId: segment.to, prefix: [{ from: 'in_transit', fromPosition: from.map((value, i) => value + (to[i] - value) * ratio), to: segment.to,
          durationSeconds: segment.durationSeconds - elapsed, distanceMeters: segment.distanceMeters * (1 - ratio) }] };
      }
      elapsed -= segment.durationSeconds;
    }
    return { nodeId: passenger.route.nodeIds.at(-1), prefix: [] };
  }
  _routeTo(passenger, target) {
    const origin = this._routeOrigin(passenger), rest = this.router.shortestPath(origin.nodeId, target, { stepFree: passenger.profile?.stepFreeRequired ?? this.params.stepFree });
    if (!rest) return null;
    const factor = this.params.walkingSpeedMps / (passenger.profile?.walkingSpeedMps ?? this.params.walkingSpeedMps);
    const segments = [...origin.prefix, ...rest.segments.map((segment) => ({ ...segment, durationSeconds: segment.durationSeconds * factor }))];
    return { nodeIds: [origin.nodeId, ...rest.nodeIds.slice(1)], segments,
      durationSeconds: segments.reduce((sum, segment) => sum + segment.durationSeconds, 0), distanceMeters: segments.reduce((sum, segment) => sum + segment.distanceMeters, 0), target };
  }
  _chooseService(passenger) {
    let choice = null, score = Infinity;
    const party = this.parties.get(passenger.partyId);
    for (const service of this.services.values()) {
      if (!service.enabled) continue;
      if (this.params.behaviorProfiles && party?.serviceId && party.serviceId !== service.id) continue;
      const route = this._routeTo(passenger, service.nodeId); if (!route) continue;
      const wait = service.staff ? (service.queue.length + service.busy.size + service.reserved.size + service.pendingCallbacks.size + service.awayTokens.size) * this.params.serviceMeanSeconds / service.staff : 1e9;
      const value = route.durationSeconds + (this.params.routing === 'least_expected_delay' ? wait : 0);
      if (value < score) { score = value; choice = { service, route }; }
    }
    if (choice && this.params.behaviorProfiles && party) party.serviceId = choice.service.id;
    return choice;
  }
  _walk(passenger, route, state) {
    if (!route) { this._transition(passenger, 'help_pending'); return; }
    const pending = this._approachRequests.get(passenger.movementRequestId);
    if (pending?.status === 'waiting') {
      pending.status = 'cancelled'; pending.cancelledAt = this.time;
      const interval = passenger.movementDelayIntervals.find(item => item.requestId === pending.id);
      if (interval) interval.until = Math.min(interval.until, this.time);
      passenger.movementWaitUntil = null;
    }
    this._transition(passenger, state); passenger.route = route; passenger.walkStartedAt = this.time;
    const displayGroupKey = `${this.time}:${state}:${route.nodeIds.join(',')}`;
    passenger.travelDisplayGroupId = displayGroupKey;
    passenger.travelDisplayIndex = this._travelDisplayGroups.get(displayGroupKey) ?? 0;
    this._travelDisplayGroups.set(displayGroupKey, passenger.travelDisplayIndex + 1);
    passenger.routeToken++;
    if (this.params.movementModel === 'bounded_approach' && ['walking_to_help', 'callback_returning', 'facility_returning'].includes(state)) {
      const index = route.segments.findIndex(segment => segment.from === 'a_2' && segment.to === 'service_a');
      if (index >= 0) {
        const before = route.segments.slice(0, index).reduce((n, segment) => n + segment.durationSeconds, 0);
        this.events.push(this.time + before, 'movement_entry', { id: passenger.id, token: passenger.routeToken, index }, 2);
      }
    }
    if (route.durationSeconds <= EPS) this._walkComplete(passenger, passenger.routeToken);
    else this.events.push(this.time + route.durationSeconds, 'walk_complete', { id: passenger.id, token: passenger.routeToken }, 2);
  }
  _enterMovementApproach(passenger, token, index) {
    if (!passenger?.route || token !== passenger.routeToken) return;
    const entry = Math.max(this.time, this._approachNextEntry), delay = entry - this.time;
    this._approachNextEntry = entry + 60 / (this.params.approachCapacityPerMinute * this.params.approachObstructionFactor);
    const request = { id: `a-approach-${this._approachRequests.size + 1}`, caseId: passenger.id, requestedAt: this.time,
      releasedAt: delay > EPS ? null : this.time, reservedEntryAt: entry, status: delay > EPS ? 'waiting' : 'released', arrivedAt: null };
    this._approachRequests.set(request.id, request); passenger.movementRequestId = request.id;
    if (delay <= EPS) this._approachAdmissions++;
    const remaining = passenger.route.segments.slice(index), originalTarget = passenger.route.target;
    if (delay > EPS) {
      this._approachDelayedCases.add(passenger.id); passenger.movementDelayIntervals.push({ from: this.time, until: entry, nodeId: 'a_2', requestId: request.id, state: passenger.state });
      passenger.movementWaitUntil = entry; passenger.movementWaitNodeId = 'a_2';
      remaining.unshift({ from: 'a_2', to: 'a_2', distanceMeters: 0, durationSeconds: delay, kind: 'approach_wait' });
    }
    passenger.route = { ...passenger.route, nodeIds: ['a_2', ...remaining.map(segment => segment.to)], segments: remaining,
      target: originalTarget, durationSeconds: remaining.reduce((n, segment) => n + segment.durationSeconds, 0), distanceMeters: remaining.reduce((n, segment) => n + segment.distanceMeters, 0) };
    // Preserve the existing walking clock; only the local route origin clock restarts.
    passenger.walkStartedAt = this.time; passenger.routeToken++;
    if (delay > EPS) this.events.push(entry, 'movement_release', { id: passenger.id, token: passenger.routeToken }, 1);
    this.events.push(this.time + passenger.route.durationSeconds, 'walk_complete', { id: passenger.id, token: passenger.routeToken }, 2);
  }
  _walkComplete(passenger, token) {
    if (token !== passenger.routeToken || !passenger.route) return;
    passenger._displayArrivalPosition = this.spatialPresentation.routePosition(passenger, this);
    passenger._displayArrivalAt = this.time;
    const movementRequest = this._approachRequests.get(passenger.movementRequestId);
    if (passenger.route.target === 'service_a' && movementRequest?.status === 'released' && movementRequest.arrivedAt === null) {
      movementRequest.arrivedAt = this.time; this._approachArrivals++;
    }
    const state = passenger.state;
    passenger.currentNodeId = passenger.route.target; passenger.route = null;
    if (state === 'walking_to_facility' || state === 'facility_returning') { this._reliefArrived(passenger, state); return; }
    if (state === 'walking_to_help') this._joinQueue(passenger, false);
    else if (state === 'walking_to_gate') this._transition(passenger, 'awaiting_recovery');
    else if (state === 'callback_returning') {
      const service = this.services.get(passenger.activeEncounter.serviceId);
      if (service.reserved.has(passenger.id)) {
        const slot = service.reserved.get(passenger.id); service.reserved.delete(passenger.id);
        this._callbackCounts.returned++; this._beginAssistance(passenger, service, slot);
      } else {
        if (service.pendingCallbacks.delete(passenger.id)) this._callbackCounts.returned++;
        // The original registration and accrued queue waiting survive the walk.
        // A currently busy station finishes its work; no passenger is preempted.
        this._joinQueue(passenger, false);
      }
    }
  }

  _joinQueue(passenger, virtual) {
    const encounter = passenger.activeEncounter, service = this.services.get(encounter.serviceId);
    if (encounter.queueEnteredAt === null) { encounter.queueEnteredAt = this.time; encounter.queueSequence = this._queueSequence++; }
    this._transition(passenger, virtual ? 'virtual_queue' : 'physical_queue');
    service.queue.push(passenger.id); this._considerRelief(passenger); this._dispatch(service);
    this._maximumQueue = Math.max(this._maximumQueue, this._physicalQueued());
  }
  _queueWait(passenger) { return passenger.activeEncounter.queueWaitSeconds + (activeQueueStates.has(passenger.state) ? this.time - passenger.stateSince : 0); }
  _priority(passenger) {
    const encounter = passenger.activeEncounter;
    if (this.params.dispatchPolicy === 'fifo') return -encounter.queueSequence;
    return this._queueWait(passenger) + Math.min(this.params.carryoverCapSeconds, encounter.priorQueueWaitSeconds);
  }
  _sortedQueue(service) {
    return [...service.queue].sort((a, b) => this._priority(this.cases.get(b)) - this._priority(this.cases.get(a)) || this.cases.get(a).activeEncounter.queueSequence - this.cases.get(b).activeEncounter.queueSequence);
  }
  _freeSlot(service) {
    const used = new Set([...service.busy.values(), ...service.reserved.values()]);
    for (let i = 0; i < service.staff; i++) if (!used.has(i)) return i;
    return null;
  }
  _considerRelief(passenger) {
    if (!this.params.reliefVisits || passenger.reliefAttempted || passenger.reliefGroupId) return;
    const party = this.parties.get(passenger.partyId), members = party.memberIds.map((id) => this.cases.get(id));
    if (members.length !== party.expectedSize) return;
    if (members.some((p) => !activeQueueStates.has(p.state) || p.reliefAttempted || p.route || p.activeEncounter?.serviceId !== passenger.activeEncounter?.serviceId || p.currentNodeId !== passenger.currentNodeId)) {
      passenger.reliefUnmetReason = 'party_not_jointly_ready'; return;
    }
    const needs = [...new Set(members.flatMap((p) => Object.entries(p.profile.needs ?? {}).filter(([need, wanted]) => wanted && !p.needsMet[need]).map(([need]) => need)))];
    if (!needs.length) return;
    for (const p of members) p.reliefAttempted = true;
    const service = this.services.get(passenger.activeEncounter.serviceId);
    const firstPriority = Math.max(...members.map((p) => this._priority(p)));
    const ahead = service.queue.filter((id) => !party.memberIds.includes(id) && this._priority(this.cases.get(id)) > firstPriority).length;
    let windowSeconds = service.staff ? (ahead + service.busy.size) * this.params.serviceMeanSeconds / service.staff : 0;
    for (const p of members) {
      const flight = this.flights?.get(p.flightId);
      if (flight) windowSeconds = Math.min(windowSeconds, (flight.announcedEstimatedDepartureSeconds ?? flight.departureSeconds) - this.time);
    }
    const profile = { ...passenger.profile, stepFreeRequired: members.some((p) => p.profile.stepFreeRequired), walkingSpeedMps: Math.min(...members.map((p) => p.profile.walkingSpeedMps)) };
    const proxy = { ...passenger, profile }; let choice = null;
    for (const facility of this.facilities.values()) {
      const supportedNeeds = needs.filter((need) => facility.functions.includes(need));
      if (!supportedNeeds.length || facility.capacityPersons < members.length) continue;
      const outbound = this._routeTo(proxy, facility.nodeId);
      const back = this._routeTo({ ...proxy, route: null, currentNodeId: facility.nodeId }, service.nodeId);
      if (!outbound || !back) continue;
      const occupied = [...facility.occupants.keys()].reduce((n, id) => n + this.reliefGroups.get(id).memberIds.length, 0);
      const queuedPeople = facility.queue.reduce((n, id) => n + this.reliefGroups.get(id).memberIds.length, 0);
      const remaining = Math.max(0, ...[...facility.occupants.keys()].map((id) => (this.reliefGroups.get(id).dwellEndsAt ?? this.time) - this.time));
      const estimatedWait = occupied + members.length > facility.capacityPersons || queuedPeople ? remaining + Math.ceil(queuedPeople / facility.capacityPersons) * facility.dwellSeconds : 0;
      const required = outbound.durationSeconds + estimatedWait + facility.dwellSeconds + back.durationSeconds + this.params.reliefReturnBufferSeconds;
      if (required <= windowSeconds && (!choice || required < choice.required)) choice = { facility, outbound, back, required, estimatedWait, supportedNeeds };
    }
    if (!choice) {
      for (const p of members) p.reliefUnmetReason = 'no_supported_reachable_capacity_and_time_window';
      this._log('relief_not_feasible', { partyId: party.id, windowSeconds, needs }); return;
    }
    const group = { id: `relief-${++this._reliefSequence}`, partyId: party.id, memberIds: [...party.memberIds], facilityId: choice.facility.id, serviceId: service.id,
      profile, supportedNeeds: choice.supportedNeeds, state: 'outbound', startedAt: this.time, deadlineAt: this.time + windowSeconds,
      estimatedRequiredSeconds: choice.required, estimatedFacilityWaitSeconds: choice.estimatedWait,
      returnBufferSeconds: this.params.reliefReturnBufferSeconds, returnTravelSeconds: choice.back.durationSeconds,
      originalQueueStates: Object.fromEntries(members.map((p) => [p.id, p.state])),
      arrived: new Set(), returned: new Set(), needsCompleted: false, callbackRequestedAt: null, callbackDelivery: null, callbackMissRecorded: false };
    this.reliefGroups.set(group.id, group);
    for (const p of members) {
      service.queue.splice(service.queue.indexOf(p.id), 1); service.awayTokens.set(p.id, group.id);
      p.reliefGroupId = group.id; p.reliefUnmetReason = null;
      p.reliefVisits.push({ groupId: group.id, facilityId: group.facilityId, startedAt: this.time, completedAt: null, returnedAt: null, outcome: 'in_progress' });
    }
    // A conservative planned return uses the original budget. Actual queues/callbacks
    // may change; the budget is an explicit estimate, not a promise of service time.
    this.events.push(Math.max(this.time, group.deadlineAt - group.returnBufferSeconds - group.returnTravelSeconds), 'relief_return', { groupId: group.id, reason: 'planned_return_budget' }, 2);
    for (const p of members) this._walk(p, clone(choice.outbound), 'walking_to_facility');
    this._log('relief_departed', { groupId: group.id, partyId: party.id, facilityId: group.facilityId, memberIds: group.memberIds, windowSeconds, estimatedRequiredSeconds: choice.required });
  }
  _reliefArrived(passenger, state) {
    const group = this.reliefGroups.get(passenger.reliefGroupId); if (!group) throw new Error('Missing relief group');
    this._transition(passenger, 'facility_regrouping');
    if (state === 'walking_to_facility') {
      group.arrived.add(passenger.id); if (group.arrived.size !== group.memberIds.length) return;
      group.state = 'queued'; const facility = this.facilities.get(group.facilityId); facility.queue.push(group.id);
      for (const id of group.memberIds) this._transition(this.cases.get(id), 'facility_queue');
      this._dispatchFacility(facility);
    } else {
      group.returned.add(passenger.id); if (group.returned.size !== group.memberIds.length) return;
      group.state = 'returned'; group.returnedAt = this.time;
      const service = this.services.get(group.serviceId);
      if (group.callbackRequestedAt !== null && this.time > group.callbackRequestedAt + this.params.callbackGraceSeconds) this._recordReliefMiss(group);
      for (const id of group.memberIds) {
        const person = this.cases.get(id); service.awayTokens.delete(id); person.reliefGroupId = null;
        person.reliefVisits.at(-1).returnedAt = this.time;
        person.reliefVisits.at(-1).outcome = group.needsCompleted ? 'need_served' : 'interrupted_unmet';
        const ready = this.params.reliefReturnPolicy === 'physical_ready' || group.callbackDelivery === 'delivered_to_party' || group.originalQueueStates[id] === 'physical_queue';
        this._transition(person, ready ? 'physical_queue' : 'virtual_queue'); service.queue.push(id);
      }
      this._log('relief_returned', { groupId: group.id, memberIds: group.memberIds, needsCompleted: group.needsCompleted });
      this._dispatch(service);
    }
  }
  _dispatchFacility(facility) {
    let occupancy = [...facility.occupants.keys()].reduce((n, id) => n + this.reliefGroups.get(id).memberIds.length, 0);
    while (facility.queue.length) {
      const group = this.reliefGroups.get(facility.queue[0]);
      if (occupancy + group.memberIds.length > facility.capacityPersons) break; // Parties stay together; no queue jumping.
      facility.queue.shift(); facility.occupants.set(group.id, group.memberIds.length); occupancy += group.memberIds.length;
      facility.maximumOccupancy = Math.max(facility.maximumOccupancy, occupancy); group.state = 'dwell'; group.dwellStartedAt = this.time; group.dwellEndsAt = this.time + facility.dwellSeconds;
      for (const id of group.memberIds) this._transition(this.cases.get(id), 'facility_dwell');
      this.events.push(group.dwellEndsAt, 'relief_dwell_complete', { groupId: group.id }, 1);
    }
  }
  _returnRelief(group, reason) {
    if (!group || ['returning', 'returned'].includes(group.state)) return;
    const facility = this.facilities.get(group.facilityId);
    const index = facility.queue.indexOf(group.id); if (index >= 0) facility.queue.splice(index, 1);
    facility.occupants.delete(group.id);
    const leader = this.cases.get(group.memberIds[0]), route = this._routeTo({ ...leader, profile: group.profile }, this.services.get(group.serviceId).nodeId);
    if (!route) throw new Error('Relief return route disappeared from unchanged graph');
    group.state = 'returning'; group.returnReason = reason;
    for (const id of group.memberIds) {
      const person = this.cases.get(id);
      if (!group.needsCompleted) person.reliefUnmetReason = reason;
      this._walk(person, clone(route), 'facility_returning');
    }
    this._dispatchFacility(facility);
  }
  _recordReliefMiss(group) {
    if (group.callbackMissRecorded) return; group.callbackMissRecorded = true;
    for (const id of group.memberIds) this.cases.get(id).reliefMissedCallbacks++;
    this._log('relief_callback_window_missed', { groupId: group.id, membersAffected: group.memberIds.length });
  }
  _notifyReliefCandidates(service) {
    if (!service.awayTokens.size || service.busy.size + service.reserved.size >= service.staff) return;
    const readyPriority = Math.max(-Infinity, ...service.queue.map((id) => this._priority(this.cases.get(id))));
    const groupIds = [...new Set(service.awayTokens.values())].sort((a, b) => {
      const priority = (id) => Math.max(...this.reliefGroups.get(id).memberIds.map((p) => this._priority(this.cases.get(p)))); return priority(b) - priority(a);
    });
    let pending = groupIds.filter((id) => this.reliefGroups.get(id).callbackRequestedAt !== null).length;
    for (const id of groupIds) {
      const group = this.reliefGroups.get(id);
      if (pending >= service.staff) break;
      if (group.callbackRequestedAt !== null || group.state === 'returning') continue;
      if (Math.max(...group.memberIds.map((p) => this._priority(this.cases.get(p)))) < readyPriority) continue;
      group.callbackRequestedAt = this.time; pending++;
      const members = group.memberIds.map((caseId) => this.cases.get(caseId));
      const delivered = members.some((p) => p.hasPhone) && seededRandom(`${this.params.seed}:relief-notification:${group.partyId}`)() >= this.params.callbackDeliveryFailureFraction;
      group.callbackDelivery = delivered ? 'delivered_to_party' : 'unreachable_planned_return';
      if (delivered) this.events.push(this.time, 'relief_return', { groupId: group.id, reason: 'callback_requested_return' }, 2);
      this.events.push(this.time + this.params.callbackGraceSeconds, 'relief_callback_deadline', { groupId: group.id }, 3);
      this._log('relief_callback_requested', { groupId: group.id, delivery: group.callbackDelivery, workstationReserved: false });
    }
  }
  _handleReliefEvent(event) {
    const group = this.reliefGroups.get(event.data.groupId); if (!group) return;
    if (event.type === 'relief_return') this._returnRelief(group, event.data.reason);
    else if (event.type === 'relief_callback_deadline') { if (group.state !== 'returned') this._recordReliefMiss(group); }
    else if (event.type === 'relief_dwell_complete' && group.state === 'dwell') {
      group.needsCompleted = true; this.facilities.get(group.facilityId).visitsCompleted++;
      for (const id of group.memberIds) {
        const person = this.cases.get(id);
        for (const need of group.supportedNeeds) if (person.profile.needs?.[need]) person.needsMet[need] = true;
        person.reliefVisits.at(-1).completedAt = this.time;
      }
      this._returnRelief(group, 'dwell_complete');
    }
  }
  _dispatch(service) {
    this._notifyReliefCandidates(service);
    while (service.enabled && service.queue.length && service.busy.size + service.reserved.size < service.staff) {
      const id = this._sortedQueue(service).find((caseId) => {
        const passenger = this.cases.get(caseId);
        return passenger.state !== 'virtual_queue' || this.params.callbackPolicy === 'reserved_station' || service.pendingCallbacks.size < service.staff;
      });
      if (id === undefined) break; // Only absent virtual cases remain; no ready work.
      const passenger = this.cases.get(id);
      service.queue.splice(service.queue.indexOf(id), 1);
      const slot = this._freeSlot(service);
      if (passenger.state === 'virtual_queue') this._callBack(passenger, service, slot);
      else this._beginAssistance(passenger, service, slot);
    }
  }
  _beginAssistance(passenger, service, slot) {
    const encounter = passenger.activeEncounter;
    this._transition(passenger, 'assistance');
    encounter.assistanceStartedAt = this.time;
    encounter.appliedCarryoverSeconds = this.params.dispatchPolicy === 'capped_carryover' ? Math.min(this.params.carryoverCapSeconds, encounter.priorQueueWaitSeconds) : 0;
    service.busy.set(passenger.id, slot); passenger.serverIndex = slot;
    service.maximumConcurrent = Math.max(service.maximumConcurrent, service.busy.size + service.reserved.size);
    this.events.push(this.time + passenger.profile.assistanceSeconds, 'assistance_complete', { id: passenger.id, encounterId: encounter.id }, 1);
  }
  _callBack(passenger, service, slot) {
    const encounter = passenger.activeEncounter; encounter.callbackAttempted = true;
    const rng = seededRandom(`${this.params.seed}:callback:${encounter.id}`);
    const deliveryFailure = rng() < this.params.callbackDeliveryFailureFraction;
    const noShow = rng() < this.params.callbackNoShowFraction;
    if (deliveryFailure) {
      this._callbackCounts.deliveryFailures++; encounter.callbackFallback = true;
      this._log('callback_delivery_failed', { caseId: passenger.id, encounterId: encounter.id });
      // Synthetic assisted fallback preserves the case; there is no invented successful SMS.
      this._walk(passenger, this._routeTo(passenger, service.nodeId), 'walking_to_help'); return;
    }
    if (this.params.callbackPolicy === 'reserved_station') {
      service.reserved.set(passenger.id, slot);
      service.maximumConcurrent = Math.max(service.maximumConcurrent, service.busy.size + service.reserved.size);
    } else {
      // Notification tokens are not workstations or staff. Bound invitations to one
      // per assigned staff member, while any ready case can use a free workstation.
      service.pendingCallbacks.set(passenger.id, { encounterId: encounter.id, requestedAt: this.time });
    }
    if (noShow) this._transition(passenger, 'callback_no_show_pending');
    else this._walk(passenger, this._routeTo(passenger, service.nodeId), 'callback_returning');
    this.events.push(this.time + this.params.callbackGraceSeconds, 'callback_expiry', { id: passenger.id, encounterId: encounter.id }, 3);
  }
  _callbackExpiry(passenger, encounterId) {
    const encounter = passenger?.activeEncounter;
    if (!encounter || encounter.id !== encounterId) return;
    const service = this.services.get(encounter.serviceId);
    if (!service.reserved.has(passenger.id) && !service.pendingCallbacks.has(passenger.id)) return;
    service.reserved.delete(passenger.id); service.pendingCallbacks.delete(passenger.id); encounter.callbackFallback = true;
    if (passenger.state === 'callback_no_show_pending') {
      this._callbackCounts.noShows++;
      this._walk(passenger, this._routeTo(passenger, service.nodeId), 'walking_to_help');
    } else {
      this._callbackCounts.lateReturns++;
      // Keep the existing route and its arrival event; return then joins physical assistance.
      this._transition(passenger, 'walking_to_help');
    }
    this._log('callback_expired', { caseId: passenger.id, encounterId }); this._dispatch(service);
  }
  _completeAssistance(passenger, encounterId) {
    const encounter = passenger?.activeEncounter;
    if (passenger?.state !== 'assistance' || encounter?.id !== encounterId) return;
    const service = this.services.get(encounter.serviceId); service.busy.delete(passenger.id); service.completed++;
    encounter.assistanceCompletedAt = this.time; passenger.assistanceCount++; this._assistanceCompleted++;
    passenger.activeEncounter = null; passenger.serverIndex = null;
    this._log('assistance_completed', { caseId: passenger.id, encounterId, ticketResolution: 'unknown', travelOutcome: 'unknown' });
    const route = this._routeTo(passenger, passenger.gateNodeId);
    if (route) this._walk(passenger, route, 'walking_to_gate'); else this._transition(passenger, 'awaiting_recovery');
    this._dispatch(service);
  }

  /** Gate changes/delays carry information; only cancellation opens a new help encounter. */
  disruptCase(caseId, { id = `manual-${this._disruptionsObserved}`, type = 'cancellation', gateNodeId } = {}) {
    this._advance(this.time);
    const passenger = this.cases.get(caseId); if (!passenger) throw new Error(`Unknown case ${caseId}`);
    if (!['cancellation', 'gate_change', 'delay'].includes(type)) throw new Error('Unknown disruption type');
    if (gateNodeId !== undefined && !this.nodes.has(gateNodeId)) throw new Error('Unknown gate node');
    this._disruptionsObserved++;
    passenger.disruptions.push({ id, type, time: this.time });
    this._log(type, { caseId, disruptionId: id });
    if (type === 'gate_change') {
      passenger.gateNodeId = gateNodeId ?? this.origins[Math.floor(seededRandom(`${this.params.seed}:gate:${id}:${caseId}`)() * this.origins.length)].nodeId;
      if (['awaiting_recovery', 'walking_to_gate'].includes(passenger.state)) {
        const route = this._routeTo(passenger, passenger.gateNodeId);
        if (route) this._walk(passenger, route, 'walking_to_gate');
        else this._log('unreachable_gate_change', { caseId, gateNodeId: passenger.gateNodeId });
      }
    } else if (type === 'cancellation') {
      if (passenger.activeEncounter) { this._coalescedDisruptions++; this._log('disruption_added_to_open_case', { caseId, encounterId: passenger.activeEncounter.id }); }
      else this._openEncounter(passenger, 'new_disruption');
    }
    if (!this._processingEvent) this.spatialPresentation.sync(this);
  }
  _applyDisruption(disruption) {
    let affected = 0;
    for (const passenger of this.cases.values()) {
      if (disruption.caseIds && !disruption.caseIds.includes(passenger.id)) continue;
      if (disruption.cohort && passenger.cohort !== disruption.cohort) continue;
      if (seededRandom(`${this.params.seed}:disruption:${disruption.id}:${passenger.id}`)() >= (disruption.fraction ?? 1)) continue;
      this.disruptCase(passenger.id, disruption); affected++;
    }
    this._log('disruption_wave_observed', { disruptionId: disruption.id, disruptionType: disruption.type, affected });
  }
  _enableService(id) {
    this.services.get(id).enabled = true;
    // Retain each existing assignment; add only the spare airline-assistance pool.
    let spare = this.params.staff - [...this.services.values()].reduce((sum, service) => sum + service.staff, 0);
    for (const service of this.services.values()) if (service.enabled && spare > 0) {
      const extra = Math.min(spare, service.counters - service.staff); service.staff += extra; spare -= extra;
    }
    this._log('workstations_enabled', { serviceId: id, staffAvailable: this.params.staff });
    for (const service of this.services.values()) this._dispatch(service);
  }
  _physicalQueued() { return [...this.services.values()].reduce((sum, service) => sum + service.queue.filter((id) => this.cases.get(id).state === 'physical_queue').length, 0); }
  _advance(time, commit = true) {
    if (commit) { this._physicalQueueArea += this._physicalQueued() * (time - this._accountingTime); this._accountingTime = time; }
    this.time = time;
  }
  step(seconds = 1, snapshotOptions) {
    finite(seconds, 'step seconds'); const target = this.time + seconds; let count = 0;
    while (this.events.peek()?.time <= target) {
      if (++count > 1e6) throw new Error('Too many recovery events in one step');
      const event = this.events.pop(); this._advance(event.time);
      this._processingEvent = true;
      const passenger = this.cases.get(event.data.id);
      if (event.type === 'arrival') this.addCase(event.data);
      else if (event.type === 'disruption') this._applyDisruption(event.data);
      else if (event.type === 'walk_complete') this._walkComplete(passenger, event.data.token);
      else if (event.type === 'movement_entry') this._enterMovementApproach(passenger, event.data.token, event.data.index);
      else if (event.type === 'movement_release' && passenger?.routeToken === event.data.token) {
        passenger.movementWaitUntil = null;
        const request = this._approachRequests.get(passenger.movementRequestId);
        if (request?.status === 'waiting') { request.status = 'released'; request.releasedAt = this.time; this._approachAdmissions++; }
      }
      else if (event.type === 'assistance_complete') this._completeAssistance(passenger, event.data.encounterId);
      else if (event.type === 'callback_expiry') this._callbackExpiry(passenger, event.data.encounterId);
      else if (event.type === 'enable_service') this._enableService(event.data.id);
      else if (event.type.startsWith('relief_')) this._handleReliefEvent(event);
      else if (this._handleExternalEvent) this._handleExternalEvent(event);
      this._processingEvent = false;
      this.spatialPresentation.sync(this);
    }
    this._advance(target, false); return this.snapshot(snapshotOptions);
  }

  positionFor(passengerOrId) {
    const passenger = typeof passengerOrId === 'string' ? this.cases.get(passengerOrId) : passengerOrId;
    if (!passenger) return null;
    if (!passenger.route) return [...this.nodes.get(passenger.currentNodeId).position];
    const origin = this._routeOrigin(passenger);
    return origin.prefix.length ? [...origin.prefix[0].fromPosition] : [...this.nodes.get(origin.nodeId).position];
  }
  _caseSnapshot(passenger, includeEncounters = true, queueIndexes = new Map(), includeDisplay = true) {
    const elapsed = this.time - passenger.stateSince;
    const encounter = passenger.activeEncounter, position = includeDisplay ? this.positionFor(passenger) : null;
    const movementDelaySeconds = passenger.movementDelayIntervals.reduce((n, interval) => n + Math.max(0, Math.min(this.time, interval.until) - interval.from), 0);
    const reliefMovementDelaySeconds = passenger.movementDelayIntervals.filter(interval => interval.state === 'facility_returning').reduce((n, interval) => n + Math.max(0, Math.min(this.time, interval.until) - interval.from), 0);
    return {
      id: passenger.id, caseId: passenger.id, cohort: passenger.cohort, waveId: passenger.waveId, createdAt: passenger.createdAt,
      state: passenger.state, stateSince: passenger.stateSince, position, currentNodeId: passenger.currentNodeId,
      displayAllocation: includeDisplay ? this.spatialPresentation.snapshot(passenger, this.time, position, this) : null,
      movementDelaySeconds,
      movementWaiting: passenger.movementWaitUntil > this.time,
      gateNodeId: passenger.gateNodeId, originNodeId: passenger.originNodeId,
      serviceId: encounter?.serviceId ?? null, encounterId: encounter?.id ?? null,
      encounterNumber: passenger.encounters.length, assistanceCount: passenger.assistanceCount,
      physicalQueueSeconds: passenger.physicalQueueSeconds + (passenger.state === 'physical_queue' ? elapsed : 0),
      assistanceQueueWaitSeconds: passenger.assistanceQueueWaitSeconds + (activeQueueStates.has(passenger.state) ? elapsed : 0),
      totalHelpWaitSeconds: passenger.totalHelpWaitSeconds + (activeHelpStates.has(passenger.state) ? elapsed : 0),
      walkingSeconds: Math.max(0, passenger.walkingSeconds + (walkingStates.has(passenger.state) ? elapsed : 0) - movementDelaySeconds),
      currentEncounterQueueWaitSeconds: encounter ? this._queueWait(passenger) : null,
      priorQueueWaitSeconds: encounter?.priorQueueWaitSeconds ?? this._priorQueueWait(passenger),
      carryoverCreditSeconds: this.params.dispatchPolicy === 'capped_carryover' && encounter ? Math.min(this.params.carryoverCapSeconds, encounter.priorQueueWaitSeconds) : 0,
      currentHelpWaitSeconds: encounter && encounter.assistanceStartedAt === null ? this.time - encounter.openedAt : 0,
      hasPhone: passenger.hasPhone, serverIndex: passenger.serverIndex ?? null,
      profile: clone(passenger.profile), appearance: clone(passenger.appearance), partyId: passenger.partyId, partySize: passenger.partySize,
      reliefGroupId: passenger.reliefGroupId, reliefVisits: clone(passenger.reliefVisits), needsMet: clone(passenger.needsMet),
      unmetNeeds: Object.keys(passenger.profile.needs ?? {}).filter((need) => passenger.profile.needs[need] && !passenger.needsMet[need]),
      reliefUnmetReason: passenger.reliefUnmetReason,
      facilityQueueSeconds: passenger.facilityQueueSeconds + (passenger.state === 'facility_queue' ? elapsed : 0),
      facilityDwellSeconds: passenger.facilityDwellSeconds + (passenger.state === 'facility_dwell' ? elapsed : 0),
      reliefWalkingSeconds: Math.max(0, passenger.reliefWalkingSeconds + (['walking_to_facility', 'facility_returning'].includes(passenger.state) ? elapsed : 0) - reliefMovementDelaySeconds),
      reliefMissedCallbacks: passenger.reliefMissedCallbacks,
      queueRegistrationSequence: encounter?.queueSequence ?? null,
      callbackPending: encounter ? this.services.get(encounter.serviceId)?.pendingCallbacks.has(passenger.id) || this.services.get(encounter.serviceId)?.reserved.has(passenger.id) || false : false,
      queueIndex: queueIndexes.get(passenger.id) ?? -1,
      routeNodeIds: passenger.route?.nodeIds ?? [],
      ticketResolution: 'unknown', travelOutcome: 'unknown', accommodationOutcome: 'unknown',
      disruptions: clone(passenger.disruptions),
      ...(includeEncounters ? { encounters: passenger.encounters.map((entry) => ({ ...entry, queueWaitSeconds: entry === encounter ? this._queueWait(passenger) : entry.queueWaitSeconds })) } : {}),
    };
  }
  // Internal metric input only: never returned as cases/agents. Keep the aggregate
  // fields aligned with _caseSnapshot, including subclass walking-time semantics.
  _caseSummary(passenger) {
    const elapsed = this.time - passenger.stateSince;
    const encounter = passenger.activeEncounter;
    const movementDelaySeconds = passenger.movementDelayIntervals.reduce((n, interval) => n + Math.max(0, Math.min(this.time, interval.until) - interval.from), 0);
    const reliefMovementDelaySeconds = passenger.movementDelayIntervals.filter(interval => interval.state === 'facility_returning').reduce((n, interval) => n + Math.max(0, Math.min(this.time, interval.until) - interval.from), 0);
    return {
      state: passenger.state, cohort: passenger.cohort, partySize: passenger.partySize,
      assistanceCount: passenger.assistanceCount, encounterNumber: passenger.encounters.length,
      encounterId: encounter?.id ?? null,
      physicalQueueSeconds: passenger.physicalQueueSeconds + (passenger.state === 'physical_queue' ? elapsed : 0),
      assistanceQueueWaitSeconds: passenger.assistanceQueueWaitSeconds + (activeQueueStates.has(passenger.state) ? elapsed : 0),
      totalHelpWaitSeconds: passenger.totalHelpWaitSeconds + (activeHelpStates.has(passenger.state) ? elapsed : 0),
      walkingSeconds: Math.max(0, passenger.walkingSeconds + (walkingStates.has(passenger.state) ? elapsed : 0) - movementDelaySeconds),
      currentHelpWaitSeconds: encounter && encounter.assistanceStartedAt === null ? this.time - encounter.openedAt : 0,
      movementDelaySeconds, movementWaiting: passenger.movementWaitUntil > this.time,
      profile: { communicationAccess: passenger.profile.communicationAccess, stepFreeRequired: passenger.profile.stepFreeRequired },
      reliefGroupId: passenger.reliefGroupId,
      // These visits are read synchronously by aggregate reductions; no reference
      // to this internal summary or its visits escapes into the returned result.
      reliefVisits: passenger.reliefVisits,
      unmetNeeds: Object.keys(passenger.profile.needs ?? {}).filter((need) => passenger.profile.needs[need] && !passenger.needsMet[need]),
      reliefMissedCallbacks: passenger.reliefMissedCallbacks,
      facilityQueueSeconds: passenger.facilityQueueSeconds + (passenger.state === 'facility_queue' ? elapsed : 0),
      facilityDwellSeconds: passenger.facilityDwellSeconds + (passenger.state === 'facility_dwell' ? elapsed : 0),
      reliefWalkingSeconds: Math.max(0, passenger.reliefWalkingSeconds + (['walking_to_facility', 'facility_returning'].includes(passenger.state) ? elapsed : 0) - reliefMovementDelaySeconds),
    };
  }
  snapshot({ includeCases = true, includeAgents = includeCases, includeEncounters = true } = {}) {
    const includeDetails = includeCases || includeAgents;
    const queueIndexes = new Map();
    if (includeDetails) for (const service of this.services.values()) this._sortedQueue(service).forEach((id, index) => queueIndexes.set(id, index));
    const cases = [...this.cases.values()].map((passenger) => includeDetails
      ? this._caseSnapshot(passenger, includeEncounters, queueIndexes, includeDetails)
      : this._caseSummary(passenger));
    const counts = {};
    for (const passenger of cases) counts[passenger.state] = (counts[passenger.state] ?? 0) + 1;
    const services = [...this.services.values()].map((service) => ({ id: service.id, nodeId: service.nodeId, label: service.label, proposed: service.proposed, enabled: service.enabled,
      counters: service.counters, staff: service.staff, staffAssigned: service.staff, queued: service.queue.length,
      physicalQueued: service.queue.filter((id) => this.cases.get(id).state === 'physical_queue').length,
      virtualQueued: service.queue.filter((id) => this.cases.get(id).state === 'virtual_queue').length,
      inService: service.busy.size, reserved: service.reserved.size, pendingCallbacks: service.pendingCallbacks.size, protectedAwayTokens: service.awayTokens.size, assistanceCompleted: service.completed, maximumConcurrent: service.maximumConcurrent }));
    const assigned = services.reduce((sum, service) => sum + service.staff, 0);
    const completed = [...this.cases.values()].flatMap((passenger) => passenger.encounters.filter((encounter) => encounter.assistanceCompletedAt !== null));
    const unfinished = cases.filter((passenger) => passenger.encounterId !== null);
    const metrics = {
      generated: cases.length, caseCount: cases.length, ...counts,
      physicalQueued: counts.physical_queue ?? 0, queued: counts.physical_queue ?? 0, virtualQueued: counts.virtual_queue ?? 0,
      inService: counts.assistance ?? 0, callbackReturning: counts.callback_returning ?? 0,
      callbackPending: services.reduce((total, service) => total + service.pendingCallbacks + service.reserved, 0),
      reliefAway: cases.filter((p) => p.reliefGroupId !== null).length,
      reliefVisitsCompleted: cases.reduce((n, p) => n + p.reliefVisits.filter((v) => v.completedAt !== null).length, 0),
      reliefVisitsInterrupted: cases.reduce((n, p) => n + p.reliefVisits.filter((v) => v.outcome === 'interrupted_unmet').length, 0),
      unmetNeedCases: cases.filter((p) => p.unmetNeeds.length > 0).length,
      reliefMissedCallbacks: cases.reduce((n, p) => n + p.reliefMissedCallbacks, 0),
      cumulativeFacilityQueueSeconds: cases.reduce((n, p) => n + p.facilityQueueSeconds, 0),
      cumulativeFacilityDwellSeconds: cases.reduce((n, p) => n + p.facilityDwellSeconds, 0),
      cumulativeReliefWalkingSeconds: cases.reduce((n, p) => n + p.reliefWalkingSeconds, 0),
      assistanceCompleted: this._assistanceCompleted, distinctCasesAssisted: cases.filter((passenger) => passenger.assistanceCount > 0).length,
      encountersOpened: cases.reduce((sum, passenger) => sum + passenger.encounterNumber, 0),
      casesWithRepeatedEncounters: cases.filter((passenger) => passenger.encounterNumber > 1).length,
      unresolvedHelp: unfinished.length, awaitingRecovery: cases.length - unfinished.length,
      resolutionUnknown: cases.length, ticketResolutions: null, confirmedSeats: null, flightDepartures: null, hotelPlacements: null,
      observedDisruptions: this._disruptionsObserved, coalescedDisruptions: this._coalescedDisruptions,
      cumulativePhysicalQueueSeconds: cases.reduce((sum, passenger) => sum + passenger.physicalQueueSeconds, 0),
      cumulativeAssistanceQueueWaitSeconds: cases.reduce((sum, passenger) => sum + passenger.assistanceQueueWaitSeconds, 0),
      cumulativeTotalHelpWaitSeconds: cases.reduce((sum, passenger) => sum + passenger.totalHelpWaitSeconds, 0),
      cumulativeMovementDelaySeconds: cases.reduce((sum, passenger) => sum + passenger.movementDelaySeconds, 0),
      movementWaitingCases: cases.filter(passenger => passenger.movementWaiting).length,
      meanCumulativePhysicalQueueSeconds: mean(cases.map((passenger) => passenger.physicalQueueSeconds)),
      p95CumulativePhysicalQueueSeconds: percentile(cases.map((passenger) => passenger.physicalQueueSeconds)),
      meanCumulativeHelpWaitSeconds: mean(cases.map((passenger) => passenger.totalHelpWaitSeconds)),
      p95CumulativeHelpWaitSeconds: percentile(cases.map((passenger) => passenger.totalHelpWaitSeconds)),
      meanCompletedEncounterQueueWaitSeconds: mean(completed.map((encounter) => encounter.queueWaitSeconds)),
      p95CompletedEncounterQueueWaitSeconds: percentile(completed.map((encounter) => encounter.queueWaitSeconds)),
      completedWaitSampleSize: completed.length, oldestCurrentHelpWaitSeconds: Math.max(0, ...cases.map((passenger) => passenger.currentHelpWaitSeconds)),
      maximumPhysicalQueue: this._maximumQueue,
      timeWeightedMeanPhysicalQueue: this.time ? (this._physicalQueueArea + this._physicalQueued() * (this.time - this._accountingTime)) / this.time : 0,
      staffAvailable: this.params.staff, staffAssigned: assigned, staffUnassigned: this.params.staff - assigned,
      workstationsEnabled: services.reduce((sum, service) => sum + (service.enabled ? service.counters : 0), 0),
      nominalCapacityPerHour: assigned * 3600 / this.params.serviceMeanSeconds,
      conservation: cases.length === Object.values(counts).reduce((sum, value) => sum + value, 0),
    };
    const cohorts = [...new Set(cases.map((passenger) => passenger.cohort))].map((cohort) => {
      const group = cases.filter((passenger) => passenger.cohort === cohort);
      return { cohort, caseCount: group.length, assistedCases: group.filter((passenger) => passenger.assistanceCount > 0).length,
        assistanceCompleted: group.reduce((sum, passenger) => sum + passenger.assistanceCount, 0),
        unresolvedHelp: group.filter((passenger) => passenger.encounterId !== null).length,
        repeatedCases: group.filter((passenger) => passenger.encounterNumber > 1).length,
        meanCumulativePhysicalQueueSeconds: mean(group.map((passenger) => passenger.physicalQueueSeconds)),
        meanCumulativeHelpWaitSeconds: mean(group.map((passenger) => passenger.totalHelpWaitSeconds)),
        resolutionUnknown: group.length, flightDepartures: null };
    });
    const encounterCohorts = ['first_visit', 'repeat_visit'].map((cohort) => {
      const group = [...this.cases.values()].flatMap((passenger) => passenger.encounters).filter((encounter) => cohort === 'first_visit' ? encounter.number === 1 : encounter.number > 1);
      const finished = group.filter((encounter) => encounter.assistanceCompletedAt !== null);
      return { cohort, encounters: group.length, assistanceCompleted: finished.length, unresolvedHelp: group.length - finished.length,
        meanCompletedQueueWaitSeconds: mean(finished.map((encounter) => encounter.queueWaitSeconds)), p95CompletedQueueWaitSeconds: percentile(finished.map((encounter) => encounter.queueWaitSeconds)) };
    });
    const unimplemented = (label) => ({ implemented: false, available: null, status: 'unimplemented', label });
    const behavioralSummary = (label, group) => ({ label, caseCount: group.length, assistanceCompleted: group.reduce((n, p) => n + p.assistanceCount, 0),
      unresolvedHelp: group.filter((p) => p.encounterId !== null).length, meanPhysicalQueueSeconds: mean(group.map((p) => p.physicalQueueSeconds)),
      meanTotalHelpWaitSeconds: mean(group.map((p) => p.totalHelpWaitSeconds)), meanWalkingSeconds: mean(group.map((p) => p.walkingSeconds)),
      unmetNeedCases: group.filter((p) => p.unmetNeeds.length).length, missedReliefCallbacks: group.reduce((n, p) => n + p.reliefMissedCallbacks, 0) });
    const result = {
      time: this.time, synthetic: true, calibrated: false, notice: RECOVERY_NOTICE,
      movementTiming: { model: this.params.movementModel, scope: 'A assistance approach a_2 to service_a only',
        approachCapacityPerMinute: this.params.approachCapacityPerMinute, approachObstructionFactor: this.params.approachObstructionFactor,
        effectiveCapacityPerMinute: this.params.approachCapacityPerMinute * this.params.approachObstructionFactor,
        approachAdmissions: this._approachAdmissions, distinctDelayedCases: this._approachDelayedCases.size,
        approachRequests: this._approachRequests.size, approachArrivals: this._approachArrivals,
        pendingReservations: [...this._approachRequests.values()].filter(request => request.status === 'waiting').length,
        cancelledRequests: [...this._approachRequests.values()].filter(request => request.status === 'cancelled').length,
        cancellationPolicy: 'A cancelled pending request stops accumulating delay; its unused metering slot is not backfilled. Current public help cancellation coalesces and does not cancel the approach.',
        cumulativeDelaySeconds: metrics.cumulativeMovementDelaySeconds, waitingCases: metrics.movementWaitingCases,
        assumption: 'Synthetic FIFO metered-entry headway, not a measured density/speed curve or whole-terminal pedestrian model. Holding-slot animation is separate.' },
      experiment: 'persistent-recovery-assistance', dispatchPolicy: this.params.dispatchPolicy, callbackPolicy: this.params.callbackPolicy, reliefReturnPolicy: this.params.reliefReturnPolicy,
      implementation: { ...RECOVERY_IMPLEMENTATION, behavioralProfilesEnabled: !!this.params.behaviorProfiles, reliefVisitsEnabled: !!this.params.reliefVisits,
        partyReliefCohesion: true, fullPartyFlightHotelAllocation: false, liftCapacity: false, facilityInteriorAccessValidation: false },
      routingInformation: this.params.routing === 'least_expected_delay' ? 'idealized_informed_global_current_queue' : 'nearest_reachable',
      metrics, services, cohorts, encounterCohorts, callbacks: { ...this._callbackCounts },
      behaviorCohorts: [
        ...['own_phone', 'assisted_only'].map((access) => behavioralSummary(`communication:${access}`, cases.filter((p) => p.profile.communicationAccess === access))),
        ...[true, false].map((required) => behavioralSummary(`step_free:${required}`, cases.filter((p) => p.profile.stepFreeRequired === required))),
        behavioralSummary('party:group', cases.filter((p) => p.partySize > 1)), behavioralSummary('party:solo', cases.filter((p) => p.partySize === 1)),
      ],
      facilities: [...this.facilities.values()].map((f) => ({ id: f.id, nodeId: f.nodeId, functions: clone(f.functions), capacityPersonsAssumed: f.capacityPersons,
        dwellSecondsAssumed: f.dwellSeconds, occupants: [...f.occupants.keys()].flatMap((id) => this.reliefGroups.get(id).memberIds),
        occupancy: [...f.occupants.values()].reduce((a, b) => a + b, 0), queueGroups: f.queue.length, queuePeople: f.queue.reduce((n, id) => n + this.reliefGroups.get(id).memberIds.length, 0),
        maximumOccupancy: f.maximumOccupancy, completedGroupVisits: f.visitsCompleted, syntheticCapacity: true })),
      reliefGroups: [...this.reliefGroups.values()].map(({ profile, arrived, returned, ...group }) => ({ ...clone(group), arrivedCaseIds: [...arrived], returnedCaseIds: [...returned] })),
      resources: {
        airlineAssistance: { implemented: true, available: this.params.staff, assigned, unassigned: this.params.staff - assigned, workstations: metrics.workstationsEnabled, busy: metrics.inService, reserved: services.reduce((sum, service) => sum + service.reserved, 0), pendingCallbackTokens: services.reduce((sum, service) => sum + service.pendingCallbacks, 0) },
        airportSecurity: unimplemented('Separate security staff and lanes'), groundHandling: unimplemented('Separate ground handling pool'),
        operatingCrew: unimplemented('Flight crew availability; no compliance claim'), aircraft: unimplemented('Aircraft readiness'), catering: unimplemented('Catering readiness'),
        hotelRooms: unimplemented('Hotel eligibility and finite room inventory'), transport: unimplemented('Vehicles, seats and travel'),
      },
      observedEvents: clone(this._observedEvents),
      metricSemantics: {
        assistanceCompleted: 'Completed encounters; a passenger can have several. Not resolved tickets.',
        unresolvedHelp: 'Cases with an open assistance encounter, including active assistance. Not ticket inventory.',
        resolutionUnknown: 'Every case retains unknown ticket and travel outcomes.',
        physicalQueueSeconds: 'Time physically queued across visits; excludes walking, virtual waiting, assistance and gate holding.',
        assistanceQueueWaitSeconds: 'Physical plus virtual queue time; excludes walking, callback return/no-show grace, gate holding and assistance.',
        totalHelpWaitSeconds: 'Elapsed pre-assistance waiting across visits, including movement, callback waiting and queueing; excludes assistance and holding after assistance.',
        carryoverCreditSeconds: 'Capped prior completed-encounter assistance-queue waiting only. No gate, walking or assistance time, and no blanket returner priority.',
        callbackPending: 'Outstanding invitations or explicitly reserved callbacks. Work-conserving tokens preserve registration/accrued queue credit but consume no workstation or staff; returning cases do not preempt active assistance.',
        facilityQueueSeconds: 'Waiting for a finite relief-facility place, distinct from assistance queue credit; included in total pre-assistance help elapsed time.',
        facilityDwellSeconds: 'Time using a relief facility; included in pre-assistance elapsed time, not assistance-queue credit. It may have positive relief value and is not necessarily wasted time.',
        behaviorCohorts: 'Overlapping descriptive strata. Compare within each dimension; do not add communication, mobility and party groups as distinct people.',
      },
    };
    if (includeCases) result.cases = cases;
    if (includeAgents) result.agents = cases;
    return result;
  }
  assertInvariants() {
    const requests = [...this._approachRequests.values()], released = requests.filter(request => request.status === 'released');
    if (requests.length !== released.length + requests.filter(request => request.status === 'waiting').length + requests.filter(request => request.status === 'cancelled').length) throw new Error('Approach request accounting failed');
    if (released.length !== this._approachAdmissions || released.filter(request => request.arrivedAt !== null).length !== this._approachArrivals) throw new Error('Approach release/arrival accounting failed');
    const members = new Set();
    for (const service of this.services.values()) {
      if (service.staff > service.counters || service.busy.size + service.reserved.size > service.staff) throw new Error('Airline-assistance capacity exceeded');
      if (service.pendingCallbacks.size > service.staff) throw new Error('Outstanding callback invitation limit exceeded');
      if (this.params.callbackPolicy === 'work_conserving' && service.reserved.size) throw new Error('Work-conserving callback reserved a workstation');
      const slots = [...service.busy.values(), ...service.reserved.values()];
      if (new Set(slots).size !== slots.length) throw new Error('Workstation assigned twice');
      for (const id of [...service.queue, ...service.busy.keys(), ...service.reserved.keys(), ...service.pendingCallbacks.keys(), ...service.awayTokens.keys()]) {
        if (members.has(id)) throw new Error('Case occupies multiple queue/service resources'); members.add(id);
        const passenger = this.cases.get(id);
        if (!passenger || passenger.activeEncounter?.serviceId !== service.id) throw new Error('Incorrect case service membership');
        if (service.queue.includes(id) && !activeQueueStates.has(passenger.state)) throw new Error('Incorrect queue state');
        if (service.busy.has(id) && passenger.state !== 'assistance') throw new Error('Incorrect assistance state');
        if (service.reserved.has(id) && !['callback_returning', 'callback_no_show_pending'].includes(passenger.state)) throw new Error('Incorrect callback reservation state');
        if (service.pendingCallbacks.has(id) && !['callback_returning', 'callback_no_show_pending'].includes(passenger.state)) throw new Error('Incorrect protected callback token state');
        if (service.awayTokens.has(id) && (!reliefStates.has(passenger.state) || passenger.reliefGroupId !== service.awayTokens.get(id))) throw new Error('Incorrect relief token state');
      }
      if (this.params.callbackPolicy === 'work_conserving' && service.enabled && service.busy.size < service.staff && service.queue.some((id) => this.cases.get(id).state === 'physical_queue')) throw new Error('Idle assistance capacity while a ready case waits');
    }
    for (const passenger of this.cases.values()) {
      const open = passenger.encounters.filter((encounter) => encounter.assistanceCompletedAt === null);
      if (open.length > 1 || open.length !== Number(passenger.activeEncounter !== null)) throw new Error('Concurrent or missing case encounter');
      if ((activeQueueStates.has(passenger.state) || reliefStates.has(passenger.state) || ['assistance', 'callback_returning', 'callback_no_show_pending'].includes(passenger.state)) && !members.has(passenger.id)) throw new Error('Case missing service membership');
      if (passenger.encounters.some((encounter) => encounter.queueWaitSeconds < -EPS)) throw new Error('Negative queue waiting');
      if (passenger.ticketResolution !== 'unknown' || passenger.travelOutcome !== 'unknown') throw new Error('Unimplemented travel outcome inferred');
    }
    const facilityMembers = new Set();
    for (const facility of this.facilities.values()) {
      const occupancy = [...facility.occupants.values()].reduce((a, b) => a + b, 0);
      if (occupancy > facility.capacityPersons || facility.maximumOccupancy > facility.capacityPersons) throw new Error('Relief facility person capacity exceeded');
      for (const groupId of [...facility.queue, ...facility.occupants.keys()]) {
        const group = this.reliefGroups.get(groupId);
        if (!group || group.facilityId !== facility.id || !['queued', 'dwell'].includes(group.state)) throw new Error('Relief facility group membership');
        for (const id of group.memberIds) { if (facilityMembers.has(id)) throw new Error('Case duplicated between relief facilities'); facilityMembers.add(id); }
      }
    }
    for (const group of this.reliefGroups.values()) {
      if (new Set(group.memberIds).size !== group.memberIds.length) throw new Error('Duplicate party member');
      if (group.state !== 'returned' && group.memberIds.some((id) => this.cases.get(id).reliefGroupId !== group.id)) throw new Error('Relief party split/lost');
      if (['queued', 'dwell'].includes(group.state) && group.memberIds.some((id) => !facilityMembers.has(id))) throw new Error('Party absent from finite facility');
    }
    const snapshot = this.snapshot({ includeCases: false, includeAgents: false, includeEncounters: false }), m = snapshot.metrics;
    if (!m.conservation || m.staffAssigned > m.staffAvailable || m.staffAssigned + m.staffUnassigned !== m.staffAvailable) throw new Error('Case/staff conservation failed');
    if (m.encountersOpened !== m.assistanceCompleted + m.unresolvedHelp) throw new Error('Encounter conservation failed');
    if (m.cumulativePhysicalQueueSeconds > m.cumulativeAssistanceQueueWaitSeconds + EPS || m.cumulativeAssistanceQueueWaitSeconds > m.cumulativeTotalHelpWaitSeconds + EPS) throw new Error('Waiting clock containment failed');
    return true;
  }
}

/** Reads only current/past observations; never inspects the scheduled future event queue. */
export function observeRecovery(snapshot, history = []) {
  const m = snapshot.metrics, past = history.filter((sample) => sample.time < snapshot.time && sample.time >= snapshot.time - 300);
  const first = past[0], delta = first ? m.physicalQueued - first.metrics.physicalQueued : null;
  const observations = [
    { kind: 'observation', id: 'case-continuity', text: `${m.caseCount} cases; ${m.casesWithRepeatedEncounters} have repeated encounters. ${m.assistanceCompleted} assistance sessions completed; travel outcomes remain unknown for all ${m.resolutionUnknown} cases.` },
    { kind: 'observation', id: 'waiting-clocks', text: `${m.physicalQueued} physically queued; ${m.virtualQueued} virtually queued. Physical and total help waiting are reported separately.` },
  ];
  if (delta !== null) observations.push({ kind: 'observation', id: 'physical-queue-trend', delta, windowSeconds: snapshot.time - first.time, text: `The physical queue changed by ${delta} over the observed interval.` });
  if (snapshot.implementation.reliefVisitsEnabled) observations.push({ kind: 'observation', id: 'relief-needs', text: `${m.reliefVisitsCompleted} person visits completed; ${m.unmetNeedCases} cases retain an unmet declared need. ${m.reliefMissedCallbacks} case callback windows were missed. Facility waiting, dwell, walking and assistance queue credit are distinct clocks.` });
  const recommendations = [];
  if (m.staffUnassigned > 0 && m.queued + m.virtualQueued > 0 && m.staffAssigned === m.workstationsEnabled) recommendations.push({ kind: 'hypothesis', id: 'equipped-workstations', rule: 'queue-and-spare-airline-staff-at-workstation-cap', text: 'Compare equipped workstations using the same airline-assistance staff pool. Other airport and flight staff are not interchangeable.' });
  if (m.casesWithRepeatedEncounters > 0) recommendations.push({ kind: 'hypothesis', id: 'capped-credit-comparison', rule: 'repeated-encounters-observed', text: 'Compare per-visit FIFO with capped prior assistance-queue credit; inspect first/repeat visits and incoming/existing cohorts. No policy is declared fairer by the observer.' });
  return { time: snapshot.time, synthetic: true, observations, recommendations, futureScheduleInspected: false,
    routingInformation: snapshot.routingInformation,
    limitation: 'No ticket, flight, hotel, transport or security feasibility is modeled here. Less physical queueing does not establish less total waiting. Informed routing uses idealized current global queue information, not measured passenger knowledge.' };
}
