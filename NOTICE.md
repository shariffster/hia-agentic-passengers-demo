# Source provenance and limits

Prepared 31 October 2026 for a standalone, schematic passenger decision demonstration.

The following JavaScript files are retained from the isolated HIA gate-agent candidate, including a privacy edit to a legacy notice and comment in `recovery-simulation.js`:

- `web/gate-agent-demo.js`: three-profile controller, bounded decisions and run isolation.
- `web/recovery-world.js`: persistent cases, flight resources and synthetic departure checks.
- `web/recovery-simulation.js`: event clock, routing, assistance and case state.
- `web/simulation.js`: seeded random generator, graph router and underlying queue engine.

Their source notices describe synthetic experiments and limitations. Retaining these files does not claim the full original airport simulation is present. File hashes are recorded in `EXPORT-MANIFEST.json`; the export must be rehashed after subsequent source changes.

The original `holding-layout.js` and its `waiting-seat-data.js`, `movement-layout-data.js` and `formation-envelope-data.js` dependencies are **excluded**. A newly written semantic display adapter implements the four methods used by the retained engine and adds no airport geometry, queue positions, seating data, capacity or separate clock.

`web/synthetic-graph.js` is a new three-node fixture: a 120 m segment plus one short junction edge. Identifiers `a_0`, `a_1` and `plaza_north` are retained for controller compatibility; their new coordinates are invented schematic data. They are not a map, surveyed path or navigation advice.

The SVG page and styling are new. The decision panel derives from the new local candidate panel, with public schematic labels and a smaller profile-input bound. The proxy and its tests are retained from the new local candidate. Test graph loading and coordinate assertions are adapted to the public synthetic fixture; behavioral assertions remain.

No original GLB, Blender source, photograph, map, logo, airline identity, airport dataset, screenshot, archived release, local adoption pointer, local path, account configuration or credential is included. No Three.js, MapLibre, meshoptimizer or other vendored library is needed by this standalone version. Browser and Python/Node standard-library APIs supply its runtime.

No explicit licence file or SPDX grant was found in the inspected source subset. This notice records provenance and exclusion boundaries; it does not create a licence, establish ownership of every upstream contribution or grant rights to the separate HIA project. No official airport or sponsor relationship is implied.
