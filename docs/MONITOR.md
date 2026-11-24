# Synapse 0.6.0 — Live Monitor

Depuis le dossier du plugin :

```bash
npm run monitor -- --project /chemin/du/projet
npm run monitor -- --project /chemin/du/projet --run run_UUID
npm run monitor -- --project /chemin/du/projet --once
npm run profile -- --project /chemin/du/projet > synapse-profile.json
```

Depuis 0.11.0, le CLI utilise le répertoire XDG du projet exact (ou les données historiques avant migration). Sans argument, le projet est le répertoire courant ; `--project` le sélectionne explicitement. Voir [Stockage](STORAGE.md). `--data-dir` désigne directement le dossier de données. Une exécution active récente est sélectionnée par défaut, sinon la dernière exécution lisible. Un run illisible est ignoré lors de cette sélection. Ctrl+C ferme uniquement le moniteur : il ne contacte pas OpenCode. Aucun accès réseau.

Le moniteur est une vue terminal rafraîchie, pas une extension graphique intégrée au TUI OpenCode. `--once` produit une seule vue. Le profil JSON comprend les sessions, les phases, les durées disponibles, les dépendances et les derniers événements sans prompts ni résultats bruts. Vérifiez les données avant de les partager.

## Interpréter les mesures

- `CLI` : version du moniteur local ; `last startup` : dernière version constatée dans les logs conservés, pas une interrogation directe du service. Demandez `synapse_version` dans une nouvelle session OpenCode pour vérifier le runtime réel.
- `Workers` et `Reviews` : somme des durées des sessions terminées retrouvées dans les logs, pas temps écoulé du run. Les sessions parallèles se chevauchent. La rotation peut retirer des mesures historiques.
- `promptMs`, `waitMs`, `setupMs` : mesures des appels d'API, y compris leur latence. Ne représentent pas la durée de génération ni les tokens. Les anciennes versions ne fournissent pas nécessairement ces champs.
- `Late` : nombre de messages directs envoyés alors que leur tâche destinataire était terminale ; les messages restent enregistrés, aucun redémarrage automatique.
- `Fetched` : nombre de messages directs pour lesquels la tâche destinataire a explicitement consulté l'inbox et reçu le message dans le résultat de l'outil. Ne prouve pas une compréhension, et n'inclut pas les messages injectés au démarrage dans le contexte. Les broadcasts sont enregistrés par destinataire, mais exclus de ce compteur direct.
- Un avertissement après 45 secondes sans événement de session suggère une inspection. Un heartbeat n'indique pas que le modèle génère encore du texte. Aucun watchdog destructif, timeout forcé ou abandon automatique n'est introduit dans cette version.

## Test réel

Vérifiez d'abord `synapse_version` (0.6.0) et `synapse_profile`. Exécutez un graphe court autorisé : une tâche A produit un résultat simple, une tâche B dépend de A et consulte l'inbox ; A envoie un message direct à B avant de soumettre. B soumet son résultat et reçoit une revue indépendante via `synapse_submit_review`. Ouvrez le moniteur dans un autre terminal, inspectez le profil, puis exportez un rapport avec `synapse_diagnostics_export`. Ne modifiez pas les fichiers source et ne lancez pas plusieurs tests simultanément. Le contrôle de lecture des messages est distinct de l'approbation du résultat.

## Limites

Stockage existant à un seul processus écrivain par dossier. Le moniteur et le profil n'écrivent pas dans les snapshots. Les logs sont limités et certains champs anciens peuvent manquer. Pas de mesure de tokens ni de prix, de réveil automatique, d'attente inter-agent ou de modification autonome du code. Les idées d'évolution restent des propositions soumises à validation. La v0.6.0 conserve les dépendances npm de la v0.5.3 ; elle ne résout pas les alertes amont.
