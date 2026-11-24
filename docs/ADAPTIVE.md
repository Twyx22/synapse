# v0.9.0 — Adaptive Intelligence

## Capacité locale

`synapse_resource_status` affiche le nombre d'emplacements réservés, disponibles, les identifiants des graphes et une éventuelle expérience exclusive. Le plafond est de huit emplacements par objet Synapse. Chaque graphe réserve au plus min(concurrence demandée, largeur du DAG). La largeur est calculée à partir de la fermeture transitive et d'un couplage biparti maximal : c'est une borne du parallélisme de tâches, pas une prédiction de durée. Les revues successives occupent le même emplacement de tâche. Une demande qui dépasse la capacité est refusée avant tout lancement et laisse le graphe planifié. Les réservations sont libérées dans le finally du run.

Le plafond ne couvre ni d'autres objets Synapse, processus, projets, ni les débats indépendants du conseil, ni les sessions distantes dont l'interruption n'est pas confirmée. Ce n'est pas une limite financière ou une isolation de sécurité. Les anciens fichiers restent compatibles ; aucun changement de permission.

## Isolation des expériences

Un graphe appartenant à une expérience préenregistrée refuse de démarrer si un autre graphe est admis dans la même instance. Un graphe ordinaire est refusé tant que l'expérience est admise. Le moteur ne tue pas les tâches existantes, ne réduit pas la concurrence et ne relance pas automatiquement une demande refusée. Cette exclusivité porte sur les graphes, pas sur tous les appels au fournisseur IA. Les inscriptions doivent être réalisées avant exécution.

L'évaluation inspecte également les intervalles d'exécution des autres graphes présents dans le répertoire de données, y compris les interruptions. `isolation.status` peut être `no_local_overlap_observed`, `overlap_detected`, `unknown` ou `not_measured`. Un chevauchement ou une histoire incertaine interdit une recommandation. L'analyse ne peut pas détecter des fichiers supprimés, des activités externes ou des sessions non journalisées. Les anciens résultats peuvent donc être réévalués avec des conclusions plus prudentes. L'export ZIP ajoute ces métadonnées, sans réponses ni labels de modèle.

## Conseils de stratégie

Appeler `synapse_strategy_advice` avec `runId` et `modelLabel`, ou :

```sh
npm run strategy -- --run run_ID --model-label 'label exact du modèle et de sa configuration'
```

Le plan, les contrats, les revues, les délais et les instructions doivent correspondre exactement à la fixture enregistrée. Le label du modèle est déclaré, non vérifié auprès du fournisseur. Les preuves d'une autre version sont affichées à titre historique. Un candidat est suggéré uniquement si les expériences correspondantes de la version courante sont toutes prometteuses pour ce candidat (critères v0.8), et qu'un seul candidat satisfait ce critère. Sinon, `keep_current`. Les historiques sans preuve suffisante ne deviennent pas une politique de production.

La commande n'appelle aucun modèle, ne change aucun réglage, ne modifie pas le plan et ne déclenche aucune expérience. La largeur du graphe est indicative, même lorsqu'aucune expérience ne correspond. La recommandation reste spécifique à la fixture, pas à tous les projets. L'optimisation automatique de concurrence, la mesure de tokens/coûts et l'auto-modification restent hors périmètre.

## Test rapide sur OpenCode

1. Confirmer `synapse_version` = `0.9.0` et appeler `synapse_resource_status`.
2. Créer un graphe non exécuté avec deux tâches en chaîne et une concurrence de 4. Appeler `synapse_strategy_advice` avec le modèle réel : largeur attendue 1, `concurrencyAboveWidth` vrai ; aucune recommandation expérimentale si aucun résultat correspondant.
3. Créer deux graphes de deux tâches indépendantes strictement identiques, concurrence 1 et 2, contrats de soumission obligatoire, sans revue pour cette fixture arithmétique non critique. Enregistrer avant exécution, puis exécuter seulement ces deux graphes dans l'ordre, sur autorisation. Vérifier `isolation.status`, qualité et `insufficient_pairs` si les contrôles réussissent. Ne pas lancer de graphe supplémentaire ni changer les réglages.
4. Exporter les diagnostics et examiner l'archive avant de la partager. Les tests locaux couvrent séparément les refus d'admission et la libération des réservations, sans appels de modèles.
