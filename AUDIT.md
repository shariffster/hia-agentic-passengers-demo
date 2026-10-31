# Standalone export audit

Audit time: 2026-10-31 09:14 UTC. This records verification of the standalone export.

## Verification

- **13/13 JavaScript controller tests passed** against the new three-node synthetic graph. Both arms keep the same profiles, speed, seed, schedule and information. Baseline gate arrivals are 113/113/113 seconds; the deterministic agent policy yields 113/116/128 seconds. Both achieve three synthetic departures at 241 seconds.
- **23/23 Python proxy tests passed**, including protected configuration, missing configuration, request/response validation, hostile origin/host rejection, static path containment, sanitized errors, redirects and the 30-attempt request cap. Tests used only mocks and temporary loopback listeners. The initial sandbox blocked listener binding; an approved test rerun passed.
- `node --check` passed for the new standalone renderer, panel, semantic display adapter and synthetic graph.
- All four controller/engine files match the isolated candidate at export, including removal of personal narrative from a legacy notice and comment. `server.py` matches the finalized local proxy source. Exact hashes are in `EXPORT-MANIFEST.json`.
- Every relative JavaScript import resolves within the export. The only non-relative test imports are Node built-ins. There are no npm dependencies or vendor files.

## Inclusion and privacy inspection

The export is an explicit allowlist, not a copy of the airport tree. No original asset, dataset, binary model, original image or screenshot, archive, release history, adoption pointer, configuration file, `.env` file or symlink is present.

Independent review identified a legacy personal narrative in two source comments after initial publication; those comments were replaced with generic synthetic-model language in both the isolated candidate and public export. A bounded text scan found no personal absolute filesystem paths or provider-token-shaped strings. The only email-shaped match is an intentionally invalid `name:password@example.org` URL in a proxy rejection test. Other credentials in tests are declared fake fixtures. Environment/configuration field names are not credentials; no runtime environment or real configuration file was read for this audit.

The original airport waiting-seat, movement-layout and formation-envelope data are absent. The new `holding-layout.js` returns copies of semantic positions only. SVG visual lanes separate markers for inspection and add no simulation state, route distance, delay or clock.

## Limits

This audit does not claim ownership or licence clearance for every historical engine contribution. No new licence grant is attached. The retained engine's synthetic-model notices and source provenance remain visible.

No real model provider was called during these tests. Mock/injected test replies do not prove production inference connectivity. The public UI must continue to distinguish configured, successful live, unavailable and fallback states.

Rendered browser verification completed at 09:15 UTC: visible Run gate change, Run to outcome and Baseline controls produced baseline arrivals 113/113/113s and deterministic agent arrivals 113/116/128s at matched achieved time241s, with three synthetic departures in both arms. The new schematic screenshot in docs/demo-preview.png contains only this sanitized page. An initial favicon404 was fixed with an authored data-URI icon. The standalone page exposes `window.__PASSENGER_DEMO.getState()` for bounded observation. No external deployment or repository publication was performed by this export task.

The manifest hashes all included files other than the manifest itself. Its content identity is SHA-256 of sorted `sha256`, two spaces, relative path and newline records. Recompute it after any change.
