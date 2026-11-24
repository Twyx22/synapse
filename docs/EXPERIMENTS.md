# Synapse 0.8.0 — Experimental Intelligence

## Ce qui est réellement disponible

Le moteur compare des paires préenregistrées de runs sur un problème déterministe en lecture seule. La **seule variable modifiée** est la concurrence (nombre maximal de workers). Il ne lance aucun agent de sa propre initiative, n'installe rien, ne modifie ni les réglages ni le code. Les exécutions normales utilisent toujours `synapse_execute`, sur autorisation de l'utilisateur.

- `synapse_experiment_register` : enregistre de 1 à 5 paires de plans vierges, des résultats de référence et une étiquette de configuration. Tous les plans doivent être identiques (objectif, ordre, instructions, rôles, dépendances, contrats, revue, délais, retries, limites d'historique), sauf la concurrence. Les tâches de patch ne sont pas acceptées.
- `synapse_experiment_list` : liste les expériences persistantes locales sans divulguer les réponses de référence.
- `synapse_experiment_evaluate` : mesure les paires, en comptant également les échecs et en refusant une recommandation si un résultat est invalide. Aucun appel de modèle.
- Une expérience peut référencer une idée existante du conseil par `proposalId`. Ce lien ne constitue ni une approbation ni une validation de l'idée.
- Le conseil détecte aussi les revues particulièrement lentes dans les tâches à une tentative, à partir d'événements complets. Il propose une investigation, sans retirer la revue ni modifier les permissions.

## Tester une première paire dans OpenCode

1. Confirmer le runtime `0.8.0` avec `synapse_version`.
2. Créer deux plans identiques via `synapse_plan`. Utiliser deux tâches indépendantes, sans modification du dépôt. Fixer `maxAttempts: 1`, `contract: {"requireSubmit":true}`, `review: false` (fixture arithmétique simple sans revue demandée), et `timeoutSeconds: 120`. Les seules valeurs différentes entre les plans sont `concurrency: 1` et `concurrency: 2`.
3. Les instructions de a demandent le produit 17 × 13, de b le produit 23 × 7. Elles exigent une soumission exacte du nombre seul sans donner les réponses.
4. Avant toute exécution, appeler `synapse_experiment_register` :

```json
{
  "pairs": [{"baselineRunId": "<identifiant du plan 1>", "candidateRunId": "<identifiant du plan 2>"}],
  "expected": [{"taskId":"a", "text":"221"}, {"taskId":"b", "text":"161"}],
  "modelLabel": "<modèle et configuration réellement utilisés>"
}
```

5. Avec accord explicite de l'utilisateur, exécuter les deux plans séparément et séquentiellement, sans autres runs simultanés. Ne pas changer le modèle ni les réglages. Ne pas exécuter de nouveaux plans pour effacer un échec.
6. Évaluer l'expérience, puis exporter les diagnostics sur demande. Un seul essai valide normalement les mesures et peut produire `insufficient_pairs`, mais ne justifie pas une recommandation de stratégie.

Pour une comparaison exploratoire plus robuste, enregistrer au moins trois paires avant de lancer la première. Alterner l'ordre des variantes d'une paire à l'autre. Fixer le budget avant toute exécution. Maximum 5 paires dans une expérience ; le moteur ne les exécute pas en boucle automatiquement.

## CLI hors ligne

Depuis le répertoire du projet :

```bash
npm run experiments
npm run experiments -- --experiment experiment_<UUID>
```

Depuis le répertoire de Synapse pour un autre projet :

```bash
npm run experiments -- --project /chemin/du/projet
npm run experiments -- --project /chemin/du/projet --experiment experiment_<UUID>
```

Le CLI ne déclenche aucun appel de modèle. Les inscriptions sont conservées dans `experiments/` du stockage du projet (XDG depuis 0.11.0, voir STORAGE.md) ; les résultats sont recalculés sur les enregistrements de runs locaux. La suppression ou la corruption des runs rend donc l'analyse incomplète. Les fichiers d'inscription sont privés et contiennent les réponses de référence ; ne les partage pas directement.

## Critères et limites

- Durée murale : différence entre les événements `run.started` et `run.finished`. Les runs interrompus/repris, les mesures manquantes et les exécutions chevauchantes à l'intérieur de l'expérience ne peuvent pas justifier une recommandation.
- Qualité : chaque tâche doit être terminée, donner le texte de référence exact (espaces extérieurs ignorés), satisfaire ses contrats et passer les revues qui lui ont été imposées. Ce test ne mesure pas la justesse générale d'une application.
- Gain d'une paire : `(durée_baseline - durée_candidate) / durée_baseline`. Le moteur donne la médiane des paires valides ayant passé le contrôle de qualité, sans ignorer les autres paires pour sa décision globale.
- Une stratégie candidate est seulement signalée `candidate_promising` si au moins 3 paires sont toutes comparables, toutes passent la qualité, aucune n'est plus lente et la médiane du gain atteint 10 %. C'est un seuil heuristique conservateur, pas un test de significativité statistique.
- Une seule paire valide donne `insufficient_pairs`. Des résultats faux donnent `quality_gate_failed` pour une expérience entièrement mesurable. Une expérience interrompue, incomplètement mesurée ou chevauchante peut donner `inconclusive` ; tant qu'une exécution manque, elle reste `pending`.
- L'étiquette de modèle est déclarative ; la charge du fournisseur et les autres conditions externes ne sont pas contrôlées. Le coût et les tokens ne sont pas mesurés par cette version. Aucun changement automatique de politique, aucune diminution automatique des revues et aucune optimisation des autorisations.
- Les exports de diagnostic ajoutent `experiments.json` si une expérience existe ; seules les métriques dérivées et les identifiants sont exportés, pas les réponses attendues, les instructions ou l'étiquette du modèle. Comme précédemment, inspecter les ZIP avant partage.

## Validation

Les tests utilisent un adaptateur local simulé et des fixtures de temps déterministes, plus de vraies exécutions du planificateur avec adaptateur factice. Ils valident la logique, pas une accélération du fournisseur IA. La compatibilité des trois nouveaux outils avec un hôte OpenCode réel doit encore être vérifiée.
