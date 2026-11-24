# Synapse

Runtime collaboratif pour OpenCode V2. Synapse organise les tâches sous forme de graphe de dépendances, fait travailler des agents en parallèle lorsque cela est pertinent, recueille leurs contributions et conserve les résultats dans une mémoire locale propre à chaque projet.

L'objectif n'est pas de multiplier les agents, mais de les utiliser lorsqu'ils apportent un bénéfice. Les workers restent en lecture seule par défaut. Les revues, les mesures de consommation et les propositions d'amélioration ne déclenchent ni déploiement ni changement de modèle automatique.

## Installation

Sous Linux, récupère le ZIP versionné et son installateur dans la release. Termine les missions actives, ferme OpenCode, puis exécute sans sudo :

```sh
bash install-synapse-v1.0.0.sh Synapse-OpenCode-v1.0.0.zip
```

Depuis les sources, avec Node.js 22+ et npm :

```sh
npm install
npm test
npm run typecheck
npm run setup -- --global --dry-run
npm run setup -- --global
```

Redémarre OpenCode et vérifie `synapse_version` et `synapse_doctor` dans une nouvelle session. Pour une configuration limitée à un projet, remplace `--global` par `--project /chemin/absolu`.

Le stockage persistant se trouve sous `${XDG_DATA_HOME:-$HOME/.local/share}/synapse/projects/`. Garde le chemin d'installation stable et ne publie ni sauvegardes, ni données de projets, ni rapports de diagnostic sans vérification.

La v1.0.0 est une première version majeure, pas une certification de production. Les limites et validations restantes sont détaillées dans le [README principal](README.md) et les [notes de version](release/v1.0.0.md). Les guides techniques historiques sont accessibles depuis [docs/](docs/README.md).

Licence MIT. Projet indépendant d'OpenCode.
