/** Public schematic display adapter. No airport geometry, seats or formation data. */
export class StationaryAllocator {
  constructor(nodes, services) { this.nodes = nodes; }
  sync() {} // The simulation owns all positions, activity and time.
  routePosition(passenger, engine) {
    const point = engine.positionFor(passenger);
    return point ? [...point] : null;
  }
  snapshot(passenger, time, semanticPosition) {
    return semanticPosition ? {
      kind:'semantic', status:'schematic_positioned',
      caseId:passenger.id, displayPosition:[...semanticPosition],
      moving:!!passenger.route, illustrative:true,
      notice:'Semantic position on a synthetic corridor; no airport display geometry.',
    } : null;
  }
}
