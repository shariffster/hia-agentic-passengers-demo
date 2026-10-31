# Passenger selection contract

Every stable ID `DEMO-1` through `DEMO-1500` can be selected. `controller.inspectPassenger(selectedPassengerId)` (alias `exportPassenger`) returns a detached read-only record. Inspection never triggers a decision or advances time.

```js
worker.postMessage({type: 'inspect', requestId: 'selection-1500',
  runId, passengerId: 'DEMO-1500'});
// response: {requestId, runId, ok: true, inspector: {...}}
```

The UI owns `selectedPassengerId`; ignore replies from old runs or older selection request IDs. Refresh inspection after a new achieved frame, or when selection changes. The worker rejects stale run IDs. Do not inspect all 1,500 cases every animation frame: detailed records are fetched on selection, while macro frames carry the stable IDs.

`hia.scale.passenger-inspector/1` contains:

| Field | Meaning |
| --- | --- |
| `passengerId`, `selectedPassengerId` | Same stable case ID |
| `controllerType` | `adaptive_rule` for the deterministic authored policy, `automatic_baseline` for automatic rerouting |
| `policyLabel`, `modelDriven`, `background`, `liveModel` | Explicit visible policy evidence; this lab reports false / false / null for the last three |
| `profile` | ID, name, profile type, colour, authored traits and initial needs |
| `observedAt`, `observedState` | Achieved simulation time, current activity/position, knowledge, current needs, constraints and published flight facts |
| `decisionCount` | Actual rule decision count for this case; automatic baseline actions are not labelled model decisions |
| `lastDecision` | Acceptance time, event sequence, source, action and authored summary |
| `lastAction` | Action type, optional bounded wait seconds, acceptance time |
| `lastResult` | Completion/rejection time, sequence, action and result detail; null until one exists |
| `timestamps` | Creation, observation, last decision/result, gate arrival and synthetic departure times |
| `outcome` | `not_departed` or `synthetic_departed`, plus modeled departure time |

All timestamps are seconds on the one engine clock. Missing events are null. The inspector excludes future event queues and unannounced operational gate changes. A decision summary is declared policy text, not a claim about hidden reasoning.

The broader UI may also support `model_driven` and `background` types, but neither occurs in this lab. Reserve `model_driven` for actual individually validated live-model control, and `background` for visual/scripted population that has no agent decision state. Do not classify this lab's 1,500 rule agents as model-driven or visual background. Its selected three are the same rule-controlled cases, not the separate live-Nosana demo's run.
