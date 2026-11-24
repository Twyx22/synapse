# Synapse Diagnostics — v0.5.2

Ce système sert à **reproduire, diagnostiquer et corriger les problèmes** de Synapse à partir d'un rapport que tu peux joindre à une conversation. Il ne transmet rien automatiquement.

## Ce qui est enregistré

- **Événements structurés JSONL**, un JSON par ligne et un horodatage UTC (`at`).
- Début et fin des runs, démarrage des tâches, erreurs, retries, rejet de revue, validation, annulation, récupération.
- Création des sessions, durée des agents et reviewers, taille des réponses (mais pas leur texte).
- Messages d'équipe : uniquement `from`, `to`, `type`, `runId`, **jamais `body`**.
- Idées et débats de l'Evolution Council : création, début, fin, résultat et erreurs, sans les avis complets.
- Erreurs sous forme abrégée avec masquage des secrets reconnaissables.

**Les journaux sont activés automatiquement** lors du chargement du plugin. Aucun service externe ni API de télémétrie requis.

## Emplacements

Depuis 0.11.0, dans le stockage XDG du projet (voir [Stockage](STORAGE.md)) :

```text
${XDG_DATA_HOME:-$HOME/.local/share}/synapse/projects/<id>/
├── run_....json                états complets privés des runs (NON exportés)
├── evolution/                  données privées du conseil (NON exportées)
├── diagnostics/
│   ├── synapse.jsonl           journal courant
│   ├── synapse.jsonl.1         rotation
│   ├── synapse.jsonl.2
│   └── synapse.jsonl.3
└── reports/
    └── synapse-diagnostics-....zip
```

Par défaut, **1 Mio par fichier, 4 fichiers** maximum (environ 4 Mio de journaux). Les fichiers anciens sont remplacés lors de la rotation. Les journaux ne grossissent donc pas indéfiniment. Les archives ZIP générées volontairement ne sont pas supprimées automatiquement : nettoie le dossier `reports/` si besoin.

## Le plus facile : depuis OpenCode

Demande à OpenCode :

> Utilise `synapse_diagnostics_status` pour vérifier l'état du journal. Puis appelle `synapse_diagnostics_export` et donne-moi le chemin de l'archive ZIP à joindre à ChatGPT. N'envoie rien automatiquement.

Tu peux aussi cibler une exécution précise via l'argument `runId` de `synapse_diagnostics_export`.

Les deux outils de diagnostic sont réservés au **coordinateur**, pas aux sessions d'agents.

## Si OpenCode ne démarre plus : export hors ligne

Depuis le dossier du plugin, lance :

```bash
npm run report
```

Le script cible le projet courant ; utiliser `--project /chemin/du/projet` pour un autre projet. Pour un ancien dossier de données explicite :

```bash
npm run report -- --data-dir /chemin/vers/mon-projet/.opencode/synapse-data
```

Pour une seule exécution :

```bash
npm run report -- --run run_XXXXXXXX-XXXX-XXXX-XXXX-XXXXXXXXXXXX
```

Pour vérifier la santé du journal :

```bash
npm run log-status
```

Le script fonctionne avec Node.js >=22 et ne nécessite pas de serveur OpenCode actif ni l'accès à Internet. Les archives sont créées **localement**.

## Contenu du ZIP

| Fichier | Contenu |
|---|---|
| `README.txt` | Précautions de confidentialité et instructions |
| `manifest.json` | Version Synapse, version Node, plateforme, horodatage, erreurs de collecte |
| `runs.json` | Statuts des tâches, catégories d’erreurs (sans texte libre), tentatives, durées, chronologie des événements, métadonnées des échanges |
| `logs.jsonl` | Journal structuré récent, limité à 2 Mio / 2000 lignes |

Les scripts n'incluent volontairement **ni code source, ni prompts, ni objectifs bruts, ni résultats de modèles, ni texte des messages, ni variables d'environnement**. Les fichiers JSON privés contenant le détail des runs ne sont pas copiés dans le ZIP.

La suppression automatique des secrets est **heuristique et imparfaite** : **ouvre et vérifie le contenu de l'archive avant de la partager**. Des informations de projet peuvent subsister, notamment dans des messages d'erreur ou des noms de tâches.

## Quand tu m'envoies une archive

Indique simplement ce qui n'a pas fonctionné (par exemple « Synapse reste bloqué sur l'agent security », « les revues bouclent », « le plugin refuse de démarrer ») et **joins l'archive ZIP**.

Je pourrai alors analyser la chronologie, identifier les symptômes, proposer un correctif, ajouter un test de non-régression et générer une nouvelle version du plugin. Certaines erreurs nécessiteront malgré tout une reproduction sur une véritable installation OpenCode.

## Limites connues

- Journalisation best effort : si le disque est plein ou non accessible, l'exécution continue, mais les événements correspondants peuvent manquer.
- Stockage mono-processus : ne pas lancer plusieurs instances écrivant les mêmes runs.
- Logs après crash brutal : les toutes dernières lignes peuvent manquer.
- Les logs ne contiennent pas les requêtes HTTP, les clés d'API ni les données complètes des sessions.
- Aucun envoi automatique vers un serveur, aucune surveillance en arrière-plan en dehors du processus OpenCode.
- Le plugin OpenCode V2 nécessite encore une validation sur une installation réelle : les tests utilisent un adaptateur simulé.

Depuis v0.5, le staging local d’une contribution produit un événement `contribution.staged` (identifiants du run et de la tâche, nombre de fichiers). Le diff reste dans les données privées du run et n’est pas exporté dans le rapport.

## Diagnostic de réponse vide (v0.5.2)

`agent.prompt.started` et `agent.wait.started` indiquent les étapes de l’adaptateur. `agent.heartbeat` indique toutes les 15 secondes qu’un appel attend toujours ; il ne prouve pas que le modèle produit des tokens. `agent.result.received` indique une remise explicite via `synapse_submit`. `agent.result.context` décrit uniquement le nombre et les types de messages lorsque la lecture de l’historique est utilisée. Si les deux méthodes ne fournissent aucun résultat, la tâche échoue normalement. Aucun résultat n’est déduit des messages d’équipe.

Avant de remplacer le plugin, terminer ou annuler proprement les runs actifs et exporter leurs rapports. Redémarrer le service OpenCode pour charger la nouvelle version, puis créer un nouveau run.

### Confidentialité depuis la v0.10.0

Les rapports filtrent aussi les anciens journaux : les commentaires libres, erreurs brutes et champs non reconnus ne sont pas exportés. Le rapport ciblé `--run` filtre les lignes des autres exécutions (hors démarrage du plugin). Les fichiers de run privés conservent les détails utiles à la reprise ; ils ne sont pas inclus. Les rôles, identifiants, horodatages et relations restent des métadonnées potentiellement sensibles. Inspecter avant partage.
