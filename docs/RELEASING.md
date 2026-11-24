# Making a release

This repository is intended for source distribution through GitHub releases, not npm publication. `private: true` is intentional and prevents accidental npm publication.

## Before tagging

1. Review the version in `package.json`, `src/core/version.ts`, installer defaults and release notes.
2. Generate and review `package-lock.json` with the real registry; commit it. The initial source archive does not contain one because dependency resolution was unavailable during packaging. Until it is committed, installs are not fully reproducible.
3. Run `npm test`, `npm run typecheck`, `npm audit`, and `npm run demo`. Resolve or document failures before publishing. Run the real OpenCode checks in the README and record which provider tests actually completed.
4. Commit the release changes. Do not include `.opencode/`, XDG data, configuration backups or diagnostic bundles.

## Package and publish

```sh
bash scripts/package-release.sh
```

The script packages committed files only and writes the source ZIP, matching installer, release notes and SHA-256 manifest to `release-assets/`. Check the output and verify the checksums. The `Release assets` workflow requires a committed lockfile, runs equivalent checks for a version tag and uploads a workflow artifact; it does not publish a GitHub release automatically.

Create the tag and push it when ready (example for this version):

```sh
git tag -a v1.0.0 -m 'Synapse v1.0.0'
git push origin v1.0.0
```

In GitHub, open Releases → Draft a new release, select the tag, use `release/v1.0.0.md` as the description and attach the versioned ZIP, installer and checksum manifest (plus `RELEASE-NOTES.md`, which is covered by that manifest). Review the draft before publishing. Mark as a pre-release if the remaining production qualification checks are not complete. The tag archives provided automatically by GitHub are not the versioned installer bundle.
