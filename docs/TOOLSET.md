# v0.17.0 — Specialized Intelligence

## Scope

Opt in per task with `toolProfile: "lean"`. Only exact-fixture tasks with `contract.requireSubmit: true` and no patch are eligible. Select this profile only for tasks that do not need filesystem or other external tools. It changes neither model nor permissions. The reviewer, coordinator, council, other runs and standard workers remain unchanged. An independent review still runs when requested. The expected fixture remains outside the worker context. Graph session budgets and existing contracts remain enforced.

## Host integration

The documented OpenCode V2 session `context` hook permits request-local tool removal (https://opencode.ai/docs/build/plugins/server). Synapse registers it optionally. For an actively collecting opted-in worker only, retain available `synapse_submit`, `synapse_message`, `synapse_inbox` and delete other definitions from that request's tool record. Required direct tools must all be present before filtering. If Code Mode wraps the necessary tool, leave the entire tool record alone. This is not a security boundary. Other hooks or the provider may change the eventual request. No global registry, provider options, user permissions, or system prompts are changed. No tool is added or resurrected.

## Example task

```json
{"id":"cost-test","title":"Calcul exact","instruction":"Calculer 37 × 19 et soumettre uniquement le nombre obtenu.","role":"analysis","review":false,"maxAttempts":1,"timeoutSeconds":120,"contract":{"requireSubmit":true},"verification":{"kind":"exact","expected":"703"},"toolProfile":"lean"}
```

A user must explicitly authorize the omission of an independent review and the run. Do not include the expected fixture in the worker instruction.

## Diagnostics

Export `agent.toolset.filtered` from retained diagnostic logs. `filterStatus` is `applied`, `required_missing`, `unsupported`, `not_observed`, `invalid_shape`, or `immutable`. The last five do not establish a reduction. For well-formed registries, `toolsBefore`/`toolsAfter` count visible definitions; `schemaCharsBefore`/`schemaCharsAfter` measure JSON-serialized characters where serialization succeeds. They are not model token counts, provider bytes or billing. Only numeric counts and enumerated states are exported, not schemas. `runs.json` records requested profile; this is not proof it was applied.

## Validation

Run `npm test` locally and `npm run health` after installation. On a real host, compare one standard worker and one lean worker with identical exact fixture, same model/configuration, no reviewer, sessionBudget 1 per graph, explicit user consent for both graphs, no other concurrent graph. Inspect both result evidence and costs. Compare counts and input/cache separately. The current registered experiment engine deliberately allows only concurrency changes, so this comparison is a manual diagnostic, not a registered strategy recommendation. One pair cannot establish general savings. Host support and actual token reduction are unverified by local mocks.

No dependency upgrades, automatic model selection, coordinator accounting or hard monetary budget in this release.
