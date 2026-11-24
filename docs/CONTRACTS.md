# Synapse 0.7.0 — Contrats de collaboration

Le test réel de la 0.6.0 a terminé ses deux tâches sans aucun message direct ou récupération explicite. Le nouveau contrat permet de déclarer ces actions comme des critères obligatoires, contrôlés par le moteur et non par une déclaration du modèle.

## Exemple de plan (arguments de synapse_plan)

```json
{
  "objective": "Vérifier une transmission et une revue",
  "concurrency": 2,
  "tasks": [
    {"id":"a","title":"Calcul","instruction":"Calcule 15 × 15, envoie le résultat à b, puis soumets-le.","review":false,"maxAttempts":1,"timeoutSeconds":300,"contract":{"requireSubmit":true,"sendTo":["b"]}},
    {"id":"b","title":"Vérification","instruction":"Consulte ton inbox, vérifie le calcul et soumets ta conclusion.","dependsOn":["a"],"review":true,"maxAttempts":1,"timeoutSeconds":300,"contract":{"requireSubmit":true,"receiveFrom":["a"]}}
  ]
}
```

Après autorisation du travail et du coût des modèles, exécuter avec `synapse_execute`. Pour une transmission obligatoire, le destinataire doit avoir le producteur comme dépendance directe ou transitive ; le producteur doit déclarer `sendTo`. Les transmissions simultanées facultatives restent possibles, mais elles ne constituent pas des rendez-vous interactifs garantis.

- `requireSubmit`: résultat reçu par le canal explicite `synapse_submit`, pas par le fallback contextuel.
- `sendTo`: message direct observé pour chaque destinataire déclaré, avant son état terminal. Un broadcast ne suffit pas.
- `receiveFrom`: récupération via l'outil `synapse_inbox` d'un message direct émis par la tentative réussie du producteur. Le contexte préchargé ne suffit pas.
- Le moteur contrôle ces obligations avant la revue indépendante. Un défaut entraîne un échec ou une nouvelle tentative si le plafond déclaré le permet. Les dépendants sont bloqués en cas d'échec définitif. Les erreurs sont enregistrées dans `task.contract_error`.
- Le contrat est facultatif et n'est pas rétroactivement ajouté aux anciens runs. Le statut de conformité ne prouve pas la justesse du résultat, ni la compréhension du message par le modèle. Les revues et validations habituelles restent nécessaires.

## Délais de session

`timeoutSeconds` : entier de 10 à 1800, défaut 600. Le délai commence au lancement de la collecte (prompt, wait, contexte), après création/configuration de la session. Il s'applique individuellement à la session de travail ou de revue, non à tout le graphe. Une expiration enregistre `agent.timeout`, demande l'interruption de la session et échoue sans nouvelle tentative automatique du worker. Une interruption distante non confirmée doit être inspectée dans OpenCode ; elle ne prouve pas que la facturation a cessé. Les appels de création/configuration, le conseil d'évolution global et les opérations Git ne disposent pas encore de deadlines globales. Les heartbeats ne sont pas une preuve de génération active.

## Suivi et test

- `synapse_status` ou `synapse_execute` expose `contractEvidence`, y compris les obligations manquantes et le canal de soumission.
- `npm run monitor` et `synapse_profile` exposent les compteurs de défauts de contrat et de timeouts.
- `synapse_diagnostics_export` inclut des compteurs de conformité sans corps de message ni résultat. Examiner le ZIP avant partage.
- Le scan du conseil peut produire une idée `contract_compliance` sur les défauts de conformité. Les débats restent soumis à autorisation et les idées ne sont pas des changements automatiques.

La suite locale utilise un adaptateur simulé. Il faut tester le plan ci-dessus sur un véritable hôte OpenCode avant de considérer l'intégration validée. Aucun changement des permissions ni des dépendances npm n'a été introduit ; les alertes amont ne sont pas corrigées par cette version.
