/**
 * HIA spatial study: a deliberately synthetic, uncalibrated queue demonstration.
 * Time is seconds, distance is metres, rates are passengers per minute.
 *
 * Graph: {nodes:[{id,position:[x,y,z],kind:'gate',spawnWeight}],
 *         edges:[{from,to,lengthMeters,directed?,stepFree?,allowedAccess?}],
 *         services:[{id,nodeId,staff,counters?,enabled?,label?,proposed?}]}.
 * A numeric params.staff is the available trained-staff POOL. Enabled equipped
 * counters limit assignment; unused staff remain available without creating capacity.
 * Graph access boundaries must be explicitly encoded; this is not a navigation aid.
 * Assistance completion is not ticket resolution, seat allocation or travel recovery.
 * process_exited means leaving this modeled assistance process, never a flight departure.
 */
export const SIMULATION_NOTICE = 'Synthetic, uncalibrated demonstration. Desk assistance completion does not confirm rebooking, a seat, accommodation or flight departure. Process exits only leave the modeled assistance process. Outputs are not an operational forecast.';

export const SIMULATION_METRIC_SEMANTICS = Object.freeze({
  assistanceCompleted: 'Desk assistance sessions completed; travel resolution remains unknown.',
  served: 'Compatibility alias for assistanceCompleted, not successful rebookings.',
  completed: 'Compatibility alias for assistanceCompleted, not resolved journeys.',
  unresolvedHelp: 'Help-seeking passengers who have not completed desk assistance.',
  unresolved: 'Compatibility alias for unresolvedHelp, not unresolved ticket inventory.',
  resolutionUnknown: 'All help-seeking passengers; no ticket, seat or accommodation resolution is modeled, including after assistance.',
  assistedResolutionUnknown: 'Assisted passengers whose ticket, seat and accommodation outcomes remain unknown.',
  processExited: 'Passengers who left the modeled assistance/holding process only; no airport exit or flight departure is implied.',
  staffAvailable: 'Assumed available trained-staff pool, including assigned and unassigned staff.',
  staffAssigned: 'Staff currently assigned or finishing assistance at enabled workstations; cannot exceed the pool.',
  staffUnassigned: 'Available trained staff without an assigned workstation.',
  workstationsEnabled: 'Configured enabled workstation count; null if any count is unspecified.',
  nominalCapacityPerHour: 'Assigned staff divided by assumed mean assistance time; not measured throughput or resolved journeys.',
});

const EPS = 1e-8;
const DEFAULTS = Object.freeze({
  seed: 23062025,
  arrivalRatePerMinute: 6,
  surgeMultiplier: 2.5,
  surgeStartSeconds: 0,
  surgeDurationSeconds: 90 * 60,
  needsHelpFraction: 0.35,
  serviceMeanSeconds: 8 * 60,
  serviceDistribution: 'fixed',
  serviceCoefficientOfVariation: 0.6,
  walkingSpeedMps: 1.2,
  processExitDelaySeconds: 5 * 60,
  routing: 'nearest',
  accessClass: 'airside',
  stepFree: false,
});

function hashSeed(value) {
  if (typeof value === 'number') return value >>> 0;
  let hash = 2166136261;
  for (const c of String(value)) hash = Math.imul(hash ^ c.charCodeAt(0), 16777619);
  return hash >>> 0;
}

export function seededRandom(seed = DEFAULTS.seed) {
  let state = hashSeed(seed);
  return () => {
    state = (state + 0x6D2B79F5) | 0;
    let x = state;
    x = Math.imul(x ^ (x >>> 15), x | 1);
    x ^= x + Math.imul(x ^ (x >>> 7), x | 61);
    return ((x ^ (x >>> 14)) >>> 0) / 4294967296;
  };
}

function finite(value, name, minimum = 0) {
  if (!Number.isFinite(value) || value < minimum) throw new Error(`${name} must be finite and >= ${minimum}`);
  return value;
}

function integer(value, name) {
  finite(value, name);
  if (!Number.isInteger(value)) throw new Error(`${name} must be an integer`);
  return value;
}

function positionOf(node) {
  const p = node.position ?? node.coordinates ?? node.pos;
  const result = Array.isArray(p) ? [p[0] ?? 0, p[1] ?? 0, p[2] ?? 0]
    : p && typeof p === 'object' ? [p.x ?? 0, p.y ?? 0, p.z ?? 0]
      : [node.x ?? 0, node.y ?? 0, node.z ?? 0];
  if (result.some((v) => !Number.isFinite(v))) throw new Error(`Invalid position for node ${node.id}`);
  return result;
}

class EventHeap {
  constructor() { this.items = []; }
  earlier(a, b) { return a.time < b.time || (a.time === b.time && (a.priority < b.priority || (a.priority === b.priority && a.sequence < b.sequence))); }
  push(event) {
    const a = this.items;
    a.push(event);
    let i = a.length - 1;
    while (i > 0) {
      const parent = (i - 1) >> 1;
      if (!this.earlier(a[i], a[parent])) break;
      [a[i], a[parent]] = [a[parent], a[i]];
      i = parent;
    }
  }
  peek() { return this.items[0]; }
  pop() {
    const a = this.items;
    if (!a.length) return undefined;
    const first = a[0], last = a.pop();
    if (a.length) {
      a[0] = last;
      let i = 0;
      for (;;) {
        const left = i * 2 + 1, right = left + 1;
        let best = i;
        if (left < a.length && this.earlier(a[left], a[best])) best = left;
        if (right < a.length && this.earlier(a[right], a[best])) best = right;
        if (best === i) break;
        [a[i], a[best]] = [a[best], a[i]];
        i = best;
      }
    }
    return first;
  }
}

/** Seeded discrete-event engine. step(n) has the same result as n calls to step(1). */
export class RebookingSimulation {
  constructor(graph = {}, params = {}) {
    this.params = { ...DEFAULTS, ...params };
    if (params.arrivalsPerMinute !== undefined && params.arrivalRatePerMinute === undefined) this.params.arrivalRatePerMinute = params.arrivalsPerMinute;
    if (params.serviceMeanMinutes !== undefined && params.serviceMeanSeconds === undefined) this.params.serviceMeanSeconds = params.serviceMeanMinutes * 60;
    // Legacy name describes model retention only; it never schedules an onward flight.
    if (params.onwardDwellSeconds !== undefined && params.processExitDelaySeconds === undefined) this.params.processExitDelaySeconds = params.onwardDwellSeconds;
    this._validateParameters();
    const rawNodes = Array.isArray(graph.nodes) ? graph.nodes : Object.entries(graph.nodes ?? {}).map(([id, node]) => ({ id, ...node }));
    this.nodes = new Map();
    for (const raw of rawNodes) {
      if (raw.id === undefined) throw new Error('Every graph node needs an id');
      const id = String(raw.id);
      if (this.nodes.has(id)) throw new Error(`Duplicate graph node ${id}`);
      this.nodes.set(id, { ...raw, id, position: positionOf(raw) });
    }
    if (!this.nodes.size) throw new Error('Simulation needs at least one graph node');
    this.adjacency = new Map([...this.nodes.keys()].map((id) => [id, []]));
    this.edges = [];
    for (const rawEdge of graph.edges ?? []) {
      const edge = Array.isArray(rawEdge) ? { from: rawEdge[0], to: rawEdge[1], lengthMeters: rawEdge[2] } : rawEdge;
      const from = String(edge.from ?? edge.source ?? edge.a), to = String(edge.to ?? edge.target ?? edge.b);
      if (!this.nodes.has(from) || !this.nodes.has(to)) throw new Error(`Unknown edge endpoint ${from} → ${to}`);
      const a = this.nodes.get(from).position, b = this.nodes.get(to).position;
      const lengthMeters = edge.lengthMeters ?? edge.distanceMeters ?? edge.length ?? edge.distance ?? Math.hypot(...a.map((v, i) => v - b[i]));
      finite(lengthMeters, 'edge length');
      if (edge.durationSeconds !== undefined) finite(edge.durationSeconds, 'edge duration');
      const normalized = { ...edge, from, to, lengthMeters };
      this.edges.push(normalized);
      this.adjacency.get(from).push(normalized);
      if (!edge.directed && !edge.oneWay) this.adjacency.get(to).push({ ...normalized, from: to, to: from });
    }
    this.services = new Map();
    for (const [index, raw] of (graph.services ?? []).entries()) {
      const id = String(raw.id ?? `service-${index}`), nodeId = String(raw.nodeId ?? raw.node ?? raw.location);
      if (this.services.has(id)) throw new Error(`Duplicate service ${id}`);
      if (!this.nodes.has(nodeId)) throw new Error(`Unknown service node ${nodeId}`);
      const initialStaff = integer(raw.staff ?? 2, `staff for ${id}`);
      const staff = raw.enabled === false ? 0 : initialStaff;
      const counters = raw.counters === undefined || raw.counters === null ? Infinity : integer(raw.counters, `counters for ${id}`);
      if (staff > counters) throw new Error(`Staff exceeds physical counters at ${id}`);
      if (raw.proposed && !Number.isFinite(counters)) throw new Error(`Proposed service ${id} needs an explicit workstation count`);
      this.services.set(id, { ...raw, id, nodeId, staff, requestedStaff: staff, counters, enabled: raw.enabled !== false, queue: [], inService: new Set(), served: 0, maxQueue: 0, queueAreaSeconds: 0, busyAreaSeconds: 0, staffAreaSeconds: 0, maximumConcurrent: 0, grandfatheredLimit: staff });
    }
    this.time = 0;
    this._accountingTime = 0;
    this.agents = new Map();
    this._events = new EventHeap();
    this._eventSequence = 0;
    this._nextAgentId = 1;
    this._routeCache = new Map();
    this._arrivalRng = seededRandom(`${this.params.seed}:arrival-times`);
    this._completedWaits = [];
    this._served = 0;
    this._needsHelp = 0;
    this._bypassed = 0;
    this._maxQueue = 0;
    this._queueAreaSeconds = 0;
    this._interventionApplied = false;
    this.origins = this._getOrigins();
    this.staffAvailable = [...this.services.values()].reduce((sum, service) => sum + service.staff, 0);
    if (params.staff !== undefined) this._allocateTotalStaff(params.staff);
    if (params.staffByService) {
      // Without an explicit pool, initial per-desk staffing defines that pool.
      if (params.staff === undefined) this.staffAvailable = [...this.services.values()].reduce((sum, service) => sum + (params.staffByService[service.id] ?? service.requestedStaff), 0);
      this._applyStaffMap(params.staffByService);
    }
    this._scheduleNextArrival(0);
    if (this.params.intervention) {
      finite(this.params.intervention.atSeconds ?? 1800, 'intervention time');
      this._schedule('intervention', this.params.intervention.atSeconds ?? 1800, {}, 0);
    }
  }

  _validateParameters() {
    const p = this.params;
    for (const key of ['arrivalRatePerMinute', 'surgeMultiplier', 'surgeStartSeconds', 'surgeDurationSeconds', 'processExitDelaySeconds', 'serviceCoefficientOfVariation']) finite(p[key], key);
    for (const key of ['walkingSpeedMps', 'serviceMeanSeconds']) finite(p[key], key, 0.000001);
    if (p.postSurgeRatePerMinute !== undefined) finite(p.postSurgeRatePerMinute, 'postSurgeRatePerMinute');
    finite(p.needsHelpFraction, 'needsHelpFraction');
    if (p.needsHelpFraction > 1) throw new Error('needsHelpFraction must be <= 1');
    if (!['fixed', 'exponential', 'lognormal'].includes(p.serviceDistribution)) throw new Error('Unknown service distribution');
    if (!['nearest', 'least_expected_delay'].includes(p.routing)) throw new Error('Unknown routing policy');
  }

  _getOrigins() {
    const selected = this.params.origins ?? [...this.nodes.values()].filter((n) => n.kind === 'gate' || n.type === 'gate' || n.spawn === true || n.spawnWeight > 0);
    const candidates = selected.length ? selected : [this.nodes.values().next().value];
    const origins = candidates.map((n) => typeof n === 'string' ? { nodeId: n, weight: 1 }
      : { nodeId: String(n.nodeId ?? n.id), weight: n.weight ?? n.spawnWeight ?? 1 });
    for (const origin of origins) {
      if (!this.nodes.has(origin.nodeId)) throw new Error(`Unknown origin ${origin.nodeId}`);
      finite(origin.weight, 'origin weight');
    }
    if (!origins.some((o) => o.weight > 0)) throw new Error('At least one origin needs positive weight');
    return origins;
  }

  _schedule(type, time, data = {}, priority = 2) {
    if (Number.isFinite(time)) this._events.push({ type, time, ...data, priority, sequence: this._eventSequence++ });
  }

  arrivalRateAt(seconds) {
    const p = this.params, end = p.surgeStartSeconds + p.surgeDurationSeconds;
    if (seconds >= p.surgeStartSeconds && seconds < end) return p.arrivalRatePerMinute * p.surgeMultiplier;
    if (seconds >= end && p.postSurgeRatePerMinute !== undefined) return p.postSurgeRatePerMinute;
    return p.arrivalRatePerMinute;
  }

  _scheduleNextArrival(fromTime) {
    let hazard = -Math.log(Math.max(1e-12, 1 - this._arrivalRng()));
    let cursor = fromTime;
    const boundaries = [this.params.surgeStartSeconds, this.params.surgeStartSeconds + this.params.surgeDurationSeconds].filter((t) => t > cursor + EPS).sort((a, b) => a - b);
    for (const boundary of [...new Set(boundaries), Infinity]) {
      const rate = this.arrivalRateAt(cursor + EPS) / 60;
      const width = boundary - cursor;
      if (rate > 0 && hazard / rate < width) {
        this._schedule('arrival', cursor + hazard / rate, {}, 3);
        return;
      }
      if (!Number.isFinite(boundary)) return;
      hazard -= rate * width;
      cursor = boundary;
    }
  }

  _edgeAllowed(edge, options) {
    if (edge.disabled || edge.restricted) return false;
    if (options.stepFree && edge.stepFree === false) return false;
    const allowed = edge.allowedAccess ?? edge.accessClasses;
    return !allowed || !options.accessClass || allowed.includes(options.accessClass);
  }

  /** Returns null for unreachable destinations. Explicit edge durations override walking time. */
  shortestPath(fromId, toId, options = {}) {
    const from = String(fromId), to = String(toId);
    if (!this.nodes.has(from) || !this.nodes.has(to)) return null;
    const opt = { accessClass: this.params.accessClass, stepFree: this.params.stepFree, ...options };
    const key = `${from}|${to}|${opt.accessClass}|${opt.stepFree}`;
    if (this._routeCache.has(key)) return this._routeCache.get(key);
    const times = new Map([[from, 0]]), previous = new Map(), unsettled = new Set(this.nodes.keys());
    while (unsettled.size) {
      let current = null, best = Infinity;
      for (const id of unsettled) if ((times.get(id) ?? Infinity) < best) { current = id; best = times.get(id); }
      if (current === null) break;
      unsettled.delete(current);
      if (current === to) break;
      for (const edge of this.adjacency.get(current)) {
        if (!unsettled.has(edge.to) || !this._edgeAllowed(edge, opt)) continue;
        const durationSeconds = edge.durationSeconds ?? edge.lengthMeters / this.params.walkingSpeedMps;
        const candidate = best + durationSeconds;
        if (candidate < (times.get(edge.to) ?? Infinity) - EPS) {
          times.set(edge.to, candidate);
          previous.set(edge.to, { edge, durationSeconds });
        }
      }
    }
    if (!times.has(to)) { this._routeCache.set(key, null); return null; }
    const segments = [];
    let cursor = to;
    while (cursor !== from) {
      const step = previous.get(cursor);
      if (!step) return null;
      segments.unshift({ from: step.edge.from, to: step.edge.to, distanceMeters: step.edge.lengthMeters, durationSeconds: step.durationSeconds });
      cursor = step.edge.from;
    }
    const path = { nodeIds: [from, ...segments.map((s) => s.to)], segments, distanceMeters: segments.reduce((sum, s) => sum + s.distanceMeters, 0), durationSeconds: times.get(to) };
    this._routeCache.set(key, path);
    return path;
  }

  _serviceDuration(rng) {
    const p = this.params;
    if (p.serviceDistribution === 'fixed') return p.serviceMeanSeconds;
    if (p.serviceDistribution === 'exponential') return Math.max(0.001, -Math.log(Math.max(1e-12, 1 - rng())) * p.serviceMeanSeconds);
    const sigma2 = Math.log(1 + p.serviceCoefficientOfVariation ** 2);
    const normal = Math.sqrt(-2 * Math.log(Math.max(1e-12, rng()))) * Math.cos(2 * Math.PI * rng());
    return Math.max(0.001, p.serviceMeanSeconds * Math.exp(-sigma2 / 2 + Math.sqrt(sigma2) * normal));
  }

  _chooseService(agent, requestedId) {
    let result = null, best = Infinity;
    for (const service of this.services.values()) {
      if (!service.enabled || (requestedId !== undefined && service.id !== String(requestedId))) continue;
      const route = this.shortestPath(agent.originNodeId, service.nodeId);
      if (!route) continue;
      const nominalWait = service.staff > 0 ? (service.queue.length + service.inService.size) * this.params.serviceMeanSeconds / service.staff : 1e9;
      const score = route.durationSeconds + (this.params.routing === 'least_expected_delay' ? nominalWait : 0);
      if (score < best) { best = score; result = { service, route }; }
    }
    return result;
  }

  /** Optional explicit synthetic arrivals, useful for demonstrations and invariant tests. */
  addPassenger(options = {}) {
    this._advanceClock(this.time);
    const id = `p${this._nextAgentId++}`;
    // Passenger-specific draws keep case mix identical when policy changes service order.
    const rng = seededRandom(`${this.params.seed}:passenger:${id}`);
    const totalWeight = this.origins.reduce((sum, o) => sum + o.weight, 0);
    let target = rng() * totalWeight, origin = this.origins.at(-1).nodeId;
    for (const candidate of this.origins) { target -= candidate.weight; if (target < 0) { origin = candidate.nodeId; break; } }
    const helpDraw = rng();
    const sampledDuration = this._serviceDuration(rng);
    const originNodeId = String(options.originNodeId ?? origin);
    if (!this.nodes.has(originNodeId)) throw new Error(`Unknown passenger origin ${originNodeId}`);
    const agent = { id, originNodeId, currentNodeId: originNodeId, arrivalTime: this.time, state: 'waiting', needsHelp: options.needsHelp ?? helpDraw < this.params.needsHelpFraction, helpDraw, serviceSeconds: options.serviceSeconds ?? sampledDuration, serviceId: null, queueJoinedAt: null, serviceStartedAt: null, serviceCompletedAt: null, processExitedAt: null, resolutionStatus: 'unknown', route: null };
    finite(agent.serviceSeconds, 'passenger serviceSeconds', 0.000001);
    this.agents.set(id, agent);
    if (!agent.needsHelp) {
      this._bypassed++;
      this._schedule('process_exit', this.time + this.params.processExitDelaySeconds, { agentId: id }, 4);
      return id;
    }
    this._needsHelp++;
    const choice = this._chooseService(agent, options.serviceId);
    if (!choice) { agent.state = 'unroutable'; return id; }
    agent.serviceId = choice.service.id;
    agent.route = choice.route;
    agent.walkStartedAt = this.time;
    agent.walkEndsAt = this.time + choice.route.durationSeconds;
    agent.state = 'walking';
    if (choice.route.durationSeconds <= EPS) this._joinQueue(agent);
    else this._schedule('walk_complete', agent.walkEndsAt, { agentId: id }, 2);
    return id;
  }

  _joinQueue(agent) {
    const service = this.services.get(agent.serviceId);
    agent.currentNodeId = service.nodeId;
    agent.state = 'queued';
    agent.queueJoinedAt = this.time;
    service.queue.push(agent.id);
    this._dispatch(service);
    service.maxQueue = Math.max(service.maxQueue, service.queue.length);
    this._maxQueue = Math.max(this._maxQueue, this._totalQueued());
  }

  _dispatch(service) {
    while (service.enabled && service.queue.length && service.inService.size < service.staff) {
      const agent = this.agents.get(service.queue.shift());
      agent.state = 'in_service';
      agent.serviceStartedAt = this.time;
      agent.staffAtServiceStart = service.staff;
      agent.concurrentAtServiceStart = service.inService.size + 1;
      const usedSlots = new Set([...service.inService].map((id) => this.agents.get(id).serverIndex));
      agent.serverIndex = 0;
      while (usedSlots.has(agent.serverIndex)) agent.serverIndex++;
      service.inService.add(agent.id);
      service.maximumConcurrent = Math.max(service.maximumConcurrent, service.inService.size);
      this._schedule('service_complete', this.time + agent.serviceSeconds, { agentId: agent.id }, 1);
    }
  }

  _totalQueued() { let sum = 0; for (const s of this.services.values()) sum += s.queue.length; return sum; }

  _advanceClock(nextTime, commit = true) {
    // Integrate at state changes only, so render-frame partitioning cannot change totals.
    if (commit) {
      const elapsed = Math.max(0, nextTime - this._accountingTime);
      this._queueAreaSeconds += this._totalQueued() * elapsed;
      for (const s of this.services.values()) {
        s.queueAreaSeconds += s.queue.length * elapsed;
        s.busyAreaSeconds += s.inService.size * elapsed;
        s.staffAreaSeconds += Math.max(s.enabled ? s.staff : 0, s.inService.size) * elapsed;
      }
      this._accountingTime = nextTime;
    }
    this.time = nextTime;
  }

  /** Assign within the existing pool; increasing this does not create staff. */
  setStaff(serviceId, count) {
    this._applyStaffMap({ [String(serviceId)]: count });
  }

  _applyStaffMap(staffMap, dispatch = true) {
    const proposed = new Map([...this.services.values()].map((service) => [service.id, service.requestedStaff]));
    for (const [id, count] of Object.entries(staffMap)) {
      const service = this.services.get(id);
      if (!service) throw new Error(`Unknown service ${id}`);
      integer(count, 'staff');
      if (count > service.counters) throw new Error(`Staff exceeds physical counters at ${id}`);
      if (!service.enabled && count > 0) throw new Error(`Enable service ${id} before assigning staff`);
      proposed.set(id, count);
    }
    if ([...proposed.values()].reduce((sum, count) => sum + count, 0) > this.staffAvailable) throw new Error('Staff assignment exceeds available staff pool');
    this._advanceClock(this.time);
    for (const [id, count] of proposed) this.services.get(id).requestedStaff = count;
    this._rebalanceStaff(dispatch);
  }

  /** Change an assumed available resource pool explicitly. Busy staff cannot vanish. */
  setStaffAvailable(total) { this._allocateTotalStaff(total); }

  _allocateTotalStaff(total, dispatch = true) {
    integer(total, 'available staff');
    const busy = [...this.services.values()].reduce((sum, service) => sum + service.inService.size, 0);
    if (total < busy) throw new Error('Available pool cannot be reduced below staff currently assisting; let their cases finish or restart the scenario');
    this._advanceClock(this.time);
    this.staffAvailable = total;
    const enabled = [...this.services.values()].filter((service) => service.enabled);
    const enabledCounters = enabled.reduce((sum, service) => sum + service.counters, 0);
    const assignable = Math.min(total, enabledCounters);
    const allocation = new Map([...this.services.keys()].map((id) => [id, 0]));
    for (let i = 0; i < assignable;) for (const service of enabled) {
      if (i === assignable) break;
      if (allocation.get(service.id) < service.counters) { allocation.set(service.id, allocation.get(service.id) + 1); i++; }
    }
    for (const [id, count] of allocation) this.services.get(id).requestedStaff = count;
    this._rebalanceStaff(dispatch);
  }

  _rebalanceStaff(dispatch = true) {
    // Retain staff on in-progress cases before assigning anyone to another desk.
    let free = this.staffAvailable;
    for (const service of this.services.values()) {
      free -= service.inService.size;
      service.staff = service.enabled ? Math.min(service.requestedStaff, service.inService.size) : 0;
    }
    if (free < 0) throw new Error('Busy assistance cases exceed the staff pool');
    for (const service of this.services.values()) {
      if (service.enabled) {
        const additional = Math.min(free, Math.max(0, service.requestedStaff - service.inService.size));
        service.staff += additional;
        free -= additional;
      }
      service.grandfatheredLimit = Math.max(service.staff, service.inService.size);
    }
    if (dispatch) for (const service of this.services.values()) this._dispatch(service);
  }

  /** Change equipped workstation capacity without changing the staff pool. */
  setCounters(serviceId, count) {
    const service = this.services.get(String(serviceId));
    if (!service) throw new Error(`Unknown service ${serviceId}`);
    integer(count, 'counters');
    if (count < service.inService.size) throw new Error('Cannot remove workstations with assistance in progress');
    this._advanceClock(this.time);
    service.counters = count;
    this._allocateTotalStaff(this.staffAvailable);
  }

  /** Enabling an equipped mobile station adds counters, never staff or seats. */
  setServiceEnabled(serviceId, enabled = true) {
    const service = this.services.get(String(serviceId));
    if (!service) throw new Error(`Unknown service ${serviceId}`);
    if (typeof enabled !== 'boolean') throw new Error('Service enabled flag must be boolean');
    if (!enabled && service.inService.size) throw new Error('Cannot disable a service while assistance is in progress');
    this._advanceClock(this.time);
    service.enabled = enabled;
    this._allocateTotalStaff(this.staffAvailable);
  }

  _applyIntervention() {
    const intervention = this.params.intervention;
    if (!intervention || this._interventionApplied) return;
    for (const id of intervention.enableServices ?? []) if (!this.services.has(String(id))) throw new Error(`Unknown service ${id}`);
    for (const id of intervention.enableServices ?? []) this.services.get(String(id)).enabled = true;
    // No explicit staff change means the same available pool is retained.
    this._allocateTotalStaff(intervention.staff ?? this.staffAvailable, false);
    if (intervention.staffByService) this._applyStaffMap(intervention.staffByService, false);
    if (intervention.routing !== undefined) this.params.routing = intervention.routing;
    if (intervention.needsHelpFraction !== undefined) this.params.needsHelpFraction = intervention.needsHelpFraction;
    this._validateParameters();
    this._rebalanceStaff();
    this._interventionApplied = true;
  }

  step(seconds = 1) {
    finite(seconds, 'step seconds');
    const endTime = this.time + seconds;
    let events = 0;
    while (this._events.peek() && this._events.peek().time <= endTime) {
      if (++events > 1_000_000) throw new Error('Excessive events in one step; use a smaller interval or lower synthetic demand');
      const event = this._events.pop();
      this._advanceClock(event.time);
      const agent = this.agents.get(event.agentId);
      if (event.type === 'arrival') { this.addPassenger(); this._scheduleNextArrival(this.time); }
      else if (event.type === 'intervention') this._applyIntervention();
      else if (event.type === 'walk_complete' && agent?.state === 'walking') this._joinQueue(agent);
      else if (event.type === 'service_complete' && agent?.state === 'in_service') {
        const service = this.services.get(agent.serviceId);
        service.inService.delete(agent.id);
        service.grandfatheredLimit = Math.max(service.staff, service.inService.size);
        service.served++;
        this._served++;
        agent.state = 'waiting';
        agent.serviceCompletedAt = this.time;
        this._completedWaits.push(agent.serviceStartedAt - agent.queueJoinedAt);
        this._schedule('process_exit', this.time + this.params.processExitDelaySeconds, { agentId: agent.id }, 4);
        this._rebalanceStaff();
      } else if (event.type === 'process_exit' && agent?.state === 'waiting') { agent.state = 'process_exited'; agent.processExitedAt = this.time; }
    }
    this._advanceClock(endTime, false);
    return this.snapshot();
  }

  positionFor(agentOrId) {
    const agent = typeof agentOrId === 'string' ? this.agents.get(agentOrId) : agentOrId;
    if (!agent) return null;
    if (agent.state !== 'walking' || !agent.route) return [...this.nodes.get(agent.currentNodeId).position];
    let elapsed = Math.max(0, this.time - agent.walkStartedAt);
    for (const segment of agent.route.segments) {
      if (elapsed <= segment.durationSeconds || segment === agent.route.segments.at(-1)) {
        const alpha = segment.durationSeconds > 0 ? Math.min(1, elapsed / segment.durationSeconds) : 1;
        const a = this.nodes.get(segment.from).position, b = this.nodes.get(segment.to).position;
        return a.map((v, i) => v + (b[i] - v) * alpha);
      }
      elapsed -= segment.durationSeconds;
    }
    return [...this.nodes.get(agent.route.nodeIds.at(-1)).position];
  }

  snapshot({ includeAgents = true, includeExited = false } = {}) {
    const tail = this.time - this._accountingTime;
    const queueIndexes = new Map();
    if (includeAgents) for (const s of this.services.values()) s.queue.forEach((id, i) => queueIndexes.set(id, i));
    const counts = { walking: 0, queued: 0, inService: 0, waiting: 0, processExited: 0, unroutable: 0 };
    const stateKey = { walking: 'walking', queued: 'queued', in_service: 'inService', waiting: 'waiting', process_exited: 'processExited', unroutable: 'unroutable' };
    let oldestUnresolvedWaitSeconds = 0, unresolved = 0;
    for (const agent of this.agents.values()) {
      counts[stateKey[agent.state]]++;
      if (agent.needsHelp && agent.serviceCompletedAt === null) {
        unresolved++;
        if (agent.queueJoinedAt !== null && agent.serviceStartedAt === null) oldestUnresolvedWaitSeconds = Math.max(oldestUnresolvedWaitSeconds, this.time - agent.queueJoinedAt);
      }
    }
    const staffAssigned = [...this.services.values()].reduce((sum, service) => sum + Math.max(service.staff, service.inService.size), 0);
    const enabledServices = [...this.services.values()].filter((service) => service.enabled);
    const enabledCounters = enabledServices.reduce((sum, service) => sum + service.counters, 0);
    const workstationsEnabled = Number.isFinite(enabledCounters) ? enabledCounters : null;
    const waits = this._completedWaits, sorted = [...waits].sort((a, b) => a - b);
    const meanWait = waits.length ? waits.reduce((sum, w) => sum + w, 0) / waits.length : null;
    const metrics = {
      generated: this.agents.size, needsHelp: this._needsHelp, ...counts,
      assistanceCompleted: this._served, served: this._served, completed: this._served, bypassed: this._bypassed,
      unresolvedHelp: unresolved, unresolved, resolutionUnknown: this._needsHelp, assistedResolutionUnknown: this._served,
      staffAvailable: this.staffAvailable, staffAssigned, staffUnassigned: this.staffAvailable - staffAssigned,
      workstationsEnabled, nominalCapacityPerHour: staffAssigned * 3600 / this.params.serviceMeanSeconds,
      ticketResolutions: null, confirmedSeats: null, confirmedAccommodation: null, flightDepartures: null,
      maximumQueue: this._maxQueue,
      timeWeightedMeanQueue: this.time ? (this._queueAreaSeconds + this._totalQueued() * tail) / this.time : 0,
      meanCompletedWaitSeconds: meanWait,
      p95CompletedWaitSeconds: sorted.length ? sorted[Math.max(0, Math.ceil(sorted.length * 0.95) - 1)] : null,
      oldestUnresolvedWaitSeconds,
      completedWaitSampleSize: waits.length,
      conservation: this.agents.size === Object.values(counts).reduce((sum, count) => sum + count, 0),
    };
    const services = [...this.services.values()].map((s) => ({
      id: s.id, nodeId: s.nodeId, label: s.label ?? s.id, proposed: !!s.proposed, enabled: s.enabled,
      staff: s.staff, staffAssigned: Math.max(s.staff, s.inService.size), staffRequested: s.requestedStaff, counters: Number.isFinite(s.counters) ? s.counters : null,
      queued: s.queue.length, inService: s.inService.size, assistanceCompleted: s.served, served: s.served, maximumQueue: s.maxQueue,
      timeWeightedMeanQueue: this.time ? (s.queueAreaSeconds + s.queue.length * tail) / this.time : 0,
      nominalCapacityPerHour: Math.max(s.staff, s.inService.size) * 3600 / this.params.serviceMeanSeconds,
      utilization: (s.staffAreaSeconds + Math.max(s.enabled ? s.staff : 0, s.inService.size) * tail) ? (s.busyAreaSeconds + s.inService.size * tail) / (s.staffAreaSeconds + Math.max(s.enabled ? s.staff : 0, s.inService.size) * tail) : null,
      maximumConcurrent: s.maximumConcurrent,
    }));
    const result = { time: this.time, synthetic: true, calibrated: false, notice: SIMULATION_NOTICE, metricSemantics: SIMULATION_METRIC_SEMANTICS, notModeled: ['flight inventory', 'seat allocation', 'ticket issuance', 'hotel-room availability', 'travel resolution', 'flight departure'], interventionApplied: this._interventionApplied, arrivalRatePerMinute: this.arrivalRateAt(this.time), metrics, services };
    if (includeAgents) result.agents = [...this.agents.values()].filter((a) => includeExited || a.state !== 'process_exited').map((a) => ({
      id: a.id, state: a.state, queueIndex: queueIndexes.get(a.id) ?? null, serverIndex: a.serverIndex ?? null, position: this.positionFor(a), originNodeId: a.originNodeId, currentNodeId: a.currentNodeId,
      serviceId: a.serviceId, needsHelp: a.needsHelp, arrivalTime: a.arrivalTime,
      routeNodeIds: a.route?.nodeIds ?? [], queueJoinedAt: a.queueJoinedAt,
      waitSeconds: a.queueJoinedAt === null ? 0 : (a.serviceStartedAt ?? this.time) - a.queueJoinedAt,
      serviceStartedAt: a.serviceStartedAt, assistanceCompletedAt: a.serviceCompletedAt, serviceCompletedAt: a.serviceCompletedAt, serviceSeconds: a.serviceSeconds,
      processExitedAt: a.processExitedAt, resolutionStatus: a.resolutionStatus,
    }));
    return result;
  }

  /** Throws if accounting, queue membership or staff-at-start constraints are broken. */
  assertInvariants() {
    const snapshot = this.snapshot({ includeAgents: false });
    if (!snapshot.metrics.conservation) throw new Error('Passenger conservation failed');
    if (snapshot.metrics.staffAssigned > snapshot.metrics.staffAvailable || snapshot.metrics.staffUnassigned < 0) throw new Error('Staff pool conservation failed');
    if (snapshot.metrics.staffAssigned + snapshot.metrics.staffUnassigned !== snapshot.metrics.staffAvailable) throw new Error('Staff accounting failed');
    const occupied = new Set();
    for (const service of this.services.values()) {
      if (Math.max(service.staff, service.inService.size) > service.counters) throw new Error(`Physical workstation capacity exceeded at ${service.id}`);
      if (service.inService.size > Math.max(service.staff, service.grandfatheredLimit)) throw new Error(`Staff capacity exceeded at ${service.id}`);
      for (const id of [...service.queue, ...service.inService]) {
        if (occupied.has(id)) throw new Error(`Passenger ${id} belongs to two service states`);
        occupied.add(id);
        const a = this.agents.get(id), expected = service.inService.has(id) ? 'in_service' : 'queued';
        if (!a || a.state !== expected || a.serviceId !== service.id) throw new Error(`Incorrect service membership for ${id}`);
      }
    }
    for (const a of this.agents.values()) {
      if ((a.state === 'queued' || a.state === 'in_service') && !occupied.has(a.id)) throw new Error(`Passenger ${a.id} missing from service membership`);
      if (a.concurrentAtServiceStart > a.staffAtServiceStart) throw new Error(`Service began without staff for ${a.id}`);
      if (a.serviceStartedAt !== null && a.serviceStartedAt + EPS < a.queueJoinedAt) throw new Error('Negative queue wait');
    }
    if (snapshot.metrics.needsHelp !== snapshot.metrics.assistanceCompleted + snapshot.metrics.unresolvedHelp) throw new Error('Help cohort accounting failed');
    if (snapshot.metrics.resolutionUnknown !== snapshot.metrics.needsHelp) throw new Error('Unmodeled resolution was incorrectly inferred');
    return true;
  }
}

/** Matched random arrivals and case draws, with aggregate snapshots for charting. */
export function runComparison(graph, baselineParams = {}, interventionParams = {}, options = {}) {
  const durationSeconds = finite(options.durationSeconds ?? 4 * 3600, 'durationSeconds');
  const sampleEverySeconds = finite(options.sampleEverySeconds ?? 60, 'sampleEverySeconds', 0.000001);
  const seed = baselineParams.seed ?? DEFAULTS.seed;
  const baseline = new RebookingSimulation(graph, { ...baselineParams, seed });
  const intervention = new RebookingSimulation(graph, { ...baselineParams, ...interventionParams, seed });
  const samples = { baseline: [], intervention: [] };
  const record = () => {
    baseline.assertInvariants(); intervention.assertInvariants();
    samples.baseline.push(baseline.snapshot({ includeAgents: !!options.includeAgents }));
    samples.intervention.push(intervention.snapshot({ includeAgents: !!options.includeAgents }));
  };
  record();
  while (baseline.time < durationSeconds - EPS) {
    const interval = Math.min(sampleEverySeconds, durationSeconds - baseline.time);
    baseline.step(interval); intervention.step(interval); record();
  }
  return { synthetic: true, calibrated: false, notice: SIMULATION_NOTICE, seed,
    baseline: { samples: samples.baseline, final: samples.baseline.at(-1) },
    intervention: { samples: samples.intervention, final: samples.intervention.at(-1) } };
}
