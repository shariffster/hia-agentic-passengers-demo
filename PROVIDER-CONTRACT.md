# HIA local model adapter

This isolated candidate uses a same-origin, loopback-only server. It never writes credentials. Model configuration is optional; without it, the browser must display deterministic/mock policy or an unavailable model state, never live LLM operation.

Start from this directory with `python3 server.py --port 58740`. The server binds `127.0.0.1` only and serves `web/`; it does not alter the adopted HIA build. A port conflict fails startup instead of replacing another service. Port 58740 has not been reserved by this module.

`GET /api/agent/status` returns `configured`, `status`, `provider`, `protocol`, and `connectivity: "not_probed"`. Configured means the configuration is structurally present, not that authentication, credits, model availability or inference have been verified. A successful `/decide` response is evidence for that individual call only.

Status also exposes `requestCap`, `upstreamAttempts` and `remainingRequests`. The server allows at most **30 upstream attempts per process**, shared atomically across concurrent requests. Failures/timeouts consume an attempt; invalid client requests and missing configuration do not. The next request after exhaustion returns HTTP 429 `request_limit_reached` without contacting the provider. `--request-cap N` may lower the cap to 1–30. This count limit is **not a dollar budget** and does not measure credit use; the approved existing-credit limit and no-top-up constraint remain separate. Restarting a process resets its count, so it must not be used to bypass the agreed limit.

For a cumulative guard across restarts, add `--usage-ledger /tmp/hia-agent-demo-usage.json`. The ledger and its lock file stay outside `web/`, are owned by the user with no group/other permissions, and contain only request counts, sanitized token usage and cost-reserve metadata. File locking and atomic replacement serialize concurrent processes. Corruption, insecure permissions or deletion of an existing ledger fail closed. Neither credentials nor request/response content are saved.

The persistent ledger enforces both the original request cap (at most 30 cumulative attempts) and a **$9 conservative estimated-cost guard**. Each call reserves $0.010048 before contacting Nosana: 40,000 input-token allowance for the bounded 32 KiB observation request plus system/protocol overhead, and 1,024 output tokens at the verified rates. Valid reported usage replaces that reservation. Missing usage, timeouts or crashed calls retain the conservative reservation. A new call that would exceed the $9 guard is rejected with `estimated_spend_limit_reached`. Status exposes `guardEstimatedCostUSD`, `guardLimitUSD`, `persistentUsageLedger` and `reservedOrUnresolvedAttempts`. The ordinary `estimatedCostUSD` remains the reported-usage subtotal.

A newly created ledger cannot infer earlier calls. `--initial-spend-reserve-usd .05` can conservatively account for the coordinating thread's known pre-ledger calls; it applies only on first creation and cannot reset an existing reserve. Preserve and reuse the same ledger rather than creating a new one. This local estimate cannot measure provider fees, unrelated account use or actual billing; the approved $10 existing-credit ceiling and no-top-up restriction remain separate. No ledger or runtime server is created/restarted by this documentation.

Successful results include the configured `model` and sanitized `usage` (`prompt_tokens`, `completion_tokens`, `total_tokens`), or null when usage is missing/invalid. Status accumulates `reportedTokens`, `responsesWithUsage` and `responsesWithoutUsage` across received upstream responses, including rejected action JSON. Only nonnegative integer usage counts are accepted; response text and credentials are never retained in the tally. `estimatedCostUSD` is available only for the verified Nosana-hosted `qwen/qwen3.8-27b` model at $0.20/M input tokens and $2/M output tokens. It is an estimate from reported tokens, not a bill, account balance or credit enforcement. Missing usage is explicitly counted and excluded from the estimate. The account's approved $10 existing-credit ceiling and no-top-up restriction still apply. The proxy retains a 30-attempt limit and requests at most 1,024 output tokens per OpenAI-compatible call.

`POST /api/agent/decide`, with `Content-Type: application/json`, accepts exactly these top-level fields:

```json
{
  "requestId": "decision-1",
  "runId": "run-1",
  "passengerId": "passenger-1",
  "observation": {
    "time": 60,
    "publishedGate": "a_1",
    "currentState": "awaiting_recovery"
  },
  "allowedActions": ["go_to_announced_gate", "read_board", "wait"]
}
```

Identities must be nonempty strings of at most 128 characters. The entire request is limited to 32 KiB. The observation is an application-owned JSON object containing only facts the passenger may know. The client remains responsible for excluding hidden operational and future state.

A successful response echoes the identities:

```json
{
  "requestId": "decision-1",
  "runId": "run-1",
  "passengerId": "passenger-1",
  "action": { "type": "go_to_announced_gate" },
  "summary": "Move to the announced gate with time in reserve.",
  "source": "live",
  "provider": "JSON endpoint"
}
```

`wait` requires `seconds` between 1 and 30. Other actions do not carry arbitrary parameters. Summaries are normalized and capped at 160 characters. They are model-supplied decision summaries, not evidence of internal reasoning. The browser must render them as text, validate actions against current state, reject responses from stale runs/requests, and record execution results separately. The proxy never executes actions or model code.

Runtime configuration names, supplied server-side only after the required setup authorization:

| Variable | Meaning |
|---|---|
| `HIA_AGENT_ENDPOINT` | Complete HTTPS inference URL. HTTP is allowed only for a loopback development endpoint. |
| `HIA_AGENT_PROTOCOL` | `json` (default) or `openai_compatible`. |
| `HIA_AGENT_API_KEY` | Optional bearer credential, held only by the server process. Never put it in web files or browser storage. |
| `HIA_AGENT_MODEL` | Optional model name for JSON mode; required for OpenAI-compatible mode. |

Environment configuration remains the default. An explicitly prepared private JSON file can instead be loaded with:

```sh
python3 -B server.py --port 58740 --config-file /tmp/hia-agent-demo-runtime.json
```

The file contains only the four variable names above with string values. It must be owned by the current user, be a regular file with no group/other permissions (normally mode `0600`), and be outside `web/`. Symlinks, publicly readable files, invalid/oversized JSON and unsupported fields are rejected. Config-file values are never printed or merged with ambient environment values. The existing preview must be deliberately restarted by its owner to load a new configuration; this module does not restart it automatically. The designated credential owner creates the key and file; other workers must not duplicate that action or inspect the key.

Provider identity is derived from the configured endpoint hostname only. Exactly `inference.nosana.com` is labelled `Nosana hosted inference`; other endpoints retain a generic protocol label. Neither endpoint URLs nor credentials are returned in status.

JSON mode posts the original request, adding `model` only if configured, and expects `{ "action": { ... }, "summary": "..." }` directly.

OpenAI-compatible mode posts `model`, nonstreaming `messages` and a small output limit to the complete endpoint URL. It parses `choices[0].message.content` as JSON and validates the action. JSON schema enforcement is not assumed. Strict JSON or a single fenced JSON object is accepted; extra prose is rejected. No tools are exposed.

For exactly `qwen/qwen3.8-27b` on `inference.nosana.com`, the system message ends with the advisory `/no_think` switch documented in [Qwen3's official README](https://github.com/QwenLM/Qwen3/blob/main/README.md). Other models/providers receive no such suffix. Hosted support and its effect on latency/output availability are not guaranteed; successful structured responses and observed latency must still be verified per call. The 1,024-token output limit, 40-second timeout, action validation and persistent usage guard remain authoritative. No reasoning transcript is exposed or logged.

The parent coordination thread identified `https://inference.nosana.com/v1/chat/completions` as an optional OpenAI-compatible endpoint, with model names discoverable through its `/v1/models` API. A user-supplied Nosana bearer credential with inference permission and an available model would still need an explicitly authorized setup and a successful call. This implementation has not configured or contacted that service.

Missing configuration returns HTTP 503; provider timeout returns 504; unavailable/rejected/invalid upstream responses return 502. Responses use sanitized error codes and never relay upstream response bodies, URLs or headers. There are no automatic retries and no automatic claim that a fallback is live. The upstream timeout is forty seconds; the client should allow at least 45 seconds before its own timeout. A response with finish_reason=length returns provider_output_truncated; its reported usage is still tallied, and no model reasoning text is logged. Redirects are not followed, preventing bearer credentials from being forwarded to another target.

The server accepts only the expected loopback Host and matching Origin. It serves no directory listings, dotfiles, parent paths or symlinks escaping `web/`. It emits no credential-bearing request logs. No account, purchase, key generation, deployment or persistent secret setup is performed by this module.

Run proxy tests with `python3 -B -m unittest discover -s tests -p 'test_server.py' -v`. Tests use temporary fixtures and ephemeral loopback servers only, never external providers.
