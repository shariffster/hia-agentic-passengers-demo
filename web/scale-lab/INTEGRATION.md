> Retained upstream handoff guidance. The integration owner has since supplied and browser-verified the separate page in this folder; see NOTICE.md. Statements below about pending rendering describe the original handoff.

# Smallest safe owner-reviewed integration

Keep the working three-passenger live demo. Add a separate optional **Scale lab: 1,500 rule-controlled / 0 live LLM** view, with a link back to the live demo. This is the smallest integration that the evidence supports before the deadline. Do not silently combine independent clocks or count the separate three live cases as selected cases inside this run.

The existing HIA Flow marker capacity is sufficient in source, but its original holding allocator produced a roughly 1.1-second event spike at N=1500. Full engine snapshots cost roughly 16.6 ms before drawing. The optional worker isolates simulation bursts, and density frames avoid shipping full logs/snapshots on every animation frame.

Copy only this reviewed package into an optional served folder. No edit to the main engine is required. A browser module can use:

```js
const worker = new Worker('./scale-lab/scale-worker.js', {type: 'module'});
let runId, waiting = false;
worker.onmessage = ({data}) => {
  if (!data.ok) { showError(data.error); waiting = false; return; }
  if (data.requestId === 'start') runId = data.runId;
  if (data.runId !== runId) return; // ignore old-run responses
  waiting = false;
  // Macro count cells and DEMO-1/2/3 share data.frame.time.
  // Render policyCounts.liveLLM (0) and deterministicRule (1500).
  renderDensityAndSelected(data.frame);
};
worker.postMessage({type: 'start', requestId: 'start',
  options: {count: 1500, mode: 'agent'}, densityOnly: true});

function advance(targetSeconds) {
  if (!runId || waiting) return;
  waiting = true;
  worker.postMessage({type: 'advance', requestId: `t-${targetSeconds}`,
    runId, time: targetSeconds, densityOnly: true});
}
```

`renderDensityAndSelected` and `showError` are integration hooks, not supplied UI. Browser worker startup, actual rendering and owner-side UI integration remain untested. Serve as modules from the existing owner-controlled server; this task has not started or restarted a server.

Default graph is invented and portable. For local HIA source integration only, the lead can explicitly supply the already-loaded adopted spatial object in `options.spatial`; the macro frame then reports actual semantic graph coordinates from that object. Do not include that private graph in the public repository. A claimed full-HIA rendering result still needs a real browser check.

Use `frame.points` only if individual overlapping semantic positions are useful. Prefer `densityOnly:true` for this repeated-profile load test. Cells are count bins, not measured physical crowd density. Do not distribute overlapping cases across random coordinates just to imply 1,500 distinct physical placements.

For baseline comparison, start a new run with `mode:'baseline'` at the same N; the engine's fixed initial profiles, graph, seed and events remain matched. Wait for its new `runId` and use its own achieved clock. A future mixed policy with three live selected agents needs deliberate shared-engine decision injection, stale-response handling and separate bounded inference tests by the lead; that is not implemented or asserted here.

Acceptance before adding a UI claim: verify the actual count and policy legend, macro/micro time agreement, play/pause/reset, no stale run updates, meaningful density aggregation, and sustained frames on the presentation Mac. If that cannot be completed in time, show the benchmark as headless evidence and retain the live three-agent demonstration.
