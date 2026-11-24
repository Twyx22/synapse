# v0.13.0 — Cost Intelligence

## Mesures et provenance

Le moteur lit `ctx.session.get({sessionID})` après la résolution de `session.wait` : les agrégats OpenCode de la session (USD et catégories de tokens) sont préférés. L'identifiant retourné doit correspondre à la session demandée. Si le runtime ne fournit aucune métrique, le contexte déjà récupéré ou une lecture supplémentaire du contexte sert de repli partiel. Les entrées assistant/compaction identifiées sont dédupliquées ; une catégorie manquante sur une entrée visible invalide son total contextuel. Le contexte peut être tronqué par OpenCode. Les valeurs numériques invalides, négatives, infinies, ou fractionnaires pour les tokens sont ignorées.

Sources : documentation OpenCode Server Plugin (`https://opencode.ai/docs/build/plugins/server`) et API (`https://opencode.ai/docs/api`, Session.Info, Session.Message.Assistant, TokenUsage.Info, Money.USD). La compatibilité du runtime installé reste à vérifier sur une vraie session.

La collecte est sans génération IA supplémentaire et limitée à 1,5 seconde après la collecte normale. Une erreur de télémétrie n'invalide pas un résultat accepté. Une session interrompue avant la fin de l'attente est comptée comme non mesurée, pas comme gratuite. Le délai supplémentaire de télémétrie ne constitue pas une garantie d'arrêt d'une lecture distante. Les sessions de revue répétées sont comptées distinctement ; les débats du conseil sont classés séparément. Aucune nouvelle autorisation, aucun changement de modèle, aucune suppression de revue.

## Utilisation

```bash
npm run costs -- --project "$PWD"
npm run costs -- --run RUN_ID
npm run costs -- --run RUN_ID --budget-usd 0.10
npm run report -- --run RUN_ID
```

Outil coordinateur : `synapse_costs({runId?, budgetUsd?})`. Un budget est un seuil d'analyse **a posteriori**, jamais un plafond de dépenses. `costs.json` est inclus dans chaque ZIP de diagnostic et contient les agrégats numériques et les indicateurs de couverture. Les logs ne contiennent pas les réponses brutes du fournisseur, les noms de modèles ni le contenu des messages pour cette fonctionnalité.

### Interprétation

- `observed`: somme des valeurs observées pour cette catégorie, ou `null` si absente. Zéro explicite signifie « OpenCode a déclaré 0 », et non « coût facturé nul ».
- `coveredSessions`: nombre de sessions retenues avec cette catégorie valide.
- `settledAggregateSessions`: nombre de sessions dont la valeur est issue de `session.get` après attente résolue.
- `completeForRetainedSessions`: vrai uniquement si chaque session visible dans les logs a un agrégat valide après attente résolue. Cela ne garantit ni exhaustivité globale ni facturation exacte.
- `reviewShareOfReportedCost`: part des revues dans le coût observé de toutes les catégories de sessions, conseil inclus ; `null` si couverture insuffisante, rôle inconnu, ou dénominateur nul.
- `budget.status`: `observed_over_limit`, `observed_within_limit_not_verified` ou `insufficient_coverage`.

Les catégories input/output/reasoning/cache sont conservées séparément : ne pas les sommer sans connaître la sémantique du fournisseur. Les valeurs de coût ne sont ni converties en euros ni estimées depuis les caractères.

## Limites

Télémétrie locale sur les journaux retenus (2 000 lignes / 2 Mo par lecture par défaut ; rotation des logs existante), non un registre comptable exhaustif. Les anciens journaux archivés, les sessions du coordinateur, les dépenses hors Synapse, les frais non rapportés, les appels dont la télémétrie manque et les charges du fournisseur ne sont pas couverts. Les graphes importés antérieurs ne sont pas rétroactivement mesurés. Les valeurs agrégées ne sont pas attribuées à un modèle, car une session peut changer de modèle. Un budget d'abonnement ou un plafond en temps réel nécessitent une source fiable distincte ; aucun modèle ou réglage n'est automatiquement changé. Pas de nouvelle dépendance ni migration de stockage.

## Validation

`npm test` (100 tests locaux), contrôle TypeScript du noyau `tsconfig.core.json`. Les tests de l'adaptateur utilisent des mocks OpenCode ; la télémétrie du fournisseur réel n'est pas validée par ces tests. Faire un graphe de deux sessions (worker + review), avec une seule tentative et une deadline de 120 secondes. Inspecter le ZIP et comparer aux statistiques locales d'OpenCode lorsqu'elles sont disponibles. Si les données sont absentes, conserver ce résultat comme tel.
