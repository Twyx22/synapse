# Installation and updates

Synapse is a local OpenCode V2 server plugin, not a standalone model provider. Install OpenCode and configure a model separately. Use a stable absolute path for Synapse; moving it can change the project identity of a run started from the plugin directory.

## Release installer (Linux)

Download `Synapse-OpenCode-v1.0.0.zip`, `install-synapse-v1.0.0.sh` `RELEASE-NOTES.md` and `SHA256SUMS.txt` from the same release. Check the archive and script with `sha256sum -c SHA256SUMS.txt` (the checksum file also covers the release notes). Finish active work and close all OpenCode clients. Then run:

```sh
bash install-synapse-v1.0.0.sh Synapse-OpenCode-v1.0.0.zip
```

An optional second argument is an absolute destination; the default is `~/Downloads/synapse-opencode`. The parent must exist. The installer needs Node.js 22+, npm, unzip, realpath, flock and OpenCode, and must not run as root. It confirms before stopping the service. It refuses non-Synapse destinations, ambiguous configuration, and outstanding locks in the target store. Backups and staging are retained even on success.

## Source checkout

From the checkout, use `npm install` (or `npm ci` once a reviewed lockfile is committed), `npm test`, and `npm run typecheck`. Run `npm run setup -- --global --dry-run` to preview, then `npm run setup -- --global` to register globally. Use `--project /absolute/path` instead for project-local setup. Existing comments remain in the backup, not the rewritten JSONC. Restart the service and open a fresh session. Setup alone does not back up an entire existing installation; use the versioned installer for upgrades.

## Verify

From the plugin directory:

```sh
npm run health -- --project /absolute/path/to/project
npm run doctor -- --project /absolute/path/to/project
```

A successful health check confirms one active server plugin at the expected source; call `synapse_version` in OpenCode to confirm the version actually loaded. Immediately after a restart a plugin may not yet be ready. Duplicate declarations can come from several configuration scopes. Inspect configuration before removing only obsolete Synapse entries; preserve unrelated plugins.

## Rollback and storage

Before an upgrade, back up each relevant project separately. The release installer captures the initialized store for the installation-directory project only; other project stores are not copied. It never automatically restores XDG state. See [storage](STORAGE.md) and the [1.0 recovery notes](V1.md) for the manual rollback procedure and how to deal with residual locks. Never delete a lock while a writer or remote task may be active, and never share private backups.
