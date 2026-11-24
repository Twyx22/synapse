#!/usr/bin/env bash
# Package committed source; never include local runtime data or .git.
set -Eeuo pipefail
cd -- "$(git rev-parse --show-toplevel)"
version=$(node -p 'require("./package.json").version')
[[ $version =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]] || { echo 'Expected a stable semantic version.' >&2; exit 1; }
[[ -z $(git status --porcelain --untracked-files=normal) ]] || { echo 'Commit changes before packaging.' >&2; exit 1; }
notes="release/v${version}.md"
[[ -f $notes ]] || { echo "Missing $notes" >&2; exit 1; }
# Version-specific installer defaults must match this release.
grep -Fq "Synapse-OpenCode-v${version}.zip" scripts/install-synapse.sh || { echo 'Update installer default archive name.' >&2; exit 1; }
out=release-assets
mkdir -p "$out"
archive="Synapse-OpenCode-v${version}.zip"
installer="install-synapse-v${version}.sh"
git archive --format=zip --prefix=synapse-opencode/ -o "$out/$archive" HEAD
install -m 0755 scripts/install-synapse.sh "$out/$installer"
cp -- "$notes" "$out/RELEASE-NOTES.md"
(cd "$out"; sha256sum "$archive" "$installer" RELEASE-NOTES.md > SHA256SUMS.txt; sha256sum -c SHA256SUMS.txt)
unzip -tq "$out/$archive"
printf 'Assets ready in %s/ (upload manually to the GitHub release).\n' "$out"
