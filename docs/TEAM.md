# v0.12 — Project identity diagnostics & team evidence

The existing SHA-256 canonical-path identity is unchanged. Existing migrated data remains in place. A temporary checkout is a separate project; do not merge unrelated workspaces automatically. A moved project still needs an explicit offline migration; this release does not create a persistent UUID or alias registry.

## Diagnose empty reports

From the installation (after `npm install`):

```sh
npm run storage -- projects
npm run storage -- doctor --project "$HOME/Downloads/synapse-opencode"
npm run report -- --project "$HOME/Downloads/synapse-opencode"
```

`storage projects` lists local project metadata and filename counts, not validated record counts. It does not open other projects' records or switch the active project. It is an offline CLI only. `doctor` verifies the selected project's metadata and counts validated records. `storage.json` in a project-aware report contains the current project fingerprint, source type, record counts and migration flags, without raw paths or other projects' identities. Empty history emits `empty_project_history`; an inventory failure emits `storage_inventory_unavailable`. `--data-dir` has no project context and omits this snapshot. The fingerprint is derived from the local path; it is pseudonymous, not anonymous. Inspect reports before sharing.

Always start OpenCode from the intended project directory, and compare `synapse_storage_status.projectId` to `storage doctor`. The plugin never guesses a different project's memory. Never run multiple processes writing the same store concurrently.

## Team evidence

```sh
npm run team -- --project "$HOME/Downloads/synapse-opencode"
npm run team -- --project "$HOME/Downloads/synapse-opencode" --run RUN_ID
```

`synapse_team_profiles` and `synapse_team_advice` are coordinator-only and read-only. They aggregate exact historical role labels, separating accepted reviewed, unreviewed, failed, blocked and cancelled tasks; include bounded run/task references; and disclose incomplete scans. A role is not an agent identity or skill certification. The advisor requires at least three distinct runs and three reviewed or failed outcomes; any failure is flagged for inspection, incomplete scans result in insufficient evidence. The selected plan is excluded from its own history. No model selection, automatic team formation, permissions changes, or task execution occurs. Historical reviews are opinions and must be checked against actual project requirements.
