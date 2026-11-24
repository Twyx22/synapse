# Collective Cognition — v0.10.0

## Installation et migration

Arrêter les exécutions en cours, sauvegarder le dossier du plugin et les données `.opencode/synapse-data`, remplacer les sources, puis exécuter `npm install`, `npm test && npm run setup -- --global` et redémarrer le service OpenCode. Aucun changement du schéma de stockage, aucune dépendance nouvelle.

## Smart Context

La sélection des messages avant l'envoi du prompt conserve les messages entrants directs présents dans le snapshot et limite les broadcasts facultatifs à 8 000 caractères (représentation JSON comprise). Les broadcasts identiques sont dédupliqués ; les plus récents sont privilégiés. Les messages émis par le worker lui-même ne sont pas réinjectés. La sélection n'écrit pas dans l'inbox et ne valide pas un contrat de réception. Les dépendances et les instructions ne sont pas tronquées par cette couche. La limite de rétention historique de l'inbox (60 messages par consultation) reste inchangée. Il ne s'agit ni d'un résumé sémantique ni d'un plafond total de tokens. Le gain de latence n'est pas établi.

## Rétrospective et mémoire

`synapse_retrospective` est réservé au coordinateur ; il prend `runId` et retourne les statuts, tentatives, dépendances bloquantes, références d'événements et de messages, et `reusableTaskIds`. Aucun agent supplémentaire n'est lancé. En CLI :

```
npm run retrospective -- --run RUN_ID
npm run retrospective -- --project /path/to/project --run RUN_ID
```

Les tâches terminées, relues et disposant d'une preuve de conformité si elles ont un contrat peuvent être retrouvées via `synapse_memory_search`, même si leur graphe global a échoué. Le statut global est inclus. Les résultats échoués, non relus et les graphes actifs ou annulés ne sont pas inclus dans cette mémoire. Les dépendances obligatoires restent bloquées. Ne jamais assimiler une approbation de modèle à un résultat de test externe ; vérifier la pertinence des éléments historiques avant réemploi.

## Confidentialité

Le rapport exporte des catégories d'erreurs et des métadonnées allowlistées. Le filtre s'applique même aux anciens journaux. Les détails restent dans les fichiers de run locaux, en dehors du ZIP. Les identifiants et rôles restent potentiellement sensibles. Vérifier avant partage. Le moniteur affiche les compteurs de messages omis et de caractères retenus dans les logs disponibles.

## Validation

Les six nouveaux tests couvrent la sélection, l'intégration dans le prompt, la mémoire partielle, l'accès au bilan, les erreurs privées et le filtrage des anciens logs. La suite complète comporte 80 tests. Le contrôle TypeScript du noyau et de l'adaptateur passe. Aucun test avec un véritable fournisseur IA ni gain de temps mesuré à ce stade. Le conseil d'évolution existant reste consultatif ; pas de rétrospective multi-modèles automatique, de graphe de preuves sémantique, ni d'application automatique de modifications.
