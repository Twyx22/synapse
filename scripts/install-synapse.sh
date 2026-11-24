#!/usr/bin/env bash
# Synapse installer for v1.0.0 and subsequent compatible ZIP releases.
set -Eeuo pipefail
umask 077

usage() { printf '%s\n' 'Usage: bash install-synapse.sh [archive.zip] [installation-directory]' 'Default directory: ~/Downloads/synapse-opencode' 'Without an archive argument: Synapse-OpenCode-v1.0.0.zip next to this script.'; }
fail() { printf 'ERREUR : %s\n' "$*" >&2; exit 1; }
[[ ${1:-} != --help && ${1:-} != -h ]] || { usage; exit 0; }
(( $# <= 2 )) || { usage; exit 2; }
(( EUID != 0 )) || fail 'Ne pas lancer avec sudo/root.'
for cmd in node npm unzip realpath flock opencode mktemp cp mv; do command -v "$cmd" >/dev/null || fail "Commande absente : $cmd"; done
node -e 'if (+process.versions.node.split(".")[0] < 22) process.exit(1)' || fail 'Node.js 22+ requis.'
HERE=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)
ARCHIVE=$(realpath -e -- "${1:-$HERE/Synapse-OpenCode-v1.0.0.zip}") || fail 'Archive introuvable.'
[[ -f "$ARCHIVE" ]] || fail 'Archive invalide.'
DEST=${2:-$HOME/Downloads/synapse-opencode}
[[ "$DEST" = /* && "$DEST" != / && "$DEST" != "$HOME" && ! -L "$DEST" ]] || fail 'Destination invalide ou lien symbolique.'
PARENT=$(realpath -e -- "$(dirname -- "$DEST")") || fail 'Le dossier parent doit exister.'
BASE=$(basename -- "$DEST")
[[ "$BASE" != . && "$BASE" != .. ]] || fail 'Destination ambiguë.'
DEST="$PARENT/$BASE"
[[ "$DEST" != "$HOME" && "$DEST" != / && ! -L "$DEST" ]] || fail 'Destination interdite.'
[[ ! -e "$DEST" || -d "$DEST" ]] || fail 'La destination n’est pas un dossier.'
if [[ -d "$DEST" ]]; then [[ $(realpath -e -- "$DEST") == "$DEST" ]] || fail 'Chemin de destination non canonique.'; fi
CONFIG="${XDG_CONFIG_HOME:-$HOME/.config}/opencode"
[[ "$CONFIG" = /* ]] || fail 'XDG_CONFIG_HOME doit être absolu.'
exec 9>"$PARENT/.synapse-install.lock"
flock -n 9 || fail 'Une autre installation est en cours.'
WORK=$(mktemp -d "$PARENT/.synapse-install-XXXXXXXX")
BACKUP=$(mktemp -d "$PARENT/.synapse-backup-XXXXXXXX")
STOPPED=0; MOVED=0; PUBLISHED=0; CONFIG_SAVED=0; SUCCESS=0
CONFIG_FILES=(opencode.json opencode.jsonc agents/synapse.md)
cleanup() {
    local rc=$?
    trap - EXIT
    set +e
    if (( ! SUCCESS )); then
        printf '\nInstallation interrompue (code %s).\n' "$rc" >&2
        if (( CONFIG_SAVED )); then
            for file in "${CONFIG_FILES[@]}"; do
                if [[ -f "$BACKUP/config/$file" ]]; then
                    mkdir -p -- "$(dirname -- "$CONFIG/$file")"
                    cp -p -- "$BACKUP/config/$file" "$CONFIG/$file" || printf 'Restauration config à faire : %s\n' "$file" >&2
                else
                    rm -f -- "$CONFIG/$file"
                fi
            done
        fi
        if (( PUBLISHED )); then mv -- "$DEST" "$BACKUP/failed-install" || printf 'Déplacer manuellement %s\n' "$DEST" >&2; fi
        if (( MOVED )); then mv -T -- "$BACKUP/previous-install" "$DEST" || printf 'Restaurer manuellement %s/previous-install\n' "$BACKUP" >&2; fi
        if (( STOPPED )); then printf 'Service arrêté : après vérification, exécuter opencode service restart.\n' >&2; fi
    fi
    # The staging and backup directories are retained for inspection, even on failure.
    printf 'Sauvegarde : %s\n' "$BACKUP"
    printf 'Dossier de préparation : %s\n' "$WORK"
    exit "$rc"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

printf 'Archive : %s\nDestination : %s\n' "$ARCHIVE" "$DEST"
printf 'Termine les missions actives et ferme OpenCode avant de continuer.\n'
read -r -p 'Confirmer l’installation et l’arrêt du service [oui/N] : ' answer
[[ "$answer" == oui ]] || fail 'Installation annulée.'
# Use only archives obtained from the official Synapse GitHub release.
unzip -tq "$ARCHIVE" >/dev/null
unzip -q "$ARCHIVE" -d "$WORK"
STAGE="$WORK/synapse-opencode"
[[ -f "$STAGE/scripts/health.mjs" && -f "$STAGE/package.json" && -f "$STAGE/scripts/install.mjs" && -f "$STAGE/src/core/storage.ts" ]] || fail 'Archive Synapse compatible (v0.15+) requise.'
VERSION=$(node -e 'const p=require(process.argv[1]); if(p.name!=="synapse-opencode"||!/^\d+\.\d+\.\d+$/.test(p.version)||!p.scripts?.storage)process.exit(1);console.log(p.version)' "$STAGE/package.json")
if [[ -e "$DEST" ]]; then
    [[ -f "$DEST/package.json" ]] || fail 'Le dossier existant ne ressemble pas à une installation Synapse.'
    node -e 'if(require(process.argv[1]).name!=="synapse-opencode")process.exit(1)' "$DEST/package.json" || fail 'Le dossier existant n’est pas Synapse.'
fi
printf '\n[1/6] Dépendances et tests de Synapse %s\n' "$VERSION"
(cd "$STAGE"; if [[ -f package-lock.json ]]; then npm ci; else npm install; fi; npm test; npm run setup -- --global --dry-run)

printf '\n[2/6] Arrêt du service et sauvegarde de la configuration\n'
opencode service stop
STOPPED=1
for file in "${CONFIG_FILES[@]}"; do
    path="$CONFIG/$file"
    if [[ -e "$path" || -L "$path" ]]; then
        [[ -f "$path" && ! -L "$path" ]] || fail "Configuration non standard : $path"
        mkdir -p -- "$(dirname -- "$BACKUP/config/$file")"
        cp -p -- "$path" "$BACKUP/config/$file"
    fi
done
CONFIG_SAVED=1

printf '\n[3/6] Vérification de la mémoire permanente\n'
if [[ -d "$DEST" ]]; then
    node --experimental-strip-types "$STAGE/src/cli.ts" storage doctor --project "$DEST" > "$BACKUP/storage-before.json"
    cat "$BACKUP/storage-before.json"
    node -e 'const d=require(process.argv[1]); if(d.migrationLockPresent||d.persistent.invalid||d.legacy.invalid||d.locks?.runs?.length||d.locks?.evolution?.length)process.exit(1)' "$BACKUP/storage-before.json" || fail 'Stockage invalide ou verrou présent : vérifier hors ligne avant de poursuivre.'
    if [[ -d "$DEST/.opencode/synapse-data" ]] && node -e 'const d=require(process.argv[1]);process.exit(d.migrationRecorded?1:0)' "$BACKUP/storage-before.json"; then
        node --experimental-strip-types "$STAGE/src/cli.ts" storage migrate --project "$DEST" > "$BACKUP/migration.json"
        cat "$BACKUP/migration.json"
        node -e 'const d=require(process.argv[1]);if(d.conflicts||d.invalid)process.exit(1)' "$BACKUP/migration.json" || fail 'Conflit de migration : installation suspendue, originaux conservés.'
    fi
    # Snapshot the initialized target project's private XDG directory, while service is stopped.
    # Never overwrite the live XDG directory on rollback.
    DATA_DIR=$(node -e 'const d=require(process.argv[1]);if(d.initialized)process.stdout.write(d.directory)' "$BACKUP/storage-before.json")
    if [[ -n "$DATA_DIR" ]]; then
        [[ "$DATA_DIR" = /* && -d "$DATA_DIR" && ! -L "$DATA_DIR" ]] || fail 'Répertoire XDG inattendu.'
        cp -a -- "$DATA_DIR" "$BACKUP/xdg-project-snapshot"
        printf 'Copie privée XDG : %s/xdg-project-snapshot\n' "$BACKUP"
    fi
    # Preserve local OpenCode config and legacy data as well as the separate XDG memory.
    for file in .opencode opencode.json opencode.jsonc; do
        if [[ -e "$DEST/$file" || -L "$DEST/$file" ]]; then
            [[ ! -e "$STAGE/$file" && ! -L "$STAGE/$file" ]] || fail "Collision locale : $file"
            cp -a -- "$DEST/$file" "$STAGE/$file"
        fi
    done
    mv -T -- "$DEST" "$BACKUP/previous-install"
    MOVED=1
fi

printf '\n[4/6] Installation au chemin stable\n'
mv -T -- "$STAGE" "$DEST"
PUBLISHED=1
(cd "$DEST"; npm run setup -- --global)
node --experimental-strip-types "$DEST/src/cli.ts" storage doctor --project "$DEST" > "$BACKUP/storage-after.json"
cat "$BACKUP/storage-after.json"
if [[ -f "$BACKUP/storage-before.json" ]]; then
    node -e 'const a=require(process.argv[1]),b=require(process.argv[2]);if(a.projectId!==b.projectId||b.persistent.invalid||b.migrationLockPresent||["runs","ideas","experiments"].some(k=>b.persistent[k]<a.persistent[k]))process.exit(1)' "$BACKUP/storage-before.json" "$BACKUP/storage-after.json" || fail 'Inventaire après installation incohérent.'
fi
printf '\n[5/6] Redémarrage OpenCode\n'
# Installation is committed; a service failure must not roll back files under a possibly live process.
SUCCESS=1
if ! opencode service restart; then
    printf 'Installation terminée, mais le redémarrage a échoué. Relance opencode service restart.\n' >&2
    exit 1
fi
printf '\n[6/6] Vérification du plugin dans le projet cible\n'
if ! node "$DEST/scripts/health.mjs" --project "$DEST" --plugin "$DEST" > "$BACKUP/health.json"; then
    cat "$BACKUP/health.json" >&2
    printf 'Fichiers installés, mais activation non vérifiée. Ne pas considérer la mise à jour comme validée. Sauvegardes conservées.\n' >&2
    exit 1
fi
cat "$BACKUP/health.json"
printf '\nSynapse %s installé ; plugin serveur actif. Pour vérifier la version réellement chargée :\n' "$VERSION"
printf 'cd %q && opencode\n' "$DEST"
printf 'Vérifie la version avec synapse_version dans la nouvelle session.\n'
