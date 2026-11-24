# v0.14.0 — Economic Optimization

## Persistent Cost Ledger

New sessions write private, numeric-only records into `cost-ledger/` within the existing XDG project data directory. A start record precedes session setup and a finish record contains the settled status, reported usage, prompt character count and optional visible-message profile. Records use hashed run/session identity, exclusive atomic publication, fsync on the temporary file, and mode 0600. Concurrent identical records are idempotent; conflicting records are refused and logged. An incomplete session remains visible as missing usage. Corrupt records and unsafe ledger directories are flagged. This is not a database with transactional crash recovery; loss of the disk or incomplete filesystem durability remains possible. Back up the XDG data directory.

`npm run costs` and `synapse_costs` combine the ledger with retained diagnostic logs, deduplicating run/session pairs. Durable finish records take precedence. No new provider call is made to reconstruct historical usage. v0.13 observations remain accessible only while the original logs are retained; there is no backfill or historical billing reconstruction. Ledger writes do not invalidate accepted model results if local telemetry fails. The ledger has no automatic retention or compaction yet; scans read the project ledger. Reports show counts of invalid records, retained write errors, unfinished sessions and omitted detail.

## Visible-step profiling

After a settled session, the adapter reuses already fetched context or performs a bounded context read (up to an additional 1.5 s beyond the existing 1.5 s usage read). No extra model prompt. A failed profiling read does not discard the session aggregate. Only recognized assistant/compaction messages with unique IDs are inspected. Each visible message contributes numeric token/cost fields if exposed. Missing fields remain missing, not zero. Details are capped at 256 steps per session and 100 sessions per summary; truncation is explicit. The session aggregate remains the authoritative reported total. Visible steps are not necessarily actual API requests; OpenCode can prune or transform context, and some host versions may not expose per-message usage. `sessionsWithInputMetrics` is only a count of sessions with at least one visible input metric, not proof of full coverage. No prompt or response text is written in the ledger or exported by the profiler.

## Prompt compression

The worker protocol is shorter. The mandatory contract, task, dependencies, direct messages, patch scope, retry feedback, required submission, independent review and read-only policy remain intact. No automatic model switching, tool permission changes, skipped reviews, cost-based cancellation or new toolset restrictions. The number of characters saved is not a measure of actual provider input tokens. Compare the same task, model and settings in independent sessions to estimate any gain; the earlier v0.13 reference is not a randomized benchmark.

## Usage

```bash
npm run costs -- --project "$PWD"
npm run costs -- --run RUN_ID --budget-usd 0.10
npm run report -- --run RUN_ID
```

The existing `costs.json` export now uses schema 2; the previous aggregate fields are preserved, and `ledger`, `profiling` and `reviewShareOfInputTokens` are added. The historical `completeForRetainedSessions` key now refers to the union of observed ledger sessions and retained log sessions, not all provider traffic. The budget remains advisory; corruption, known ledger write errors and unavailable storage prevent a positive budget conclusion. Reported zero is not proof of free use. Coordinator calls, unknown sessions, unreported billing and rotated pre-ledger logs remain out of scope. No new npm dependency or storage migration required.

## Validation

109 local tests (100 previous tests plus 9 ledger/profile tests), including log deletion, duplicate publication, missing metrics, unsafe files, read failure, setup failure and diagnostic export. Core TypeScript check passed. OpenCode host integration is still to be tested.
