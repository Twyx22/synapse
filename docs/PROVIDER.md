# Provider resilience — v0.18.0

The OpenCode 2.4.1 incident reported by the user was a free usage quota failure,
not evidence of a Toolset Optimizer regression. The previous adapter called
`wait` then treated absent assistant text as a generic empty result. This release
uses four sources of trusted host evidence: the V2 `retry` hook, terminal
`session.execution.failed` / `session.execution.interrupted` events, the last
`idle` context marker, and exceptions from prompt/wait/context. It does not
inspect model prose or parse global OpenCode logs.

## Behavior

- Classifies quota/free-limit/budget-limit, rate-limit, auth, invalid request,
  unavailable, other provider failures, failed/interrupted sessions. Unknown
  unstructured errors retain previous behavior; a log-only host failure may
  remain unclassified. Raw provider details are not stored in the new events.
- For currently managed Synapse sessions, the retry hook vetoes retry for quota,
  rate-limit, auth or invalid request; temporary transport failures retain the
  host's existing retry policy. No new retry is authorized. Other plugins may
  override the hook afterward; this is not an absolute provider request limit.
- A quota/rate-limit/auth failure opens a conservative circuit keyed to the
  current execution's AbortSignal, not a provider account or global project.
  Subsequent tasks in that execution fail without launching a model request;
  already admitted or running sessions may continue. Other graphs and user
  sessions are not blocked. The circuit expires with the execution; it is not
  a persisted cooldown or an automatic recovery scheduler.
- Any recognized terminal failure stops task-level retries, including reviewer
  retry. Previously completed tasks and the worker result awaiting a failed
  review are preserved, but the latter is NOT approved. Dependents remain
  blocked. Explicit new plans still need user approval. No provider/model
  switching, no automatic paid fallback, no changes to permissions.
- A successful explicit submission is still supported if older hosts cannot
  read context. After wait, a best-effort 1-second local context read checks for
  an explicit terminal failure. No additional model generation is requested.
- `agent.provider.failure` and `task.provider_error` export only fixed categories
  and source labels. `plugin.setup.provider` records whether the hook registered
  and a stream was started; registration does not prove delivery. Event stream
  cleanup is tied to plugin unload. Older hosts can use the other evidence
  channels if hook/event support is absent. No inference of quota from zeros.

## Coordinator accounting

`synapse_coordinator_usage` reads only the calling coordinator's cumulative
session aggregate through `session.get`, with a 1.5-second read deadline.
The worker/reviewer/council ledger remains separate. Metrics may include earlier
work and omit the in-flight turn. Missing metrics are not zero. The snapshot is
not persisted or assigned to a particular graph, and is not a provider bill.

`synapse_economic_advice` now marks non-completed runs as ineligible for
performance recommendations. Observed usage remains available for diagnosis.
Experiments retain their existing quality and isolation gates.

## Validation and limitations

The suite includes simulated quota errors reproducing the reported error text,
terminal events and context markers, preservation of previous contributions,
review failure, retry isolation, circuit isolation, diagnostics redaction and
coordinator identity. Real OpenCode 2.4.1 still needs a smoke test and the
standard/lean benchmark with available quota. No need to exhaust quota on
purpose. The npm registry was not reachable from the development environment;
no fresh dependency audit or full SDK integration check was possible.

References: https://opencode.ai/docs/build/plugins/server/ (session retry and
public event subscription); https://opencode.ai/docs/api (session execution
terminal events).
