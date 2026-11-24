# v0.15.0 — Economic Strategy & Runtime Reliability

## Install and verify

Run the accompanying `install-synapse-v0.15.0.sh` as your normal user after ending active missions. It preserves the stable installation directory and XDG storage, backs up configuration, and tests before replacing files. Once installed, it polls the OpenCode server for the exact project and plugin path. A service or health-check failure exits nonzero while retaining the installed files and backups (no rollback under a possibly live service). No model generation is required.

The global setup now deduplicates identical current local entries and removes plain local references to other directories whose package.json identifies them as `synapse-opencode`. Unknown/missing paths are retained; stale object entries with custom options or multiple configured current entries require manual review. Other config files and projects are not changed. Backups remain on disk; the installer does not delete old directories. Review unrelated/ambiguous configuration before proceeding.

`npm run health -- --project /absolute/project` uses the documented-in-user-diagnostic OpenCode V2 `opencode api GET /api/plugin?location%5Bdirectory%5D=...` response. The query has a 5-second command timeout and up to 12 attempts, separated by 1 second. It checks an exact directory, a single `synapse` ID, exact local path and active server feature. It does not verify runtime version or exercise the tools. Confirm in a new session with `synapse_version` and `synapse_storage_status`. The OpenCode host was not available in the development environment: API tests use simulated responses, not a running host.

## Economic advice

`npm run economics -- --run RUN_ID [--project PATH]` or `synapse_economic_advice` (coordinator only) returns the structural DAG width, separate input/cache counters, review input share when coverage permits, and findings. The first-visible-step input share is emitted only when all retained session input aggregates and individual step profiles reconcile, with no known ledger integrity issues, unfinished sessions or omitted/truncated details. A first visible step is not guaranteed to be the first provider request. A match does not establish full provider coverage. Historical logs may have been rotated; coordinator calls are excluded.

`npm run experiments -- --experiment EXPERIMENT_ID` and `synapse_experiment_evaluate` now return an `economics` array for every registered pair. Comparisons are gated by all registered fixture quality checks and local isolation, and complete observed aggregates for each metric. Each category is separate. A zero denominator has no relative reduction. USD is reported usage, not a bill; no conversion or price assumption. The existing latency recommendation rules remain unchanged. No recommendation is adopted automatically. Old experiments retain their original version and limitations. New comparisons do not imply generalization or significance.

No host toolset restriction, automatic model selection, deterministic replacement of independent review or hard monetary spending ceiling is introduced in this release. Existing permissions and required reviews remain intact. A narrower host toolset requires verified OpenCode support and a separate benchmark.
