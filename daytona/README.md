# HIA passenger replay on Daytona

This runner executes the **same sanitised HIA passenger engine** in a disposable Daytona sandbox. It compares the existing baseline with bounded recorded passenger actions, downloads the results, and requires exact agreement with the local result before reporting success.

The final verified example replays **four accepted Nosana decisions for three passengers, with zero fallbacks**, from the completed public-corridor demo. Daytona runs the simulation and recorded actions; no model key is uploaded and no new inference runs there. An authored mock fixture is also available.

## Verified result

Four real Daytona sandbox executions completed on 31 October 2026. All matched local results and all sandboxes were deleted. The final all-live recorded-action run lasted from 09:40:13 to 09:40:22 UTC on `daytona-small`: 1 vCPU, 1 GiB RAM, 3 GiB disk.

| Passenger | Recorded decisions | Baseline arrival | Replay arrival |
|---|---|---:|---:|
| DEMO-1 / Alex | Go to announced gate at 13s | 113s | 113s |
| DEMO-2 / Sam | Read board at 13s; go at 16s | 113s | 116s |
| DEMO-3 / Jo | Go to announced gate at 13s | 113s | 113s |

All four accepted actions came from Nosana model `qwen/qwen3.8-27b`. There were **zero fallback or mock actions** in this final trace. The original completed run was captured at simulation time 241; the replay advances to 260. Original arrivals and outcomes also match. Every recorded action was consumed and both arms retained valid invariants.

See `evidence/daytona-run.json`, `evidence/recorded-trace.json`, `evidence/source-record.json` and `evidence/report.html` in the public handoff package. The development receipt is `artifacts/nosana-all-live-daytona.json`. Earlier authored mock evidence remains separately labelled in `evidence/authored-mock-run.json`; the earlier mixed live/fallback run remains in development artifacts and is not the final demonstration.

The source recording and replay both use the sanitised public 120m corridor. Only accepted action tuples and canonical synthetic inputs were extracted. Model summaries and observations were discarded. This demonstrates reproducible execution, not improved passenger performance or a calibrated airport forecast.

## Run locally

Requires Node.js 20 or newer. Local runs and tests need no packages, account, credentials or network.

```sh
npm test
node cli.mjs local --out artifacts/local.json
node cli.mjs fixture --out artifacts/mock-trace.json
```

## Run on Daytona

Install the pinned official SDK with `npm ci --ignore-scripts`. Keep the key outside this directory in an owner-only regular JSON file containing only `DAYTONA_API_KEY`; use mode 0600. Do not place it in a command argument, source file or browser-facing server.

```sh
node cli.mjs daytona \
  --credential-file /private/path/daytona-runtime.json \
  --credit-cap-usd 0.01 \
  --out artifacts/daytona.json
```

This makes one creation attempt, uploads ten allowlisted files, runs the Node entrypoint with a 30-second execution timeout, downloads the JSON, compares it with local execution, and deletes the sandbox while waiting for confirmation. An uncertain creation is looked up by its unique name for cleanup; it is never blindly recreated.

Resource guards require exactly 1 vCPU and 1 GiB memory and at most 3 GiB disk. The sandbox is private, has outbound networking blocked, auto-stops after two minutes, auto-deletes on stop, and has a five-minute wall-clock TTL. There are no inference credentials or dependencies inside the uploaded bundle.

At the [published pricing](https://www.daytona.io/pricing), five minutes of this CPU and memory is approximately $0.00555. The first three sandbox lifecycles took about 5.4 seconds each; the final run took 9.4 seconds. Their combined compute/memory estimate using full lifecycle time is approximately $0.00047, below $0.001; this is not a settled invoice. `--credit-cap-usd` rejects a budget below the five-minute estimate; it is **not a provider-enforced dollar limit**. There are no top-up, purchase or card operations.

The tested key allows sandbox write/delete and has no billing, secret, snapshot-write or administrator permissions. Use a short expiry. Daytona grants implicit sandbox access to API keys; the dashboard cannot scope this key to only one sandbox.

## Replay a real public-demo run

Export the agent run after it has completed all decisions, then:

```sh
node cli.mjs convert --export /path/public-demo-export.json --out artifacts/recorded-trace.json
node cli.mjs daytona --trace artifacts/recorded-trace.json \
  --credential-file /private/path/daytona-runtime.json \
  --credit-cap-usd 0.01 --out artifacts/recorded-daytona.json
```

The converter accepts the original `hia.gate-agent-demo/1` export. It requires the three canonical synthetic identities, no pending decisions, and a120m/100s route at the initial announcement compatible with the public corridor. It never copies original geometry. It extracts only canonical profiles, scenario inputs, simulation time, action tuples and per-action source labels; raw model summaries, observations and request identities are not uploaded. Provenance distinguishes authored mock, recorded live, fallback and mixed actions. Recorded provenance is a claim from the supplied export, not fresh inference or a cryptographic provider attestation.

Every recorded action must be consumed at the same passenger simulation time. Missing, extra, unavailable, invalid and out-of-time actions fail the run. A controller fallback cannot quietly become successful replay.

## Contract

Input `hia.daytona.replay/1` has `graphId`, `provenance`, `inputs`, canonical `profiles`, a 200–600 second `horizonSeconds`, and up to 30 `{passengerId,time,action,source}` entries.

Output `hia.daytona.execution/1` contains `execution`, `result` and `sourceFiles`. A genuine completed run requires all of:

- `execution.status === "live_verified"`
- `execution.resultMatchesLocal === true`
- `execution.cleanup === "deleted"`
- `execution.provider === "Daytona"`

The deterministic `result` includes baseline and replay passenger outcomes, event logs, invariants, arrival deltas, provenance and the trace hash. `inferenceExecuted` is always false. Local-only results say `local_verified`; failed or uncertain cleanup never says `live_verified`.

The six `vendor/` modules are copied unchanged from the sanitised public HIA export and pinned in `engine-manifest.json`. Updating the lead engine requires an intentional copy/hash refresh and another verification; the runner never modifies or automatically follows the lead workspace.

## Tests and limitations

Eight tests verify deterministic results; strict trace validation; bundle allowlisting and pinned hashes; successful lifecycle; upload/execution/download/uncertain-create cleanup; budget rejection; deletion failure; remote-result mismatch; and preservation of mixed live/fallback provenance without model calls.

Live Daytona execution and deletion are verified. Replay of the completed all-live Nosana trace is verified locally and in Daytona, with four accepted model actions and zero fallbacks. Mixed-source handling is separately tested and was also verified in an earlier sandbox run. No UI, hosting, private HIA assets, Neo4j, or deployment changes are included.

API lifecycle follows the official [Daytona SDK](https://www.daytona.io/docs/en/typescript-sdk/daytona/), [file system](https://www.daytona.io/docs/en/typescript-sdk/file-system/) and [process](https://www.daytona.io/docs/en/typescript-sdk/process/) references, checked 31 October 2026.
