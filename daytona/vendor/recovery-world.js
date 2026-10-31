import { RecoverySimulation } from './recovery-simulation.js';
import { seededRandom } from './simulation.js';

export const RECOVERY_WORLD_VERSION = '1.2.0';
export const RECOVERY_WORLD_NOTICE = 'Synthetic dependency and hotel-loop demonstrator. Modeled departures require the implemented finite resources; they are not forecasts or actual flight, ticket, hotel, immigration or crew-compliance outcomes.';
export const WORLD_DEFAULTS = Object.freeze({
  hotelPolicy: 'planned_return', flightResources: 'limited', hotelEligibilityFraction: 0.6,
  minimumHotelRestSeconds: 7200, hotelCheckinSeconds: 600, hotelReturnLeadSeconds: 9000,
  minimumHotelOpportunitySeconds: 18000, exitProcessingSeconds: 900,
  manualHotelFallbackAtSeconds: 43200, hotelCallbackFailureFraction: 0.15,
  assistedHotelCallbackSeconds: 600, hotelSupportStaffPerSite: 1,
  securityStaff: 4, securityMeanSeconds: 120, securityAvailableFromSeconds: 0,
  rampStaff: 2, cateringStaff: 2, rampMeanSeconds: 900, cateringMeanSeconds: 1200,
  gateOccupancySeconds: 900, flightPreparationLeadSeconds: 1800,
  minimumReservationLeadSeconds: 1800, retryHelpSeconds: 7200, horizonSeconds: 86400,
  flightAnnouncementDelaySeconds: 300, simulationEpochISO: '2025-06-23T18:00:00+03:00',
});
const clone = (value) => structuredClone(value);
const sum = (values) => values.reduce((a, b) => a + b, 0);
const avg = (values) => values.length ? sum(values) / values.length : null;
function nonnegative(value, name, integer = false) {
  if (!Number.isFinite(value) || value < 0 || (integer && !Number.isInteger(value))) throw new Error(`Invalid ${name}`);
  return value;
}
function probability(value, name) { nonnegative(value, name); if (value > 1) throw new Error(`Invalid ${name}`); }

export function createSyntheticFlights(graph, mode = 'limited') {
  const gates = graph.nodes.filter((node) => node.kind === 'gate');
  if (!gates.length) throw new Error('Flight scenario requires representative gate nodes');
  const flights = [];
  for (const hour of [8, 10, 12, 16, 20]) for (const [index, destination] of ['destination_a', 'destination_b'].entries()) {
    const id = `synthetic-${destination.at(-1)}-${hour}`;
    flights.push({ id, destination, departureSeconds: hour * 3600, seatCapacity: 80,
      gateNodeId: gates[index % gates.length].id, gateResourceId: `gate-${index}`,
      crewId: `crew-${id}`, aircraftId: `aircraft-${id}`, crewAvailableFromSeconds: mode === 'limited' && hour === 8 && index === 0 ? 9 * 3600 : 0,
      crewAvailableUntilSeconds: 30 * 3600, aircraftOnsiteFromSeconds: mode === 'limited' && hour === 8 && index === 1 ? 8.5 * 3600 : 0,
      flightDurationSeconds: 4 * 3600,
      departureDelaySeconds: hour === 16 && index === 1 ? 1800 : 0,
      cateringSeconds: mode === 'limited' && hour === 12 && index === 0 ? 2400 : 1200,
    });
  }
  return flights;
}

/** Finite resource orchestration on the same cases. Actual travel/ticket fields remain unknown. */
export class RecoveryWorldSimulation extends RecoverySimulation {
  constructor(graph, cityModel, parameters = {}) {
    super(graph, parameters);
    this.worldParams = { ...WORLD_DEFAULTS, ...clone(parameters) };
    const p = this.worldParams;
    if (!['desk_only', 'room_only', 'planned_return'].includes(p.hotelPolicy)) throw new Error('Unknown hotel policy');
    if (!['ready', 'limited'].includes(p.flightResources)) throw new Error('Unknown flight resource scenario');
    for (const name of ['hotelEligibilityFraction', 'hotelCallbackFailureFraction']) probability(p[name], name);
    for (const name of ['hotelSupportStaffPerSite', 'securityStaff', 'rampStaff', 'cateringStaff']) nonnegative(p[name], name, true);
    for (const name of ['minimumHotelRestSeconds', 'hotelCheckinSeconds', 'hotelReturnLeadSeconds', 'minimumHotelOpportunitySeconds', 'exitProcessingSeconds', 'manualHotelFallbackAtSeconds', 'assistedHotelCallbackSeconds', 'securityMeanSeconds', 'securityAvailableFromSeconds', 'rampMeanSeconds', 'cateringMeanSeconds', 'gateOccupancySeconds', 'flightPreparationLeadSeconds', 'minimumReservationLeadSeconds', 'retryHelpSeconds']) nonnegative(p[name], name);
    if (p.securityMeanSeconds <= 0 || p.retryHelpSeconds <= 0) throw new Error('Processing and retry durations must be positive');
    nonnegative(p.flightAnnouncementDelaySeconds, 'flightAnnouncementDelaySeconds');
    if (!Number.isFinite(Date.parse(p.simulationEpochISO))) throw new Error('Invalid simulation clock epoch');
    this.cityModel = clone(cityModel ?? {});
    this.cityAnchor = this.cityModel.anchors?.find((anchor) => anchor.id === 'hia_pickup');
    if (!this.cityAnchor) throw new Error('City model needs hia_pickup anchor');
    this.airportNodeId = parameters.airportReentryNodeId ?? (this.nodes.has('plaza_north') ? 'plaza_north' : this.nodes.keys().next().value);
    if (!this.nodes.has(this.airportNodeId)) throw new Error('Unknown airport processing node');
    this.hotels = new Map();
    for (const site of this.cityModel.sites ?? []) {
      const route = this.cityModel.routes?.find((item) => item.from === 'hia_pickup' && item.to === site.id);
      if (!route) throw new Error(`Missing airport route for ${site.id}`);
      nonnegative(site.roomCapacity, 'roomCapacity', true); nonnegative(site.personCapacity, 'personCapacity', true);
      nonnegative(route.outboundSecondsAssumed, 'outbound time'); nonnegative(route.returnSecondsAssumed, 'return time');
      this.hotels.set(site.id, { ...clone(site), route: clone(route), rooms: new Set(), occupants: new Set(), supportQueue: [], supportBusy: new Set(), supportStaff: p.hotelSupportStaffPerSite, maximumRooms: 0 });
    }
    const transport = { fleetVehicles: 6, vehiclePassengerCapacity: 40, boardingSecondsAssumed: 600, alightingSecondsAssumed: 300, ...this.cityModel.transportDefaults, ...parameters.transport };
    for (const key of ['fleetVehicles', 'vehiclePassengerCapacity']) nonnegative(transport[key], key, true);
    for (const key of ['boardingSecondsAssumed', 'alightingSecondsAssumed']) nonnegative(transport[key], key);
    this.transport = transport;
    this.vehicles = new Map(Array.from({ length: transport.fleetVehicles }, (_, index) => [`vehicle-${index + 1}`, { id: `vehicle-${index + 1}`, capacity: transport.vehiclePassengerCapacity, state: 'idle', location: 'hia_pickup', passengers: [], maximumOccupancy: 0, trips: 0 }]));
    this.transportQueue = []; this._transportSequence = 0;
    this.security = { staff: p.securityStaff, queue: [], busy: new Set(), maximumBusy: 0, completed: 0 };
    this.preparation = {
      ramp: { staff: p.rampStaff, queue: [], busy: new Set(), completed: 0, maximumBusy: 0 },
      catering: { staff: p.cateringStaff, queue: [], busy: new Set(), completed: 0, maximumBusy: 0 },
    };
    this.flights = new Map(); this.crews = new Map(); this.aircraft = new Map(); this.gates = new Map();
    this.flightEvents = []; this.flightAnnouncements = []; this.arrivals = new Map();
    const flights = parameters.flights ?? createSyntheticFlights(graph, p.flightResources);
    this.authoredFlightPlan = clone(flights);
    for (const raw of flights) {
      if (this.flights.has(raw.id)) throw new Error('Duplicate flight');
      nonnegative(raw.departureSeconds, 'departure time'); nonnegative(raw.seatCapacity, 'seat capacity', true);
      if (!this.nodes.has(raw.gateNodeId)) throw new Error('Unknown flight gate');
      const flight = { crewAvailableFromSeconds: 0, crewAvailableUntilSeconds: Infinity, aircraftOnsiteFromSeconds: 0, flightDurationSeconds: 3600,
        cateringSeconds: p.cateringMeanSeconds, rampSeconds: p.rampMeanSeconds, ...clone(raw),
        departureDelaySeconds: 0, status: 'scheduled', announcedStatus: 'scheduled', announcedAt: 0, estimatedDepartureSeconds: null, announcedEstimatedDepartureSeconds: null,
        reservations: new Set(), departedCases: new Set(), noShows: new Set(), rampReady: false, cateringReady: false, failureReasons: [], maximumReservations: 0 };
      if (!flight.crewId || !flight.aircraftId || !flight.gateResourceId) throw new Error('Flight needs distinct named crew, aircraft and gate resources');
      for (const name of ['crewAvailableFromSeconds', 'aircraftOnsiteFromSeconds', 'flightDurationSeconds', 'cateringSeconds', 'rampSeconds']) nonnegative(flight[name], name);
      if (!(flight.crewAvailableUntilSeconds >= flight.crewAvailableFromSeconds)) throw new Error('Invalid crew availability window');
      this.flights.set(flight.id, flight);
      flight.publishedGateNodeId = flight.gateNodeId; flight.gateChangesObserved = new Set();
      if (!this.crews.has(flight.crewId)) this.crews.set(flight.crewId, { id: flight.crewId, availableFrom: flight.crewAvailableFromSeconds, availableUntil: flight.crewAvailableUntilSeconds, assignedFlight: null });
      if (!this.aircraft.has(flight.aircraftId)) this.aircraft.set(flight.aircraftId, { id: flight.aircraftId, onsiteFrom: flight.aircraftOnsiteFromSeconds, assignedFlight: null });
      if (!this.gates.has(flight.gateResourceId)) this.gates.set(flight.gateResourceId, { id: flight.gateResourceId, busyUntil: 0, flights: [] });
      this.events.push(Math.max(0, flight.departureSeconds - p.flightPreparationLeadSeconds), 'world_prepare_flight', { flightId: flight.id }, 0);
      // Delay is authored exogenous input, revealed only at its later operational event.
      flight.departureDelaySeconds = raw.departureDelaySeconds ?? 0;
      nonnegative(flight.departureDelaySeconds, 'departure delay');
      if (flight.departureDelaySeconds) {
        const delayAt = raw.delayObservedAtSeconds ?? Math.max(0, flight.departureSeconds - 1800);
        nonnegative(delayAt, 'delay observation time');
        if (delayAt > flight.departureSeconds + flight.departureDelaySeconds) throw new Error('Delay observation cannot follow actual modeled departure');
        this.events.push(delayAt, 'world_flight_delay', { flightId: flight.id }, 0);
      }
      this.events.push(flight.departureSeconds + flight.departureDelaySeconds, 'world_depart_flight', { flightId: flight.id }, 4);
    }
    for (const wave of this.story.waves ?? []) if (wave.cohort === 'incoming_connection') {
      const arrival = { id: `synthetic-inbound-${wave.id}`, waveId: wave.id, direction: 'arrival', origin: `synthetic_origin_${this.arrivals.size + 1}`,
        scheduledArrivalSeconds: wave.atSeconds, estimatedArrivalSeconds: null, seatCapacity: wave.count, status: 'scheduled', announcedStatus: 'scheduled', announcedAt: 0, actualModeledArrivalAt: null,
        disembarkationWindowSecondsAssumed: wave.durationSeconds ?? 0, linkedToDepartureAircraft: false };
      this.arrivals.set(arrival.id, arrival); this.events.push(wave.atSeconds, 'world_inbound_arrival', { arrivalId: arrival.id }, 0);
    }
    this._worldCounts = { hotelAdmissions: 0, hotelReleases: 0, hotelCallbackFailures: 0, hotelNoPhoneAssisted: 0, hotelCallbackFallbacks: 0, hotelAssistedCallbacks: 0, manualFallbackReturns: 0, flightFailures: 0, missedReservedFlights: 0, exitProcessed: 0 };
    this.events.push(p.manualHotelFallbackAtSeconds, 'world_manual_hotel_fallback', {}, 0);
    if (p.securityAvailableFromSeconds > 0) this.events.push(p.securityAvailableFromSeconds, 'world_security_available', {}, 0);
  }

  addCase(options = {}) {
    const existingParty = this.params.behaviorProfiles && options.partyId ? this.parties.get(options.partyId) : null;
    if (existingParty?.destination && options.destination && existingParty.destination !== options.destination) throw new Error('Cohesive party cannot have conflicting destinations');
    const id = super.addCase(options), passenger = this.cases.get(id);
    const party = this.parties.get(passenger.partyId), destinationKey = this.params.behaviorProfiles ? passenger.partyId : id;
    passenger.destination = (this.params.behaviorProfiles ? party.destination : null) ?? options.destination ?? (seededRandom(`${this.params.seed}:destination:${destinationKey}`)() < 0.5 ? 'destination_a' : 'destination_b');
    if (this.params.behaviorProfiles) party.destination = passenger.destination;
    passenger.hotelEligible = options.hotelEligible ?? seededRandom(`${this.params.seed}:hotel-eligibility:${id}`)() < this.worldParams.hotelEligibilityFraction;
    passenger.worldLocation = { domain: 'airport', kind: 'airside' };
    passenger.flightId = null; passenger.hotelId = null; passenger.vehicleId = null;
    passenger.deferredHelpReason = null; passenger.modeledDepartureAt = null; passenger.hotelVisits = 0;
    passenger.worldWalkingSeconds = 0; passenger.partyWaitingSeconds = 0; passenger.ticketStatus = 'unknown'; passenger.hotelHistory = [];
    return id;
  }
  _partyMembers(passenger) {
    if (!this.params.behaviorProfiles || passenger.partySize <= 1) return [passenger];
    return this.parties.get(passenger.partyId).memberIds.map((id) => this.cases.get(id));
  }
  _cohesive(passenger) { return this.params.behaviorProfiles && passenger.partySize > 1; }
  _partyComplete(passenger, members = this._partyMembers(passenger)) { return members.length === passenger.partySize && members.every((person) => person.worldLocation); }
  _holdPartyMember(passenger, state) {
    // Called just after assistance starts its gate walk, before time has advanced.
    passenger.route = null; passenger.routeToken++; this._transition(passenger, state);
  }
  _partyRoute(members, target) {
    const leader = members[0], profile = { ...leader.profile,
      stepFreeRequired: members.some((person) => person.profile.stepFreeRequired), walkingSpeedMps: Math.min(...members.map((person) => person.profile.walkingSpeedMps)) };
    return this._routeTo({ ...leader, profile }, target);
  }
  _walkParty(members, target, state) {
    const route = this._partyRoute(members, target);
    if (!route) { for (const person of members) { person.partyBlockReason = 'no_joint_accessible_route'; this._holdPartyMember(person, 'party_waiting_route'); } return false; }
    for (const person of members) this._walk(person, clone(route), state);
    return true;
  }
  _tryPartyRecovery(passenger) {
    const members = this._partyMembers(passenger), party = this.parties.get(passenger.partyId);
    if (!this._partyComplete(passenger, members) || members.some((person) => person.activeEncounter || !person.assistanceCount || person.worldLocation.kind !== 'airside' || person.modeledDepartureAt !== null)) return;
    for (const person of members) { person.partyBlockReason = null; this._holdPartyMember(person, 'party_waiting_plan'); }
    this._reservePartyFlight(members);
    if (!this._considerPartyHotel(members)) {
      const flight = this.flights.get(members[0].flightId);
      if (flight) this._walkParty(members, flight.gateNodeId, 'world_walking_party_to_gate');
      else for (const person of members) this._transition(person, 'party_waiting_inventory');
    }
    party.lastJointPlanAt = this.time;
  }
  _reservePartyFlight(members) {
    const current = this.flights.get(members[0].flightId);
    if (current && ['scheduled', 'delayed'].includes(current.status) && members.every((p) => p.flightId === current.id && current.reservations.has(p.id))) return true;
    for (const person of members) this._releaseSeat(person);
    const flight = [...this.flights.values()].filter((item) => item.destination === members[0].destination && ['scheduled', 'delayed'].includes(item.status)
      && (item.estimatedDepartureSeconds ?? item.departureSeconds) > this.time + this.worldParams.minimumReservationLeadSeconds
      && item.seatCapacity - item.reservations.size >= members.length).sort((a, b) => (a.estimatedDepartureSeconds ?? a.departureSeconds) - (b.estimatedDepartureSeconds ?? b.departureSeconds) || a.id.localeCompare(b.id))[0];
    if (!flight) {
      const party = this.parties.get(members[0].partyId);
      for (const person of members) { person.ticketStatus = 'awaiting_synthetic_inventory'; person.partyBlockReason = 'insufficient_joint_flight_seats'; }
      if (!party.retryPending) { party.retryPending = true; this.events.push(this.time + this.worldParams.retryHelpSeconds, 'world_retry_party_help', { partyId: party.id }, 2); }
      return false;
    }
    for (const person of members) { flight.reservations.add(person.id); person.flightId = flight.id; person.ticketStatus = 'synthetic_seat_reserved'; person.gateNodeId = flight.gateNodeId; }
    flight.maximumReservations = Math.max(flight.maximumReservations, flight.reservations.size);
    this._log('synthetic_party_seats_reserved', { partyId: members[0].partyId, memberIds: members.map((p) => p.id), flightId: flight.id }); return true;
  }
  _considerPartyHotel(members) {
    const p = this.worldParams, party = this.parties.get(members[0].partyId);
    if (p.hotelPolicy === 'desk_only' || members.some((person) => person.hotelId || person.hotelVisits > 0)) return false;
    if (members.some((person) => !person.hotelEligible)) { party.hotelBlockReason = 'party_member_not_eligible_under_assumed_input'; return false; }
    const departure = this.flights.get(members[0].flightId)?.departureSeconds;
    if (departure !== undefined && departure - this.time < p.minimumHotelOpportunitySeconds) { party.hotelBlockReason = 'insufficient_joint_hotel_window'; return false; }
    const hotel = [...this.hotels.values()].filter((site) => site.roomCapacity - site.rooms.size >= members.length && site.personCapacity - site.rooms.size >= members.length)
      .sort((a, b) => a.rooms.size / Math.max(1, a.roomCapacity) - b.rooms.size / Math.max(1, b.roomCapacity) || a.id.localeCompare(b.id))[0];
    if (!hotel) { party.hotelBlockReason = 'insufficient_rooms_at_one_site'; return false; }
    const route = this._partyRoute(members, this.airportNodeId);
    if (!route) { party.hotelBlockReason = 'no_joint_accessible_exit_route'; return false; }
    for (const person of members) {
      hotel.rooms.add(person.id); person.hotelId = hotel.id; person.hotelVisits++; person.hotelReservedAt = this.time;
      person.worldLocation = { domain: 'airport', kind: 'egress' };
    }
    hotel.maximumRooms = Math.max(hotel.maximumRooms, hotel.rooms.size); party.hotelBlockReason = null;
    for (const person of members) this._walk(person, clone(route), 'world_walking_to_exit');
    this._log('synthetic_party_hotel_confirmed', { partyId: party.id, memberIds: members.map((person) => person.id), hotelId: hotel.id, roomCount: members.length }); return true;
  }
  _transition(passenger, next) {
    if (passenger.state?.startsWith('world_walking')) passenger.worldWalkingSeconds = (passenger.worldWalkingSeconds ?? 0) + this.time - passenger.stateSince;
    if (passenger.state?.startsWith('party_waiting')) passenger.partyWaitingSeconds = (passenger.partyWaitingSeconds ?? 0) + this.time - passenger.stateSince;
    super._transition(passenger, next);
  }
  _openEncounter(passenger, reason) {
    if (passenger.modeledDepartureAt != null) return;
    if (passenger.worldLocation && passenger.worldLocation.kind !== 'airside') {
      passenger.deferredHelpReason = reason; return;
    }
    super._openEncounter(passenger, reason);
  }
  _completeAssistance(passenger, encounterId) {
    const wasActive = passenger?.activeEncounter?.id === encounterId && passenger.state === 'assistance';
    super._completeAssistance(passenger, encounterId);
    if (!wasActive) return;
    if (this._cohesive(passenger)) { this._holdPartyMember(passenger, 'party_waiting_help'); this._tryPartyRecovery(passenger); return; }
    this._reserveFlight(passenger);
    this._considerHotel(passenger);
  }
  _reserveFlight(passenger) {
    if (passenger.flightId && ['scheduled', 'delayed'].includes(this.flights.get(passenger.flightId)?.status)) return;
    const flight = [...this.flights.values()].filter((item) => item.destination === passenger.destination && ['scheduled', 'delayed'].includes(item.status) && (item.estimatedDepartureSeconds ?? item.departureSeconds) > this.time + this.worldParams.minimumReservationLeadSeconds && item.reservations.size < item.seatCapacity).sort((a, b) => (a.estimatedDepartureSeconds ?? a.departureSeconds) - (b.estimatedDepartureSeconds ?? b.departureSeconds) || a.id.localeCompare(b.id))[0];
    if (!flight) {
      passenger.ticketStatus = 'awaiting_synthetic_inventory';
      this.events.push(this.time + this.worldParams.retryHelpSeconds, 'world_retry_help', { id: passenger.id }, 2); return;
    }
    flight.reservations.add(passenger.id); flight.maximumReservations = Math.max(flight.maximumReservations, flight.reservations.size);
    passenger.flightId = flight.id; passenger.ticketStatus = 'synthetic_seat_reserved'; passenger.gateNodeId = flight.gateNodeId;
    this._log('synthetic_seat_reserved', { caseId: passenger.id, flightId: flight.id });
    if (passenger.worldLocation?.kind === 'airside') this._walk(passenger, this._routeTo(passenger, flight.gateNodeId), 'walking_to_gate');
  }
  _releaseSeat(passenger) {
    const flight = this.flights.get(passenger.flightId);
    if (flight && ['scheduled', 'delayed', 'cancelled'].includes(flight.status)) flight.reservations.delete(passenger.id);
    passenger.flightId = null; passenger.ticketStatus = 'replacement_needed';
  }
  disruptCase(caseId, disruption = {}) {
    const passenger = this.cases.get(caseId);
    if (passenger?.modeledDepartureAt != null) return;
    if (passenger && this._cohesive(passenger) && !disruption.partyInternal && (disruption.type === 'cancellation' || disruption.type === undefined)) {
      const party = this.parties.get(passenger.partyId), members = this._partyMembers(passenger), eventId = disruption.id ?? `manual-party-${this._disruptionsObserved}`;
      party.disruptionsHandled ??= new Set(); if (party.disruptionsHandled.has(eventId)) return;
      party.disruptionsHandled.add(eventId);
      for (const person of members) this._releaseSeat(person);
      for (const person of members) this.disruptCase(person.id, { ...disruption, id: eventId, partyInternal: true });
      return;
    }
    const reservedFlight = this.flights.get(passenger?.flightId);
    if (disruption.type === 'gate_change' && reservedFlight && ['scheduled', 'delayed'].includes(reservedFlight.status)) {
      const changeId = disruption.id ?? 'manual-gate-change';
      if (!reservedFlight.gateChangesObserved.has(changeId)) {
        const alternatives = [...this.flights.values()].filter((item) => item.gateNodeId !== reservedFlight.gateNodeId);
        const target = alternatives[0];
        if (target) {
          reservedFlight.gateChangesObserved.add(changeId); reservedFlight.gateNodeId = target.gateNodeId; reservedFlight.gateResourceId = target.gateResourceId;
          this.flightEvents.push({ time: this.time, flightId: reservedFlight.id, direction: 'departure', status: 'gate_changed', gateNodeId: reservedFlight.gateNodeId });
          this.events.push(this.time + this.worldParams.flightAnnouncementDelaySeconds, 'world_gate_announcement', { flightId: reservedFlight.id, changeId, gateNodeId: reservedFlight.gateNodeId, observedAt: this.time }, 0);
        }
      }
      return;
    }
    if (disruption.type === 'cancellation' || disruption.type === undefined) this._releaseSeat(passenger);
    if (passenger?.worldLocation && passenger.worldLocation.kind !== 'airside') {
      this._advance(this.time); this._disruptionsObserved++;
      passenger.disruptions.push({ id: disruption.id ?? 'offsite-disruption', type: disruption.type ?? 'cancellation', time: this.time });
      if (disruption.type === 'cancellation' || disruption.type === undefined) passenger.deferredHelpReason = 'offsite_new_disruption';
      this._log('offsite_information', { caseId, disruptionType: disruption.type ?? 'cancellation' }); return;
    }
    super.disruptCase(caseId, disruption);
  }

  _considerHotel(passenger) {
    const p = this.worldParams;
    if (p.hotelPolicy === 'desk_only' || !passenger.hotelEligible || passenger.hotelId || passenger.hotelVisits > 0) return;
    const departure = this.flights.get(passenger.flightId)?.departureSeconds;
    if (departure !== undefined && departure - this.time < p.minimumHotelOpportunitySeconds) return;
    const hotel = [...this.hotels.values()].filter((site) => site.rooms.size < site.roomCapacity && site.rooms.size < site.personCapacity).sort((a, b) => a.rooms.size / Math.max(1, a.roomCapacity) - b.rooms.size / Math.max(1, b.roomCapacity) || a.id.localeCompare(b.id))[0];
    if (!hotel) { this._log('hotel_capacity_unavailable', { caseId: passenger.id }); return; }
    hotel.rooms.add(passenger.id); hotel.maximumRooms = Math.max(hotel.maximumRooms, hotel.rooms.size);
    passenger.hotelId = hotel.id; passenger.hotelVisits++; passenger.hotelReservedAt = this.time;
    passenger.worldLocation = { domain: 'airport', kind: 'egress' };
    // Cancel the just-started gate route at the same point; follow graph to abstract processing handoff.
    const route = this._routeTo(passenger, this.airportNodeId);
    this._walk(passenger, route, 'world_walking_to_exit');
    this._log('hotel_room_reserved', { caseId: passenger.id, hotelId: hotel.id, occupancyAssumption: 'one case/person per room' });
  }
  _walkComplete(passenger, token) {
    if (token !== passenger?.routeToken || !passenger.route) return;
    if (passenger.state === 'world_walking_party_to_gate') {
      passenger.currentNodeId = passenger.route.target; passenger.route = null; this._transition(passenger, 'party_waiting_gate');
      const members = this._partyMembers(passenger);
      if (members.every((person) => person.state === 'party_waiting_gate' && person.currentNodeId === passenger.currentNodeId)) for (const person of members) this._transition(person, 'awaiting_recovery');
    } else if (passenger.state === 'world_walking_to_exit') {
      passenger.currentNodeId = passenger.route.target; passenger.route = null;
      this._transition(passenger, 'exit_processing');
      this.events.push(this.time + this.worldParams.exitProcessingSeconds, 'world_exit_complete', { id: passenger.id }, 2);
    } else super._walkComplete(passenger, token);
  }
  _requestTransport(passenger, direction) {
    if (passenger.vehicleId || this.transportQueue.some((request) => request.id === passenger.id)) return;
    if (this._cohesive(passenger)) {
      const state = direction === 'outbound' ? 'party_waiting_outbound' : 'party_waiting_return_ack';
      this._transition(passenger, state);
      passenger.worldLocation = direction === 'outbound' ? { domain: 'airport', kind: 'airport_pickup', siteId: 'hia_pickup', access: 'landside' } : { domain: 'city', kind: 'hotel', siteId: passenger.hotelId };
      const members = this._partyMembers(passenger);
      if (!this._partyComplete(passenger, members) || members.some((person) => person.state !== state || person.hotelId !== passenger.hotelId)) return;
      if (direction === 'return' && members.some((person) => person.hotelCallbackAcknowledgedAt == null)) return;
      for (const person of members) {
        this.transportQueue.push({ id: person.id, hotelId: person.hotelId, direction, sequence: this._transportSequence++ });
        if (![...this.vehicles.values()].some((vehicle) => vehicle.capacity >= members.length)) person.partyBlockReason = 'no_vehicle_can_fit_whole_party';
        this._transition(person, direction === 'outbound' ? 'waiting_outbound_transport' : 'hotel_waiting_return_transport');
      }
      this._dispatchVehicles(); return;
    }
    const hotelId = passenger.hotelId;
    this.transportQueue.push({ id: passenger.id, hotelId, direction, sequence: this._transportSequence++ });
    this._transition(passenger, direction === 'outbound' ? 'waiting_outbound_transport' : 'hotel_waiting_return_transport');
    passenger.worldLocation = direction === 'outbound' ? { domain: 'airport', kind: 'airport_pickup', siteId: 'hia_pickup', access: 'landside' } : { domain: 'city', kind: 'hotel', siteId: hotelId };
    this._dispatchVehicles();
  }
  _manifest(vehicle, hotelId, direction) {
    const matching = this.transportQueue.filter((request) => request.hotelId === hotelId && request.direction === direction);
    const selected = [], selectedIds = new Set(); let remaining = vehicle.capacity - vehicle.passengers.length;
    for (const request of matching) {
      if (selectedIds.has(request.id)) continue;
      const person = this.cases.get(request.id), members = this._partyMembers(person);
      const requests = members.map((p) => matching.find((r) => r.id === p.id));
      if (requests.some((r) => !r) || members.length > remaining || (this._cohesive(person) && !this._partyComplete(person, members))) continue;
      for (const item of requests) { selected.push(item); selectedIds.add(item.id); } remaining -= members.length;
    }
    for (const request of selected) {
      this.transportQueue.splice(this.transportQueue.indexOf(request), 1); vehicle.passengers.push(request.id);
      const passenger = this.cases.get(request.id); passenger.vehicleId = vehicle.id;
      passenger.partyBlockReason = null;
      this._transition(passenger, direction === 'outbound' ? 'boarding_outbound_transport' : 'boarding_return_transport');
      passenger.worldLocation = direction === 'outbound' ? { domain: 'airport', kind: 'airport_pickup', siteId: 'hia_pickup', vehicleId: vehicle.id, access: 'landside' } : { domain: 'city', kind: 'vehicle', vehicleId: vehicle.id };
    }
    vehicle.maximumOccupancy = Math.max(vehicle.maximumOccupancy, vehicle.passengers.length);
  }
  _loadVehicle(vehicle, hotelId, direction) {
    vehicle.state = 'loading'; vehicle.hotelId = hotelId; vehicle.direction = direction;
    this._manifest(vehicle, hotelId, direction);
    if (!vehicle.passengers.length) { vehicle.state = 'idle'; return; }
    this.events.push(this.time + this.transport.boardingSecondsAssumed, 'world_vehicle_depart', { vehicleId: vehicle.id }, 2);
  }
  _driveVehicle(vehicle, from, to, seconds, empty = false) {
    vehicle.state = empty ? 'repositioning' : 'driving'; vehicle.from = from; vehicle.to = to;
    vehicle.startedAt = this.time; vehicle.arrivesAt = this.time + seconds; vehicle.trips++;
    this.events.push(vehicle.arrivesAt, 'world_vehicle_arrive', { vehicleId: vehicle.id }, 2);
  }
  _dispatchVehicles() {
    for (const vehicle of this.vehicles.values()) if (vehicle.state === 'loading') this._manifest(vehicle, vehicle.hotelId, vehicle.direction);
    for (const vehicle of this.vehicles.values()) {
      if (vehicle.state !== 'idle' || vehicle.capacity <= 0) continue;
      const fits = (request) => {
        const person = this.cases.get(request.id), members = this._partyMembers(person);
        return members.length <= vehicle.capacity && (!this._cohesive(person) || this._partyComplete(person, members)) && members.every((p) => this.transportQueue.some((r) => r.id === p.id && r.direction === request.direction && r.hotelId === request.hotelId));
      };
      if (vehicle.location !== 'hia_pickup') {
        const pending = this.transportQueue.find((request) => request.direction === 'return' && request.hotelId === vehicle.location && fits(request));
        if (pending) this._loadVehicle(vehicle, vehicle.location, 'return');
        else this._driveVehicle(vehicle, vehicle.location, 'hia_pickup', this.hotels.get(vehicle.location).route.returnSecondsAssumed, true);
      } else {
        // Return requests take vehicle-dispatch precedence; this is separate from desk queue priority.
        const request = this.transportQueue.find((item) => item.direction === 'return' && fits(item)) ?? this.transportQueue.find(fits);
        if (!request) continue;
        if (request.direction === 'return') { vehicle.hotelId = request.hotelId; this._driveVehicle(vehicle, 'hia_pickup', request.hotelId, this.hotels.get(request.hotelId).route.outboundSecondsAssumed, true); }
        else this._loadVehicle(vehicle, request.hotelId, 'outbound');
      }
    }
  }
  _vehicleDepart(vehicle) {
    if (vehicle.state !== 'loading') return;
    const hotel = this.hotels.get(vehicle.hotelId), returning = vehicle.direction === 'return';
    for (const id of vehicle.passengers) {
      const passenger = this.cases.get(id);
      if (returning) {
        if (!hotel.rooms.delete(id)) throw new Error('Returning passenger lost room reservation');
        hotel.occupants.delete(id); passenger.hotelLeftAt = this.time; this._worldCounts.hotelReleases++;
        const stay = passenger.hotelHistory.findLast((entry) => entry.hotelId === hotel.id && entry.leftAt === null);
        if (stay) stay.leftAt = this.time;
      }
      this._transition(passenger, returning ? 'in_return_transport' : 'in_outbound_transport');
      passenger.worldLocation = { domain: 'city', kind: 'vehicle', vehicleId: vehicle.id };
    }
    this._driveVehicle(vehicle, returning ? hotel.id : 'hia_pickup', returning ? 'hia_pickup' : hotel.id, returning ? hotel.route.returnSecondsAssumed : hotel.route.outboundSecondsAssumed);
  }
  _vehicleArrive(vehicle) {
    vehicle.location = vehicle.to;
    if (vehicle.state === 'repositioning') { vehicle.state = 'idle'; this._dispatchVehicles(); return; }
    if (vehicle.location === 'hia_pickup') for (const id of vehicle.passengers) this.cases.get(id).worldLocation = { domain: 'airport', kind: 'airport_pickup', siteId: 'hia_pickup', vehicleId: vehicle.id, access: 'landside' };
    vehicle.state = 'alighting';
    this.events.push(this.time + this.transport.alightingSecondsAssumed, 'world_vehicle_unload', { vehicleId: vehicle.id }, 2);
  }
  _vehicleUnload(vehicle) {
    for (const id of vehicle.passengers) {
      const passenger = this.cases.get(id); passenger.vehicleId = null;
      if (vehicle.location === 'hia_pickup') {
        passenger.worldLocation = { domain: 'airport', kind: 'security' }; passenger.currentNodeId = this.airportNodeId;
        passenger.route = null; passenger.routeToken++;
        this._transition(passenger, 'security_queue'); this.security.queue.push(id);
      } else {
        passenger.worldLocation = { domain: 'city', kind: 'hotel', siteId: vehicle.location };
        this._transition(passenger, 'hotel_checkin');
        this.events.push(this.time + this.worldParams.hotelCheckinSeconds, 'world_hotel_checkin', { id }, 2);
      }
    }
    vehicle.passengers = []; vehicle.state = 'idle'; this._dispatchSecurity(); this._dispatchVehicles();
  }
  _hotelCheckin(passenger) {
    if (this._cohesive(passenger)) {
      this._transition(passenger, 'party_waiting_checkin'); const members = this._partyMembers(passenger);
      if (!this._partyComplete(passenger, members) || members.some((person) => person.state !== 'party_waiting_checkin')) return;
      for (const person of members) this._hotelCheckinIndividual(person);
      return;
    }
    this._hotelCheckinIndividual(passenger);
  }
  _hotelCheckinIndividual(passenger) {
    const hotel = this.hotels.get(passenger.hotelId); hotel.occupants.add(passenger.id);
    passenger.hotelCheckinAt = this.time; this._worldCounts.hotelAdmissions++;
    passenger.hotelHistory.push({ hotelId: hotel.id, catalogHotelId: hotel.catalogHotelId ?? null, checkinAt: this.time, leftAt: null,
      ratePerRoomNightQARAssumed: hotel.poolAccounting?.ratePerRoomNightQAR ?? null,
      rateMeaning: 'Scenario assumption if supplied; not a verified tariff or billed amount', roomsUsed: 1 });
    this._transition(passenger, 'hotel_rest');
    const rested = this.time + this.worldParams.minimumHotelRestSeconds;
    this.events.push(rested, 'world_hotel_rest_complete', { id: passenger.id }, 2);
    if (this.worldParams.hotelPolicy === 'planned_return') {
      const flight = this.flights.get(passenger.flightId);
      const recallAt = Math.max(rested, flight ? flight.departureSeconds - this.worldParams.hotelReturnLeadSeconds : rested);
      this.events.push(recallAt, 'world_hotel_callback', { id: passenger.id }, 2);
    }
  }
  _hotelCallback(passenger, manual = false) {
    if (!['hotel_rest', 'hotel_awaiting_callback'].includes(passenger.state)) return;
    const rested = passenger.hotelCheckinAt + this.worldParams.minimumHotelRestSeconds;
    if (this.time < rested) { this.events.push(rested, manual ? 'world_manual_case_return' : 'world_hotel_callback', { id: passenger.id }, 2); return; }
    if (manual) { this._worldCounts.manualFallbackReturns++; passenger.hotelCallbackAcknowledgedAt = this.time; this._requestTransport(passenger, 'return'); return; }
    const noPhone = !passenger.hasPhone;
    const failed = !noPhone && seededRandom(`${this.params.seed}:hotel-callback:${passenger.id}:${passenger.hotelVisits}`)() < this.worldParams.hotelCallbackFailureFraction;
    if (noPhone || failed) {
      this._worldCounts.hotelCallbackFallbacks++;
      if (noPhone) this._worldCounts.hotelNoPhoneAssisted++; else this._worldCounts.hotelCallbackFailures++;
      passenger.hotelCallbackFallbackReason = noPhone ? 'no_phone_access' : 'delivery_failed';
      const hotel = this.hotels.get(passenger.hotelId);
      this._transition(passenger, 'hotel_assisted_callback_queue'); hotel.supportQueue.push(passenger.id); this._dispatchHotelSupport(hotel);
    } else { passenger.hotelCallbackAcknowledgedAt = this.time; this._requestTransport(passenger, 'return'); }
  }
  _dispatchHotelSupport(hotel) {
    while (hotel.supportQueue.length && hotel.supportBusy.size < hotel.supportStaff) {
      const id = hotel.supportQueue.shift(); hotel.supportBusy.add(id); this._transition(this.cases.get(id), 'hotel_assisted_callback');
      this.events.push(this.time + this.worldParams.assistedHotelCallbackSeconds, 'world_hotel_support_done', { id, hotelId: hotel.id }, 2);
    }
  }
  _dispatchSecurity() {
    if (this.time < this.worldParams.securityAvailableFromSeconds) return;
    while (this.security.queue.length && this.security.busy.size < this.security.staff) {
      const id = this.security.queue.shift(); this.security.busy.add(id); this.security.maximumBusy = Math.max(this.security.maximumBusy, this.security.busy.size);
      this._transition(this.cases.get(id), 'security_processing');
      this.events.push(this.time + this.worldParams.securityMeanSeconds, 'world_security_done', { id }, 1);
    }
  }
  _securityDone(passenger) {
    this.security.busy.delete(passenger.id); this.security.completed++;
    if (this._cohesive(passenger)) {
      passenger.reenteredAt = this.time; passenger.worldLocation = { domain: 'airport', kind: 'security_holding' };
      this._transition(passenger, 'party_waiting_security'); const members = this._partyMembers(passenger);
      if (this._partyComplete(passenger, members) && members.every((person) => person.state === 'party_waiting_security')) {
        for (const person of members) { person.worldLocation = { domain: 'airport', kind: 'airside' }; person.hotelId = null; this._transition(person, 'awaiting_recovery'); }
        const flight = this.flights.get(members[0].flightId);
        if (members.some((person) => person.deferredHelpReason) || !flight || !['scheduled', 'delayed'].includes(flight.status)) {
          for (const person of members) this._releaseSeat(person);
          for (const person of members) { const reason = person.deferredHelpReason ?? 'party_return_needs_replacement'; person.deferredHelpReason = null; this._openEncounter(person, reason); }
        } else this._walkParty(members, flight.gateNodeId, 'world_walking_party_to_gate');
      }
      this._dispatchSecurity(); return;
    }
    passenger.worldLocation = { domain: 'airport', kind: 'airside' }; passenger.hotelId = null; passenger.reenteredAt = this.time;
    this._transition(passenger, 'awaiting_recovery');
    if (passenger.deferredHelpReason || !passenger.flightId || !['scheduled', 'delayed'].includes(this.flights.get(passenger.flightId)?.status)) {
      const reason = passenger.deferredHelpReason ?? 'return_needs_replacement'; passenger.deferredHelpReason = null; this._openEncounter(passenger, reason);
    } else this._walk(passenger, this._routeTo(passenger, this.flights.get(passenger.flightId).gateNodeId), 'walking_to_gate');
    this._dispatchSecurity();
  }

  _prepareFlight(flight) {
    for (const type of ['ramp', 'catering']) { this.preparation[type].queue.push(flight.id); this._dispatchPreparation(type); }
  }
  _dispatchPreparation(type) {
    const resource = this.preparation[type];
    while (resource.queue.length && resource.busy.size < resource.staff) {
      const flightId = resource.queue.shift(), flight = this.flights.get(flightId);
      if (!['scheduled', 'delayed'].includes(flight.status)) continue;
      resource.busy.add(flightId); resource.maximumBusy = Math.max(resource.maximumBusy, resource.busy.size);
      this.events.push(this.time + flight[`${type}Seconds`], 'world_preparation_done', { flightId, resource: type }, 1);
    }
  }
  _departureFailures(flight) {
    const crew = this.crews.get(flight.crewId), aircraft = this.aircraft.get(flight.aircraftId), gate = this.gates.get(flight.gateResourceId), failures = [];
    if (crew.assignedFlight || this.time < crew.availableFrom || this.time + flight.flightDurationSeconds > crew.availableUntil) failures.push('crew_unavailable_in_synthetic_window');
    if (aircraft.assignedFlight || this.time < aircraft.onsiteFrom) failures.push('aircraft_not_onsite_or_already_assigned');
    if (gate.busyUntil > this.time) failures.push('gate_not_ready');
    if (!flight.rampReady) failures.push('ramp_not_ready');
    if (!flight.cateringReady) failures.push('catering_not_ready');
    return failures;
  }
  _departFlight(flight) {
    if (!['scheduled', 'delayed'].includes(flight.status)) return;
    const failures = this._departureFailures(flight);
    if (failures.length) {
      flight.status = 'cancelled'; flight.failureReasons = failures; this._worldCounts.flightFailures++;
      const ids = [...flight.reservations];
      this._log('synthetic_flight_cancelled', { flightId: flight.id, failureReasons: [...failures] });
      this.flightEvents.push({ time: this.time, flightId: flight.id, direction: 'departure', status: 'cancelled', failureReasons: [...failures] });
      this.events.push(this.time + this.worldParams.flightAnnouncementDelaySeconds, 'world_flight_announcement', { flightId: flight.id, status: 'cancelled', observedAt: this.time, affectedCaseIds: ids }, 0);
      flight.reservations.clear(); return;
    }
    flight.status = 'departed'; flight.actualModeledDepartureAt = this.time;
    flight.departureEvidence = { checkedAt: this.time, crewId: flight.crewId, aircraftId: flight.aircraftId, gateResourceId: flight.gateResourceId,
      crewAvailable: true, aircraftOnsite: true, gateAvailable: true, rampReady: flight.rampReady, cateringReady: flight.cateringReady, boardedCaseIds: [] };
    this.crews.get(flight.crewId).assignedFlight = flight.id; this.aircraft.get(flight.aircraftId).assignedFlight = flight.id;
    const gate = this.gates.get(flight.gateResourceId); gate.busyUntil = this.time + this.worldParams.gateOccupancySeconds; gate.flights.push({ flightId: flight.id, start: this.time, end: gate.busyUntil });
    const readyCaseIds = new Set([...flight.reservations].filter((id) => {
      const person = this.cases.get(id);
      return (!this.accommodation || this.accommodation.mayDepart(person, flight)) && this._partyMembers(person).every((member) => member.flightId === flight.id && member.worldLocation?.kind === 'airside' && member.currentNodeId === flight.gateNodeId && !member.route && !member.activeEncounter)
        && (!this._cohesive(person) || this._partyComplete(person));
    }));
    for (const id of [...flight.reservations]) {
      const passenger = this.cases.get(id);
      const atGate = readyCaseIds.has(id);
      if (atGate) {
        passenger.modeledDepartureAt = this.time; passenger.ticketStatus = 'synthetic_departed'; passenger.worldLocation = { domain: 'departed', kind: 'synthetic_flight', flightId: flight.id };
        this._transition(passenger, 'modeled_departed'); flight.departedCases.add(id);
        flight.departureEvidence.boardedCaseIds.push(id);
      } else {
        flight.noShows.add(id); this._worldCounts.missedReservedFlights++;
      }
    }
    flight.reservations.clear(); this._log('synthetic_flight_departed', { flightId: flight.id, boardedCases: flight.departedCases.size, missedCases: flight.noShows.size });
    this.flightEvents.push({ time: this.time, flightId: flight.id, direction: 'departure', status: 'departed', boardedCases: flight.departedCases.size });
    this.events.push(this.time + this.worldParams.flightAnnouncementDelaySeconds, 'world_flight_announcement', { flightId: flight.id, status: 'departed', observedAt: this.time, affectedCaseIds: [...flight.noShows] }, 0);
  }

  _handleExternalEvent(event) {
    const d = event.data, passenger = this.cases.get(d.id), vehicle = this.vehicles.get(d.vehicleId), flight = this.flights.get(d.flightId);
    if (event.type === 'world_prepare_flight') this._prepareFlight(flight);
    else if (event.type === 'world_depart_flight') this._departFlight(flight);
    else if (event.type === 'world_flight_delay') {
      if (['scheduled', 'delayed'].includes(flight.status)) {
        flight.status = 'delayed'; flight.estimatedDepartureSeconds = flight.departureSeconds + flight.departureDelaySeconds;
        this.flightEvents.push({ time: this.time, flightId: flight.id, direction: 'departure', status: 'delayed', estimatedDepartureSeconds: flight.estimatedDepartureSeconds });
        this.events.push(this.time + this.worldParams.flightAnnouncementDelaySeconds, 'world_flight_announcement', { flightId: flight.id, status: 'delayed', observedAt: this.time, estimatedDepartureSeconds: flight.estimatedDepartureSeconds, affectedCaseIds: [] }, 0);
      }
    }
    else if (event.type === 'world_flight_announcement') {
      flight.announcedStatus = d.status; flight.announcedAt = this.time;
      if (d.estimatedDepartureSeconds !== undefined) flight.announcedEstimatedDepartureSeconds = d.estimatedDepartureSeconds;
      this.flightAnnouncements.push({ time: this.time, observedAt: d.observedAt, flightId: flight.id, direction: 'departure', status: d.status, estimatedDepartureSeconds: d.estimatedDepartureSeconds ?? null, failureReasons: d.status === 'cancelled' ? [...flight.failureReasons] : [] });
      for (const id of d.affectedCaseIds) { const person = this.cases.get(id); if (person?.flightId === flight.id && person.modeledDepartureAt === null) this.disruptCase(id, { id: `${d.status}-${flight.id}`, type: 'cancellation' }); }
    }
    else if (event.type === 'world_gate_announcement') {
      flight.publishedGateNodeId = d.gateNodeId;
      this.flightAnnouncements.push({ time: this.time, observedAt: d.observedAt, flightId: flight.id, direction: 'departure', status: 'gate_changed', gateNodeId: d.gateNodeId });
      for (const id of flight.reservations) super.disruptCase(id, { id: d.changeId, type: 'gate_change', gateNodeId: d.gateNodeId });
      if (this.params.behaviorProfiles) {
        const seen = new Set();
        for (const id of flight.reservations) {
          const person = this.cases.get(id); if (!this._cohesive(person) || seen.has(person.partyId)) continue; seen.add(person.partyId);
          const members = this._partyMembers(person);
          if (members.every((member) => !member.activeEncounter && member.worldLocation?.kind === 'airside')) this._walkParty(members, d.gateNodeId, 'world_walking_party_to_gate');
        }
      }
    }
    else if (event.type === 'world_inbound_arrival') {
      const arrival = this.arrivals.get(d.arrivalId); arrival.status = 'arrived'; arrival.actualModeledArrivalAt = this.time;
      this.flightEvents.push({ time: this.time, flightId: arrival.id, direction: 'arrival', status: 'arrived' });
      this.events.push(this.time + this.worldParams.flightAnnouncementDelaySeconds, 'world_inbound_announcement', { arrivalId: arrival.id, observedAt: this.time }, 0);
    }
    else if (event.type === 'world_inbound_announcement') {
      const arrival = this.arrivals.get(d.arrivalId); arrival.announcedStatus = 'arrived'; arrival.announcedAt = this.time;
      this.flightAnnouncements.push({ time: this.time, observedAt: d.observedAt, flightId: arrival.id, direction: 'arrival', status: 'arrived' });
    }
    else if (event.type === 'world_preparation_done') { const resource = this.preparation[d.resource]; resource.busy.delete(d.flightId); resource.completed++; flight[`${d.resource}Ready`] = true; this._dispatchPreparation(d.resource); }
    else if (event.type === 'world_exit_complete') { this._worldCounts.exitProcessed++; this._requestTransport(passenger, 'outbound'); }
    else if (event.type === 'world_vehicle_depart') this._vehicleDepart(vehicle);
    else if (event.type === 'world_vehicle_arrive') this._vehicleArrive(vehicle);
    else if (event.type === 'world_vehicle_unload') this._vehicleUnload(vehicle);
    else if (event.type === 'world_hotel_checkin') this._hotelCheckin(passenger);
    else if (event.type === 'world_hotel_rest_complete') { if (passenger.state === 'hotel_rest') this._transition(passenger, 'hotel_awaiting_callback'); if (this.time >= this.worldParams.manualHotelFallbackAtSeconds && this.worldParams.hotelPolicy === 'room_only') this._hotelCallback(passenger, true); }
    else if (event.type === 'world_hotel_callback') this._hotelCallback(passenger);
    else if (event.type === 'world_manual_case_return') this._hotelCallback(passenger, true);
    else if (event.type === 'world_hotel_support_done') { const hotel = this.hotels.get(d.hotelId); hotel.supportBusy.delete(d.id); this._worldCounts.hotelAssistedCallbacks++; passenger.hotelCallbackAcknowledgedAt = this.time; this._requestTransport(passenger, 'return'); this._dispatchHotelSupport(hotel); }
    else if (event.type === 'world_security_done') this._securityDone(passenger);
    else if (event.type === 'world_security_available') this._dispatchSecurity();
    else if (event.type === 'world_manual_hotel_fallback') { if (this.worldParams.hotelPolicy === 'room_only') for (const person of this.cases.values()) this._hotelCallback(person, true); }
    else if (event.type === 'world_retry_help') { if (passenger && passenger.modeledDepartureAt === null && !passenger.flightId && !passenger.activeEncounter) this._openEncounter(passenger, 'synthetic_inventory_retry'); }
    else if (event.type === 'world_retry_party_help') {
      const party = this.parties.get(d.partyId); if (!party) return; party.retryPending = false;
      const members = party.memberIds.map((id) => this.cases.get(id));
      if (members.some((person) => person.modeledDepartureAt !== null || person.flightId || person.activeEncounter)) return;
      for (const person of members) this._openEncounter(person, 'synthetic_party_inventory_retry');
    }
  }

  _vehiclePosition(vehicle) {
    const anchor = (id) => id === 'hia_pickup' ? this.cityAnchor.mapXY : this.hotels.get(id).mapXY;
    if (!['driving', 'repositioning'].includes(vehicle.state)) return [...anchor(vehicle.location)];
    const hotel = this.hotels.get(vehicle.from === 'hia_pickup' ? vehicle.to : vehicle.from);
    let path = hotel.route.pathMapXY?.length > 1 ? hotel.route.pathMapXY : [this.cityAnchor.mapXY, hotel.mapXY];
    if (vehicle.from !== 'hia_pickup') path = [...path].reverse();
    const lengths = path.slice(1).map((point, index) => Math.hypot(point[0] - path[index][0], point[1] - path[index][1]));
    let distance = sum(lengths) * Math.min(1, Math.max(0, (this.time - vehicle.startedAt) / Math.max(0.001, vehicle.arrivesAt - vehicle.startedAt)));
    for (let index = 0; index < lengths.length; index++) {
      if (distance <= lengths[index] || index === lengths.length - 1) { const fraction = lengths[index] ? Math.min(1, distance / lengths[index]) : 1; return path[index].map((v, axis) => v + fraction * (path[index + 1][axis] - v)); }
      distance -= lengths[index];
    }
    return [...anchor(vehicle.to)];
  }
  _caseSnapshot(passenger, includeEncounters, queueIndexes, includeDisplay = true) {
    const base = super._caseSnapshot(passenger, includeEncounters, queueIndexes, includeDisplay);
    const location = passenger.worldLocation ?? { domain: 'airport', kind: 'airside' };
    let cityPosition = null;
    if (location.domain === 'city' || location.kind === 'airport_pickup') {
      if (passenger.vehicleId) cityPosition = this._vehiclePosition(this.vehicles.get(passenger.vehicleId));
      else cityPosition = location.siteId === 'hia_pickup' ? [...this.cityAnchor.mapXY] : [...this.hotels.get(location.siteId).mapXY];
    }
    return { ...base, destination: passenger.destination, location: { ...location }, cityPosition, mapPosition: cityPosition,
      position: location.kind === 'airport_pickup' ? null : base.position,
      positionMeaning: location.kind === 'airport_pickup' ? 'landside_airport_pickup_on_city_map; no terminal graph coordinate' : 'semantic_terminal_graph',
      partyBlockReason: passenger.partyBlockReason ?? null,
      cityCoordinateConvention: cityPosition ? 'east/south metres; city projection' : null,
      flightId: passenger.flightId, hotelId: passenger.hotelId, vehicleId: passenger.vehicleId,
      hotelHistory: clone(passenger.hotelHistory), pastHotelId: passenger.hotelHistory.at(-1)?.hotelId ?? null,
      partyWaitingSeconds: passenger.partyWaitingSeconds + (passenger.state.startsWith('party_waiting') ? this.time - passenger.stateSince : 0),
      hotelEligibleAssumed: passenger.hotelEligible, ticketStatus: passenger.ticketStatus,
      passengerPlanStatus: passenger.ticketStatus,
      operationalSeatStatus: passenger.modeledDepartureAt !== null ? 'synthetic_departed' : this.flights?.get(passenger.flightId)?.reservations.has(passenger.id) ? 'reserved' : 'none',
      modeledDepartureAt: passenger.modeledDepartureAt, modeledTravelOutcome: passenger.modeledDepartureAt === null ? 'not_departed' : 'synthetic_departed',
      deferredHelpReason: passenger.deferredHelpReason, hotelVisits: passenger.hotelVisits,
      hotelCheckinAt: passenger.hotelCheckinAt ?? null, hotelLeftAt: passenger.hotelLeftAt ?? null,
      hotelCallbackAcknowledgedAt: passenger.hotelCallbackAcknowledgedAt ?? null, reenteredAt: passenger.reenteredAt ?? null,
      hotelCallbackFallbackReason: passenger.hotelCallbackFallbackReason ?? null,
      recoveryElapsedSeconds: (passenger.modeledDepartureAt ?? this.time) - passenger.createdAt,
      walkingSeconds: base.walkingSeconds + (passenger.worldWalkingSeconds ?? 0) + (passenger.state.startsWith('world_walking') ? this.time - passenger.stateSince : 0),
    };
  }
  _caseSummary(passenger) {
    const base = super._caseSummary(passenger);
    return { ...base, walkingSeconds: base.walkingSeconds + (passenger.worldWalkingSeconds ?? 0) + (passenger.state.startsWith('world_walking') ? this.time - passenger.stateSince : 0) };
  }
  snapshot(options = {}) {
    const state = super.snapshot(options);
    if (!this.flights) return state;
    const passengers = [...this.cases.values()], departed = passengers.filter((passenger) => passenger.modeledDepartureAt !== null);
    const hotels = [...this.hotels.values()].map((hotel) => ({ id: hotel.id, label: hotel.label, mapXY: [...hotel.mapXY], roomCapacity: hotel.roomCapacity, personCapacity: hotel.personCapacity,
      reservedRooms: hotel.rooms.size, occupants: hotel.occupants.size, maximumRooms: hotel.maximumRooms, supportStaff: hotel.supportStaff, supportBusy: hotel.supportBusy.size, supportQueued: hotel.supportQueue.length }));
    const vehicles = [...this.vehicles.values()].map((vehicle) => ({ id: vehicle.id, state: vehicle.state, location: vehicle.location, from: vehicle.from ?? null, to: vehicle.to ?? null,
      mapXY: this._vehiclePosition(vehicle), capacity: vehicle.capacity, occupiedSeats: vehicle.passengers.length, passengerCaseIds: [...vehicle.passengers], maximumOccupancy: vehicle.maximumOccupancy, trips: vehicle.trips }));
    // The authored schedule is known at time zero. Operational and published status remain distinct.
    const flights = [...this.flights.values()].map((flight) => ({
      id: flight.id, direction: 'departure', destination: flight.destination, gateNodeId: flight.gateNodeId, gateResourceId: flight.gateResourceId,
      publishedGateNodeId: flight.publishedGateNodeId, gateChangeModeled: flight.gateChangesObserved.size > 0,
      scheduledDepartureSeconds: flight.departureSeconds, estimatedDepartureSeconds: flight.estimatedDepartureSeconds, announcedEstimatedDepartureSeconds: flight.announcedEstimatedDepartureSeconds,
      status: flight.status, operationalStatus: flight.status, announcedStatus: flight.announcedStatus, announcedAt: flight.announcedAt, seatCapacity: flight.seatCapacity,
      reservedSeats: flight.reservations.size, departedPassengers: flight.departedCases.size, noShows: flight.noShows.size,
      rampReady: flight.rampReady, cateringReady: flight.cateringReady, failureReasons: [...flight.failureReasons],
      crewCurrentlyAvailable: !this.crews.get(flight.crewId).assignedFlight && this.time >= this.crews.get(flight.crewId).availableFrom && this.time <= this.crews.get(flight.crewId).availableUntil,
      aircraftCurrentlyOnsite: !this.aircraft.get(flight.aircraftId).assignedFlight && this.time >= this.aircraft.get(flight.aircraftId).onsiteFrom,
      actualModeledDepartureAt: flight.actualModeledDepartureAt ?? null,
      departureEvidence: flight.departureEvidence ? clone(flight.departureEvidence) : null,
      announcedActualDepartureSeconds: flight.announcedStatus === 'departed' ? flight.actualModeledDepartureAt : null,
      announcedFailureReasons: flight.announcedStatus === 'cancelled' ? [...flight.failureReasons] : [],
      unresolvedCaseCount: passengers.filter((passenger) => passenger.modeledDepartureAt === null && (passenger.flightId === flight.id || flight.noShows.has(passenger.id) || passenger.disruptions.some((item) => item.id === `cancelled-${flight.id}`))).length,
    }));
    const deferredHelp = passengers.filter((passenger) => passenger.deferredHelpReason).length;
    Object.assign(state.metrics, {
      modeledDepartures: departed.length, modeledFlightsDeparted: [...this.flights.values()].filter((flight) => flight.status === 'departed').length,
      modeledFlightCancellations: this._worldCounts.flightFailures, syntheticSeatReservations: sum([...this.flights.values()].map((flight) => flight.reservations.size)),
      deferredHelp, allHelpPending: state.metrics.unresolvedHelp + deferredHelp,
      casesInCity: passengers.filter((passenger) => passenger.worldLocation?.domain === 'city').length,
      roomsReserved: sum(hotels.map((hotel) => hotel.reservedRooms)), hotelOccupants: sum(hotels.map((hotel) => hotel.occupants)),
      hotelAdmissions: this._worldCounts.hotelAdmissions, hotelReleases: this._worldCounts.hotelReleases,
      transportQueued: this.transportQueue.length, securityQueued: this.security.queue.length, securityProcessing: this.security.busy.size,
      meanTimeToModeledDepartureSeconds: avg(departed.map((passenger) => passenger.modeledDepartureAt - passenger.createdAt)),
      meanRecoveryElapsedAllCasesSeconds: avg(passengers.map((passenger) => (passenger.modeledDepartureAt ?? this.time) - passenger.createdAt)),
      modeledNotDeparted: passengers.length - departed.length,
      awaitingRecovery: passengers.length - departed.length - state.metrics.unresolvedHelp,
    });
    state.experiment = 'finite-recovery-world'; state.notice = RECOVERY_WORLD_NOTICE; state.hotels = hotels; state.vehicles = vehicles; state.flights = flights;
    state.arrivals = [...this.arrivals.values()].map((arrival) => ({ ...arrival,
      announcedActualArrivalSeconds: arrival.announcedStatus === 'arrived' ? arrival.actualModeledArrivalAt : null,
      casesEntered: passengers.filter((passenger) => passenger.waveId === arrival.waveId).length }));
    state.flightEvents = clone(this.flightEvents); state.flightAnnouncements = clone(this.flightAnnouncements);
    state.clock = { epochISO: this.worldParams.simulationEpochISO, timeZone: 'Asia/Qatar', utcOffsetMinutes: 180,
      nowISO: new Date(Date.parse(this.worldParams.simulationEpochISO) + this.time * 1000).toISOString(), syntheticDateAnchor: true };
    state.worldCounts = { ...this._worldCounts }; state.hotelPolicy = this.worldParams.hotelPolicy;
    state.parties = [...this.parties.values()].map((party) => {
      const members = party.memberIds.map((id) => this.cases.get(id));
      return { id: party.id, memberIds: [...party.memberIds], expectedSize: party.expectedSize, arrivedSize: members.length,
        cohesionEnabled: !!this.params.behaviorProfiles && party.expectedSize > 1, destination: party.destination ?? members[0]?.destination,
        states: [...new Set(members.map((p) => p.state))], flightIds: [...new Set(members.map((p) => p.flightId))],
        hotelIds: [...new Set(members.map((p) => p.hotelId))], vehicleIds: [...new Set(members.map((p) => p.vehicleId))],
        hotelBlockReason: party.hotelBlockReason ?? null, lastJointPlanAt: party.lastJointPlanAt ?? null };
    });
    state.metrics.partyWaitingCases = passengers.filter((person) => person.state.startsWith('party_waiting')).length;
    state.metrics.cohesiveParties = state.parties.filter((party) => party.cohesionEnabled).length;
    state.metrics.cumulativePartyWaitingSeconds = passengers.reduce((total, person) => total + person.partyWaitingSeconds + (person.state.startsWith('party_waiting') ? this.time - person.stateSince : 0), 0);
    for (const cohort of state.cohorts) {
      const group = passengers.filter((passenger) => passenger.cohort === cohort.cohort);
      cohort.modeledDepartures = group.filter((passenger) => passenger.modeledDepartureAt !== null).length;
      cohort.modeledNotDeparted = group.length - cohort.modeledDepartures;
      cohort.meanRecoveryElapsedAllCasesSeconds = avg(group.map((passenger) => (passenger.modeledDepartureAt ?? this.time) - passenger.createdAt));
    }
    state.destinationCohorts = [...new Set(passengers.map((passenger) => passenger.destination))].map((destination) => {
      const group = passengers.filter((passenger) => passenger.destination === destination);
      return { destination, caseCount: group.length, modeledDepartures: group.filter((passenger) => passenger.modeledDepartureAt !== null).length,
        syntheticSeatReservations: group.filter((passenger) => passenger.flightId && passenger.modeledDepartureAt === null).length,
        actualTravelOutcome: 'unknown' };
    });
    state.resources = { ...state.resources,
      airportSecurity: { implemented: true, staff: this.security.staff, busy: this.security.busy.size, queued: this.security.queue.length, completed: this.security.completed, maximumBusy: this.security.maximumBusy },
      groundHandling: { implemented: true, staff: this.preparation.ramp.staff, busy: this.preparation.ramp.busy.size, queued: this.preparation.ramp.queue.length, maximumBusy: this.preparation.ramp.maximumBusy },
      catering: { implemented: true, staff: this.preparation.catering.staff, busy: this.preparation.catering.busy.size, queued: this.preparation.catering.queue.length, maximumBusy: this.preparation.catering.maximumBusy },
      operatingCrew: { implemented: true, units: this.crews.size, committed: [...this.crews.values()].filter((crew) => crew.assignedFlight).length, regulatoryComplianceModeled: false },
      aircraft: { implemented: true, units: this.aircraft.size, committed: [...this.aircraft.values()].filter((aircraft) => aircraft.assignedFlight).length },
      hotelRooms: { implemented: true, capacity: sum(hotels.map((hotel) => hotel.roomCapacity)), reserved: state.metrics.roomsReserved, occupied: state.metrics.hotelOccupants, occupancyAssumption: 'one case/person per room; person cap also enforced' },
      transport: { implemented: true, vehicles: vehicles.length, seats: sum(vehicles.map((vehicle) => vehicle.capacity)), occupiedSeats: sum(vehicles.map((vehicle) => vehicle.occupiedSeats)) },
    };
    state.implementation = { ...state.implementation, finiteSyntheticSeats: true, flightFeasibility: true, securityProcessing: true, crewWindows: true, aircraftReadiness: true, groundHandling: true, cateringReadiness: true, hotelEligibilityAndRooms: true, hotelStayAndCallback: true, transportAndReturn: true,
      ticketInventory: false, actualTicketIssuance: false, actualTravelKnown: false, crewDutyCompliance: false, immigrationRules: false,
      fullPartyFlightHotelAllocation: !!this.params.behaviorProfiles, partyCohesionEnabled: !!this.params.behaviorProfiles,
      partyRoomSharing: false, nationalityBasedEligibility: false };
    state.metricSemantics = { ...state.metricSemantics, modeledDepartures: 'Cases that boarded a synthetic flight after all implemented readiness and presence checks. Not actual flights or physical prediction.',
      syntheticSeatReservations: 'Finite synthetic seat claims; not issued tickets and not departures.', meanRecoveryElapsedAllCasesSeconds: 'Elapsed time from modeled case creation, capped at modeled departure, for all cases; includes hotel, transport, queues and gate holding.' };
    return state;
  }
  assertInvariants() {
    super.assertInvariants();
    const manifests = new Set(), rooms = new Set();
    for (const hotel of this.hotels.values()) {
      if ((hotel.accommodationRoomCount ?? hotel.rooms.size) > hotel.roomCapacity || hotel.rooms.size > hotel.personCapacity || hotel.occupants.size > hotel.rooms.size || hotel.supportBusy.size > hotel.supportStaff) throw new Error('Hotel capacity violated');
      for (const id of hotel.rooms) { if (rooms.has(id)) throw new Error('Case reserves multiple hotel rooms'); rooms.add(id); }
      for (const id of hotel.occupants) if (!hotel.rooms.has(id)) throw new Error('Hotel occupant without room');
    }
    for (const vehicle of this.vehicles.values()) {
      if (vehicle.passengers.length > vehicle.capacity) throw new Error('Vehicle seat capacity exceeded');
      for (const id of vehicle.passengers) { if (manifests.has(id)) throw new Error('Case in two vehicles'); manifests.add(id); if (this.cases.get(id)?.vehicleId !== vehicle.id) throw new Error('Vehicle case membership mismatch'); }
    }
    for (const passenger of this.cases.values()) {
      if (!!passenger.vehicleId !== manifests.has(passenger.id)) throw new Error('Missing vehicle membership');
      if (passenger.modeledDepartureAt !== null && (rooms.has(passenger.id) || manifests.has(passenger.id) || passenger.activeEncounter)) throw new Error('Departed case still occupies local resource');
    }
    const seatClaims = new Set(), departed = new Set();
    for (const flight of this.flights.values()) {
      if (flight.reservations.size + flight.departedCases.size > flight.seatCapacity) throw new Error('Flight seat capacity exceeded');
      for (const id of flight.reservations) { if (seatClaims.has(id)) throw new Error('Case reserves two flights'); seatClaims.add(id); if (this.cases.get(id)?.flightId !== flight.id) throw new Error('Seat case mismatch'); }
      for (const id of flight.departedCases) { if (departed.has(id)) throw new Error('Case departed twice'); departed.add(id); if (this.cases.get(id)?.modeledDepartureAt !== flight.actualModeledDepartureAt) throw new Error('Departure case mismatch'); }
      if (flight.status === 'departed' && (flight.failureReasons.length || !flight.rampReady || !flight.cateringReady)) throw new Error('Flight departed without readiness');
    }
    for (const gate of this.gates.values()) for (let i = 1; i < gate.flights.length; i++) if (gate.flights[i].start < gate.flights[i - 1].end) throw new Error('Gate overlap');
    for (const resource of [this.security, ...Object.values(this.preparation)]) if (resource.busy.size > resource.staff) throw new Error('Distinct staff capacity violated');
    for (const arrival of this.arrivals.values()) if ([...this.cases.values()].filter((passenger) => passenger.waveId === arrival.waveId).length > arrival.seatCapacity) throw new Error('Inbound case manifest exceeds authored arrival capacity');
    if (this.params.behaviorProfiles) for (const party of this.parties.values()) {
      if (party.expectedSize <= 1) continue;
      const members = party.memberIds.map((id) => this.cases.get(id));
      if (members.length > party.expectedSize || new Set(members.map((p) => p.id)).size !== members.length) throw new Error('Party case conservation');
      if (new Set(members.map((p) => p.destination)).size > 1) throw new Error('Party destination split');
      for (const key of ['flightId', 'hotelId', 'vehicleId', 'modeledDepartureAt']) if (new Set(members.map((p) => p[key])).size > 1) throw new Error(`Party ${key} split`);
      for (const vehicle of this.vehicles.values()) {
        const onBoard = members.filter((p) => vehicle.passengers.includes(p.id)).length;
        if (onBoard && onBoard !== party.expectedSize) throw new Error('Partial party vehicle manifest');
      }
      for (const hotel of this.hotels.values()) {
        const claims = members.filter((p) => hotel.rooms.has(p.id)).length;
        if (claims && claims !== party.expectedSize) throw new Error('Partial party room reservation');
        const occupancy = members.filter((p) => hotel.occupants.has(p.id)).length;
        if (occupancy && occupancy !== party.expectedSize) throw new Error('Partial party hotel arrival');
      }
      for (const flight of this.flights.values()) {
        const claimed = members.filter((p) => flight.reservations.has(p.id)).length, boarded = members.filter((p) => flight.departedCases.has(p.id)).length;
        if ((claimed && claimed !== party.expectedSize) || (boarded && boarded !== party.expectedSize)) throw new Error('Partial party flight claim/departure');
      }
    }
    return true;
  }
}
