# Changelog

Notable changes by version. Earlier development notes are kept in [docs/CHANGELOG.md](docs/CHANGELOG.md).


## 1.0.0 — Collective Intelligence

### Added and changed
- Cooperative disk locks for graph updates and execution admission; competing instances cannot execute or stop the same graph while the owner holds the execution lease.
- Cooperative proposal update/deliberation and evolution configuration locks. Atomic exclusive proposal creation.
- `synapse_doctor` and `npm run doctor` report local graph inventory, outstanding locks, storage integrity, retained ledger status and (in runtime) local resources. No models or repairs.
- Separate functional completion from economic eligibility. Legacy `performanceEligible` is stricter and requires clean retained input metrics and minimum recorded session coverage. No invented historical usage.
- Storage doctor reports outstanding locks, diagnostic storage snapshot exports counts, installer preserves a private copy of the initialized target XDG store and refuses outstanding target locks.
- Existing storage schemas and dependency declarations unchanged.

### Validation
164 local tests passed (157 inherited + 7 new). Core TypeScript check passed. Four independent Node processes performed 64 read-modify-write updates without losing events. Tests also cover competing execution/stop, crash locks, release after exceptions, economic coverage, doctor authorization and concurrent evolution config updates.

A subsequent real-host diagnostic confirmed plugin activation. Not certified: complete SDK typecheck, fresh dependency audit, successful real Lean benchmark or complex multi-agent coding mission. Single-writer deployment remains recommended; no global distributed lock or power-loss durability guarantee. See docs/V1.md.


## Synapse v0.19.0 — Release Candidate

### Reliability
- Publish new run snapshots atomically without overwriting existing IDs; concurrent creation leaves no temporary files in normal execution.
- Clear stale attempt-local result, review, error, session and verification metadata when a new attempt begins. Completed tasks remain untouched.
- Bound OpenCode session creation, agent switching and permission setup by a shared setup deadline (15 seconds or the shorter configured task/adapter deadline). Late-created sessions never receive a prompt; interruption is requested best effort.
- Classify provider errors during creation and setup; hard quota/rate/auth failures trip the existing graph-local circuit. Close known setup-failure ledger entries with unknown usage rather than a fabricated zero. No automatic model fallback.
- Bound waiting for explicit stop() interruption requests (1.5 seconds); remote cessation is not certified.

### Diagnostics
- Persist the actual observed failureSource enum on provider failures. Export only valid scalar sources, and omit unknown historical or successful sources; no retroactive guesses.
- Export economics.json for up to 12 latest included runs, with explicit omission count. Recommendations are recomputed from current retained observations.
- Export coordinator.json when the runtime export tool can obtain the caller's cumulative usage. Numeric allowlist only; session ID and unrelated fields omitted. Not combined with graph costs. CLI reports do not invent this snapshot.

### Validation and limitations
- 157 local tests pass (147 baseline + 10 new); core TypeScript check passes.
- Stress: 32-task DAG with 8 slots, 64 concurrent updates on one FileStore, 24 competing creates; injected setup failures, timeout, interruption and orphan recovery.
- No new dependency or XDG migration. Fresh npm resolution failed with EAI_AGAIN; no current dependency audit or full real-SDK typecheck is certified.
- One engine/store instance only: multiple independent writers to the same data directory remain unsupported. Remote interruption is best effort, and power-loss durability is not guaranteed by atomic publication alone.
- No real model calls were made. Lean benchmark, multi-agent provider circuit on the real host, economic routing and complex project validation remain open.

See docs/RELEASE-CANDIDATE.md.

## Synapse v0.18.0 — Production Readiness / Provider Resilience

### Added
- Typed provider failure categories and conservative task-level stop on terminal failures.
- Scoped OpenCode V2 retry veto, terminal event observation and terminal context inspection.
- Graph-local circuit on quota, rate-limit and authentication failure; no automatic provider/model fallback.
- Read-only cumulative coordinator usage snapshot, kept separate from graph cost accounting.
- Sanitized provider failure telemetry and economic eligibility marker for incomplete runs.
- Regression tests for actual incident shape, context and event handling, review failure, circuit isolation, diagnostics and coordinator accounting.

### Compatibility
- No new dependencies or data migration. Existing XDG records remain compatible.
- Installer continues to back up configuration and verify actual plugin activation.
- Node 22 strip-only syntax; existing opt-in lean profile remains unchanged.
- Real OpenCode host validation, fresh npm audit and model-level cost routing remain pending.

See docs/PROVIDER.md for scope and limitations.

## Synapse v0.17.0 — Specialized Intelligence

- Optional `toolProfile: "lean"` for exact-fixture tasks with explicit submission and no patch. Preserves mandatory communication tools and independent reviews.
- Request-scoped `context` hook removes unnecessary tool definitions from active opted-in worker sessions only. No mutation of global tool registration or permissions. Missing required direct tools (including Code Mode), unsupported hook and immutable registry fall back without filtering.
- Metadata-only diagnostics: profile, filtering outcome, before/after counts and serialized schema character sizes, not token counts. No raw tool descriptions or fixture answers exported.
- Existing plan fingerprints include the optional profile; concurrency experiments reject different profiles. Manual comparisons must be labelled as such.
- Retained persistent XDG data, installer health check, graph session budget, and contracts. No dependency changes or migration.
- 136 local automated tests; core TypeScript checked. Actual host hook compatibility and token savings pending real integration. Coordinator accounting, automatic model routing and fresh dependency audit not included.

## Synapse v0.16.0 — Lean Intelligence

- Optional exact fixture checks, gated by explicit submission; no replacement of a required independent review. Mismatch retries remain bounded and dependencies remain blocked on failure.
- Optional graph session budget admission check includes all planned attempts and reviewer protocol retries. No hard monetary budget.
- Coordinator-only lean advice and offline CLI, with exact-check status and conservative session envelope.
- Diagnostics export check outcomes without expected answers; experiment fingerprints include the new plan fields.
- Existing storage, installer health checks and permissions retained. No new dependencies or migration.
- Toolset optimizer, automatic routing and coordinator accounting remain unimplemented.
## Synapse v0.15.0 — Economic Strategy & Runtime Reliability

- Targeted deduplication of verified local Synapse package declarations in the selected configuration, with backups; ambiguous/custom entries are not silently changed.
- Bounded project-specific OpenCode API health check, integrated in the Bash installer; nonzero exit when activation is not verified.
- New coordinator-only economic advice tool and offline CLI: structural concurrency, separate cache/input metrics, conservative profile reconciliation and review input share.
- Per-pair economic observations in experimental evaluation, gated by fixture correctness, local isolation and metric coverage. No automatic adoption.
- Retained XDG storage and existing task/review/permission contracts; no new dependencies or migration.
- Runtime version check remains a separate explicit step. No claim of measured cost savings or actual host toolset reduction.

## Synapse v0.16.0 — Lean Intelligence

- Optional exact fixture checks, gated by explicit submission; no replacement of a required independent review. Mismatch retries remain bounded and dependencies remain blocked on failure.
- Optional graph session budget admission check includes all planned attempts and reviewer protocol retries. No hard monetary budget.
- Coordinator-only lean advice and offline CLI, with exact-check status and conservative session envelope.
- Diagnostics export check outcomes without expected answers; experiment fingerprints include the new plan fields.
- Existing storage, installer health checks and permissions retained. No new dependencies or migration.
- Toolset optimizer, automatic routing and coordinator accounting remain unimplemented.
## Synapse v0.15.0 — Economic Strategy & Runtime Reliability

- Targeted deduplication of verified local Synapse package declarations in the selected configuration, with backups; ambiguous/custom entries are not silently changed.
- Bounded project-specific OpenCode API health check, integrated in the Bash installer; nonzero exit when activation is not verified.
- New coordinator-only economic advice tool and offline CLI: structural concurrency, separate cache/input metrics, conservative profile reconciliation and review input share.
- Per-pair economic observations in experimental evaluation, gated by fixture correctness, local isolation and metric coverage. No automatic adoption.
- Retained XDG storage and existing task/review/permission contracts; no new dependencies or migration.
- Runtime version check remains a separate explicit step. No claim of measured cost savings or actual host toolset reduction.

## Synapse v0.15.0 — Economic Strategy & Runtime Reliability

- Targeted deduplication of verified local Synapse package declarations in the selected configuration, with backups; ambiguous/custom entries are not silently changed.
- Bounded project-specific OpenCode API health check, integrated in the Bash installer; nonzero exit when activation is not verified.
- New coordinator-only economic advice tool and offline CLI: structural concurrency, separate cache/input metrics, conservative profile reconciliation and review input share.
- Per-pair economic observations in experimental evaluation, gated by fixture correctness, local isolation and metric coverage. No automatic adoption.
- Retained XDG storage and existing task/review/permission contracts; no new dependencies or migration.
- Runtime version check remains a separate explicit step. No claim of measured cost savings or actual host toolset reduction.

## Synapse v0.14.0 — Economic Optimization

- Added persistent session cost ledger in the project XDG directory, atomic immutable start/finish observations and deduplication with retained logs.
- Added bounded visible assistant/compaction message profiling; no additional model generation; preserves known aggregate on profiling failure.
- Shortened worker protocol while retaining structured contracts and read-only restrictions.
- Added review share of reported input tokens when aggregate coverage permits, ledger health, profile detail and explicit truncation to the existing cost report.
- CLI, coordinator tool and ZIP diagnostics share the same durable summary.
- No new dependencies, migration, automatic model selection, permission changes, or enforced spending caps.
- 109 automated tests passed; core TypeScript check passed. Live OpenCode integration not yet validated.
