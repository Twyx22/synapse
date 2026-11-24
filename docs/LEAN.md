# Synapse 0.16.0 — Lean Intelligence

## Exact fixture verification

Optional `verification: {kind:"exact", expected:"703"}` on a task with `contract: {requireSubmit:true}` compares the submitted full text to the expected text, ignoring only outer whitespace. Expected text is stored privately in the run, omitted from agent adapter context and diagnostics. It is not a secret or a sandbox security boundary: workers may have permitted local file access. Do not use sensitive answers, patches, or free-form technical conclusions as fixtures. A mismatch consumes an attempt; dependencies remain blocked if attempts are exhausted. The check runs only after collaboration contracts pass. `review` still defaults to true. If true, an exact match must also pass independent review. Explicitly authorized `review:false` plus an exact fixture skips the independent AI reviewer, saving that session on success. It is not equivalent to general independent review.

## Session envelope

Optional top-level `sessionBudget` (1–576) in `synapse_plan` rejects plans if their maximum number of graph sessions under the shipped adapter exceeds the budget. Each task reserves `maxAttempts × (review ? 3 : 1)` to account for one worker and up to two reviewer sessions. This is a conservative admission check, not dynamic metering, a token limit, or a billing guarantee. It excludes coordinator, council, other instances, remote activity and provider-internal calls. No silent adjustment of retries or review. Existing plans without a budget continue to work. The envelope is checked again before execution.

## Inspection

`npm run lean -- --run RUN_ID` or `synapse_lean_advice` returns the envelope and per-task exact-check status. `runs.json` in the diagnostic ZIP includes exact-check metadata and the optional budget, never the expected text. Older experiments remain readable; the plan fingerprint now also covers the optional budget and exact checks. Existing experiments compare concurrency only; changing review mode requires a separately authorized, explicitly described benchmark, not an existing registered pair.

## Limitations

No host toolset filtering, new agent profiles, automatic routing, coordinator token accounting or new permissions. Exact fixtures are not automatically added to plans. Independent review remains unchanged for existing tasks. Runtime activation must be tested on OpenCode.
