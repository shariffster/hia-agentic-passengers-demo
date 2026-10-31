# Passenger inspector contract

The implemented panel currently displays the three selected demo passengers. It is not connected to a 1,500-passenger crowd. Click a passenger's name to select and expand it; Follow also selects it. In the private local 3D preview, clicking a colored world name label selects and follows the same case.

`mountGateDemoPanel` returns `selectPassenger(id)`, `getState()` (including `selectedPassengerId`), `render()` and `dispose()`. Selection changes inspection only, not the simulation clock or controller. All live state comes from `getController().gateDemoState()`.

State data:

- `profiles[]`: stable ID/name/color, `traits.consequenceSensitivity`, `traits.safetyMarginSeconds`, `traits.familiarity`, initial `needs.fatigue`.
- `passengers[]`: ID, state, position, last action, decision count, arrival time, outcome, knowledge, current needs, constraints.
- `log[]`: sequence, simulated time, passenger ID, event type, action, optional seconds, source, model, brief declared summary (`detail`), and observation for accepted actions. Types include proposed, accepted, rejected, fallback, completed and failed.
- `mode`, `policy`, `pendingCount`, `time`, `runId`: shared execution context.

The inspector derives the effective controller label from the latest accepted source: baseline automatic policy, Nosana AI, fallback rules, authored deterministic rules, or recorded Nosana replay (zero new inference). Pending live requests are explicitly labeled. Additional adaptive-rule or background-agent controller types require actual matching runtime state; they must not be inferred merely from passenger count.

The three editable trait fields are bounded. Edits take effect on explicit Restart or controller/source reset, rebuilding the run from the edited profiles. They do not mutate an in-flight model observation. A regression test verifies edited familiarity and safety margin alter the next authored decisions. Resetting one comparison arm alone makes its inputs differ, and the comparison panel reports that mismatch.

The displayed proposed action is a bounded proposal record; validation and applied result are separate. The declared summary is brief model output, not hidden chain-of-thought. Every action and result uses the engine's simulated time. A future large-cohort adapter should supply this same semantic data for a selected ID and virtualize the passenger list, rather than creating 1,500 expanded DOM cards or implying 1,500 live model calls.
