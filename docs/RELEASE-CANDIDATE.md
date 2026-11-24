# Release candidate verification — v0.19.0

This is a release candidate, not a production certification. No change to the permission model, provider, model selection, required review or XDG schema. Node.js >=22; OpenCode V2 host integration must still be checked against the user's installed SDK.

## Reliability and scope

The run store creates snapshots in an exclusive temporary file and publishes with a hard link in the same directory, then removes the temporary file. Existing run IDs cannot be overwritten by create. The filesystem must support hard links (the cost ledger already uses them). Update serialization applies to one FileStore instance; a second independent writer or process targeting the same directory is unsupported. This is atomic publication, not a power-loss durability guarantee.

A new task attempt resets previous unvalidated attempt-local result and review fields, errors, session references and verification evidence. Completed tasks are not rerun. Orphaned running/review tasks are recovered within the existing attempt limit; previously consumed attempts are not refunded. Provider quota/rate/auth errors still stop new session creation within the same graph. No global breaker, no automatic model fallback, no claims about provider billing.

Host setup (create, switchAgent, update) uses a shared deadline of at most 15 seconds, shortened by the configured task/adapter timeout. This is separate from the subsequent generation deadline. If creation returns after abandonment, no prompt is sent; interrupt is requested. Known session setup errors close the ledger entry as unsettled/usage unavailable. A failed or timed-out host operation can have remote side effects; no automatic retry of a timeout. Explicit stop waits at most 1.5 seconds for interrupt requests; this is not confirmation of remote cessation. Disk operations and custom third-party adapters are not generally bounded.

## Diagnostic fields

`runs.json`: `failureSource` is an optional scalar enum on failed tasks, from the actual provider exception. Older records without a source omit it. Existing logs retain their own observed categories; the exporter does not rewrite past task records.

`economics.json`: up to 12 most recently updated records among those included in the report. `omitted` counts other included records; computation failures are warnings. Not a replay of historical tool replies. Data can be incomplete; failed runs are ineligible for performance recommendations.

`coordinator.json`: exported by the runtime tool when the coordinator usage callback is available, even if usage is unavailable. Only numeric allowlisted usage, fixed metadata and a validated observation timestamp; no coordinator session ID. This is cumulative and separate from graph costs. A CLI export has no live coordinator snapshot. All report bundles are local and require review before sharing.

## Local test matrix

- 147 inherited tests and 10 additional release-candidate tests (157 total).
- 24 competing creates of the same ID; exactly one succeeds, no overwrite.
- 64 concurrent message updates; no loss and failed transaction leaves snapshot intact.
- 32-task dependency graph, 8 maximum slots, simultaneous calls to run the same graph; exactly one admission.
- Source persistence, legacy omission, sanitized coordinator and economic reports.
- Quota during setup and create; no prompt, no wasted retry, graph-local circuit.
- Recovery of an orphan with remaining attempts, stale unvalidated data cleared.
- Remote interrupt never returns; durable cancellation and bounded wait.
- Hung create and policy setup; no retry, late session interruption, unknown usage preserved.

Run `npm test`, and once real dependencies are installed, `npm run typecheck` and `npm audit`. For an offline core typecheck with local Node types: `tsc -p tsconfig.core.json`. A fresh npm install/lockfile could not be generated in the authoring environment (DNS EAI_AGAIN). There is no claim of a clean dependency audit.

## Real host smoke test, no new graph

From the stable install path, run `npm run health`, then create a new OpenCode coordinator session. Call synapse_version, synapse_storage_status, synapse_resource_status, synapse_coordinator_usage and synapse_diagnostics_export. Inspect the returned ZIP. Confirm version, unchanged project identity and historical counts, no new runs, scalar/absent failureSource, economics.json and coordinator.json. No additional worker or reviewer needed. Real Lean performance validation is deferred until the provider quota permits a controlled benchmark.

## Remaining release gates

Full SDK typecheck and npm audit; successful real Lean run and controlled standard/lean pair; real provider circuit behavior with multiple agents; meaningful multi-agent coding task and review; single-writer deployment policy and restart/hot-reload behavior. No numerical production-maturity claim is justified by unit tests alone.
