# Persistent Intelligence — 0.11.0

## Avant de remplacer le dossier actuel (Linux)

Terminer les runs, fermer les interfaces et arrêter le service OpenCode. Conserver les sauvegardes. Extraire la nouvelle archive dans un dossier **différent**, puis, depuis ce nouveau dossier `synapse-opencode`, lancer :

```bash
OLD="$HOME/Downloads/synapse-opencode"
npm run storage -- doctor --project "$OLD"
npm run storage -- migrate --project "$OLD"
npm run storage -- doctor --project "$OLD"
```

Le CLI n'a besoin ni de npm install ni d'un serveur OpenCode actif (Node 22+). Vérifier `persistent.runs`, `persistent.ideas`, `persistent.experiments`, `conflicts`, `invalid`, et le chemin `backup` retourné par la migration. Comparer avec l'inventaire ancien. Si un conflit est signalé, **ne pas écraser** le fichier actif : les deux variantes sont conservées (destination et sauvegarde) pour examen manuel. Les fichiers invalides lisibles sont archivés mais pas importés ; les liens symboliques et fichiers non réguliers sont ignorés et signalés. Ne pas supprimer les anciennes données avant contrôle.

Remplacer ensuite les sources au **même chemin de projet** que précédemment (conserver une copie de l'ancien dossier). Installer, tester, exécuter `npm run setup -- --global` depuis le dossier final puis redémarrer OpenCode. Les nouvelles versions ne doivent plus déplacer les données avec le code. Pour les autres projets, répéter la migration avec leur propre chemin, ou laisser la première initialisation de la v0.11.0 copier leur stockage historique à condition qu'aucune ancienne instance n'écrive dedans.

## Emplacement

```text
${XDG_DATA_HOME:-$HOME/.local/share}/synapse/
  projects/<sha256-du-chemin-canonique>/
    project.json
    legacy-import.json          (si import historique effectué)
    run_*.json
    evolution/
    experiments/
    diagnostics/
    reports/
  backups/<project-id>/<uuid>/
    migration.json
    ... copies privées des fichiers historiques reconnus
```

Le répertoire du projet est identifié par son chemin réel (`realpath`), pas par son nom Git. Une autre adresse symbolique du même projet donne le même identifiant ; un déménagement réel change l'identifiant. Un changement de XDG_DATA_HOME change aussi le stockage : le configurer de façon identique dans les terminaux et le service OpenCode. Aucun partage interprojets automatique. Les répertoires du stockage doivent être privés (0700), les fichiers migrés sont créés en 0600.

Les documents `run_*.json`, `evolution/idea_*.json` et `experiments/experiment_*.json` reconnus sont copiés, sans écrasement ; les journaux `synapse.jsonl*` et `evolution/config.json` sont archivés seulement. Les anciens paramètres de débat automatique ne sont pas réactivés : vérifier la configuration et obtenir l'autorisation avant de les réactiver. Les ZIP de rapports déjà générés ne sont pas migrés et restent à leur ancien emplacement. Les anciens journaux ne sont pas fusionnés avec les nouveaux : le profil historique peut donc manquer de métriques, mais les snapshots et événements des runs sont conservés. Une expérience d'une ancienne version reste consultable sans valider une stratégie pour une nouvelle version.

## Outils

- `npm run storage -- doctor --project /chemin` : inventaire, chemins locaux, marqueur et verrou ; aucun appel de modèle ni écriture.
- `npm run storage -- migrate --project /chemin` : import manuel hors ligne, avec sauvegarde et manifest privé des fichiers reconnus. L'import automatique au démarrage n'est effectué qu'une fois pour le dossier historique ; les imports manuels restent possibles.
- `npm run storage -- migrate --project /chemin --source /ancien/synapse-data` : récupération explicite depuis une sauvegarde **du même projet**, uniquement après avoir arrêté les services. Ne pas mélanger les données de projets différents.
- `synapse_storage_status` : inventaire en lecture seule dans l'agent principal.
- `synapse_evolution_backlog` / `npm run backlog -- --project /chemin` : classement heuristique des propositions non rejetées. Contrats et récupération d'abord, puis qualité et coordination, ensuite mesures. Le nombre d'éléments de preuve ne constitue pas une mesure d'impact. Aucune expérience lancée, aucune modification automatique.

Toutes les commandes CLI utilisent le projet exact (`--project`), ou le dossier courant si absent. Il n'y a plus de recherche des parents. `--data-dir` sélectionne explicitement un dossier de données (hors commandes de migration). Avant migration le CLI peut lire les données historiques. Le moniteur, les rapports et les contributions suivent le même chemin que le plugin.

## Limites et récupération

La migration ne remplace pas une sauvegarde générale : elle ne copie que les fichiers reconnus (64 Mio max par fichier). Les copies sont publiées atomiquement sans écrasement. Après interruption, un verrou `.migration-lock` peut subsister ; ne le retirer manuellement qu'après avoir confirmé qu'aucune migration ni instance n'est active et inspecté les sauvegardes. Relancer explicitement la migration ; les fichiers identiques seront détectés, les conflits préservés. Les sauvegardes ne sont pas purgées automatiquement. La v1.0 ajoute des verrous coopératifs par graphe et proposition. Le déploiement recommandé reste **un seul serveur écrivain par projet** : pas de synchronisation multi-hôte, ni de verrou global des exécutions, ni de journalisation multi-processus garantie. Voir V1.md pour le traitement des verrous résiduels. Les anciennes données peuvent contenir du code ou des secrets : ne pas envoyer les snapshots, sauvegardes ou manifestes de migration privés ; générer uniquement un rapport de diagnostic et le vérifier avant partage.
