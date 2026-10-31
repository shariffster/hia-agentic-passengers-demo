# Recorded-action replay

Use this standalone export for sandbox experiments. Its three-node graph is invented. The local HIA preview has different coordinates and private rendering assets; do not copy those into this package.

Engine entry: `web/gate-agent-demo.js`, exporting `createGateDemoController`, `DEFAULT_PROFILES`, `DEMO_INPUTS`, and `validateAction`. Dependencies: `recovery-world.js`, `recovery-simulation.js`, `simulation.js`, and the semantic-only `holding-layout.js`. Public spatial fixture: `SYNTHETIC_SPATIAL` from `web/synthetic-graph.js`.

An exported run has schema `hia.gate-agent-demo/1`, `comparisonInputs` (seed, speed, schedule, gates and profiles), and an ordered `log`. For replay, select `type === 'accepted'` entries and retain `passengerId`, `time`, `sequence`, `action`, and optional `seconds`. Queue records separately for each passenger; simultaneous requests may complete in a different cross-passenger order. Recorded actions are input data and must pass the same validator again.

Create a controller with the same profiles and `mode:'agent'`. Inject a `decide(request)` function that consumes that passenger's next recorded action, checks its time against `request.observation.time`, and returns:

```js
{
  requestId: request.requestId,
  runId: request.runId,
  passengerId: request.passengerId,
  action: {type: recorded.action, ...(recorded.seconds === undefined ? {} : {seconds: recorded.seconds})},
  summary: 'Recorded action replay; no model request.'
}
```

The injection hook is selected by the controller's `policy:'live'` plumbing. A replay runner **must label its overall result `recorded_action_replay`, `externalModelCalls:0`** and must not present that internal policy flag as live inference evidence. The browser's real live mode instead uses the same-origin server endpoint. A fixed mock run uses `policy:'mock'` and requires no injection or credentials.

Call `controller.step(delta)` followed by `await controller.resolveDecisions()` until the requested achieved time. The engine holds its clock at decision boundaries; a large step may therefore stop early. Check `getTime()` rather than assuming the entire delta elapsed. Check `assertInvariants()` after each step and verify every recorded action was consumed. Dispose each controller after use.

Compare per-passenger action times, arrival times and outcomes at the same achieved time. Ignore run IDs, wall-clock timestamps, callback ordering among simultaneous requests and declared summaries. Model decisions are nondeterministic; recorded replay is deterministic. Seed42 controls the engine fixture, not a remote model.

Reference fixture at time241: baseline arrivals113/113/113; authored mock arrivals113/116/128; three synthetic departures in each arm. The mock's first three actions at time13 are go, read-board, wait15; Sam goes at16 and Jo goes at28. All use the same speed1.2m/s and published gate announcement. These examples are tests of execution, not calibrated human behavior.
