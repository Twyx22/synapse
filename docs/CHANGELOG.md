## 0.13.0 — Cost Intelligence

- Collecte non bloquante pour le résultat via `session.get`, repli contextuel partiel, lecture bornée à 1,5 s.
- Couverture par métrique, déduplication des sessions, séparation workers/reviews/conseil.
- `synapse_costs`, `npm run costs`, `costs.json` dans les diagnostics. Seuil budgétaire consultatif, aucune facture ou dépense plafonnée garantie.
- 100 tests locaux, contrôle TypeScript du noyau. Aucun changement de dépendance ni migration. Voir COSTS.md.

## 0.12.0 — Dynamic Team Intelligence

- Profils historiques et conseils par rôle ; inventaire du stockage dans les diagnostics, découverte locale des projets.

## 0.11.0 — Persistent Intelligence

- Stockage XDG par projet et migration non destructive avec copies privées.
- Doctor, CLI et outil de consultation, backlog consultatif.
- CLI aligné sur le chemin de projet exact, sans recherche de parents.
- Voir STORAGE.md pour migration avant remplacement et limites.

## 0.10.0 — Collective Cognition

- Context selection and metadata, deterministic retrospective, partial reviewed memory, privacy-filtered diagnostics. Six new regression tests; 80 passing locally.

# Synapse changelog

## 0.9.0 — Adaptive Intelligence

- Réservation de capacité avant admission des graphes (8 emplacements par instance, borne exacte du parallélisme structurel). Libération en sortie d'exécution.
- Exclusivité des expériences préenregistrées dans la même instance ; détection des chevauchements avec les autres graphes conservés, verdict inconclusif si historique incertain.
- Conseils de concurrence pour une fixture identique, même version et même label de modèle/configuration. Aucune application automatique.
- Deux outils coordinateur et une commande CLI ; métadonnées d'isolation ajoutées à l'export expérimental.
- 74 tests locaux et contrôle TypeScript du noyau réussis. Pas de nouvelles dépendances ni changement des permissions.

## 0.8.0 — Experimental Intelligence

- Expériences appariées préenregistrées, variation de concurrence uniquement, contrôle exact des résultats de référence et mesure du temps mural.
- Recommandations conservatrices limitées à la fixture : toutes les paires conformes, trois paires minimum, 10 % de gain médian, aucune paire plus lente.
- Persistance privée des inscriptions, CLI et trois outils de coordinateur, export dérivé dans les diagnostics.
- Détection de revues lentes à partir des événements durables, sans supprimer de revue.
- 68 tests locaux et contrôle TypeScript du noyau réussis. Nouvelle intégration OpenCode réelle à valider. Aucune nouvelle dépendance.

## 0.7.0 — Contrats de collaboration et délais bornés

- Contrats de soumission explicite, d'envoi direct et de récupération explicite, vérifiés avant revue ou réussite.
- Validation des dépendances et des engagements réciproques pour les transmissions obligatoires.
- Preuves isolées par tentative ; les sessions obsolètes ne peuvent pas satisfaire un nouveau contrat.
- Délai de collecte par session ; demande d'interruption et absence de retry automatique sur expiration.
- Événements de conformité, métriques du moniteur, métadonnées de diagnostic et proposition `contract_compliance`.
- Agent principal mis à jour. 62 tests locaux réussis ; contrôle TypeScript du noyau réussi. Hôte OpenCode réel à valider.
- Pas de changement des dépendances ni des permissions. La revue obligatoire n'est jamais supprimée.

## 0.6.0 — Live Monitor et visibilité des échanges

- Moniteur hors ligne et profilage par session (CLI et outil).
- Version runtime centralisée, outil de version et différenciation submit/submit_review.
- Mesure du temps de préparation, prompt et attente ; avertissement indicatif si logs absents.
- Enregistrement de la récupération explicite des messages, signalement des messages directs tardifs et proposition d’évolution associée.
- Métadonnées de communication dans les diagnostics ; anciennes données lisibles sans migration.
- 55 tests locaux réussis et contrôle TypeScript du noyau. Validation réelle des nouveaux outils à effectuer.


## 0.5.3 — Protocole de revue indépendant

- Nouveau `synapse_submit_review(approved, reason)` limité à la session de revue active.
- Un verdict textuel invalide est refusé sans verrouiller la soumission ; un agent peut corriger son appel.
- Un verdict final mal formé déclenche au plus une nouvelle revue du même livrable, sans relancer le travail de l'auteur.
- En cas d'échec de protocole répété, la tâche échoue sans approbation implicite et le résultat de l'auteur est conservé.
- Distingue `agent.review.protocol_error`, `task.review_protocol_error` et un rejet de fond ; le rôle est ajouté aux traces de collecte.
- Pas de changement des permissions, ni des critères de validation. Une revue négative valide conserve le comportement normal de révision.

## 0.5.2 — Livraison fiable des résultats et visibilité

- Lecture des messages assistant V2 (`type`, `content`) et compatibilité avec les anciens formats.
- Outil `synapse_submit` réservé à la session active, pour livrer explicitement un résultat ou un verdict sans dépendre de `session.context`.
- Traces prompt/wait, heartbeat toutes les 15 secondes, métadonnées de forme des réponses sans texte brut. Un heartbeat indique une attente côté adaptateur, pas une preuve de progression du modèle.
- Les champs absents ne sont plus journalisés comme chaîne `undefined`.
- 46 tests locaux ; intégration réelle à confirmer. Pas de changement des dépendances ni des autorisations.

## 0.5.1 — Correctif de compatibilité des tests Git

- Les dépôts de test temporaires utilisent une branche dédiée, un dossier de hooks vide propre au dépôt et des commits non signés. Aucun changement des protections Git du projet utilisateur ou de la configuration globale.
- Aucun changement des dépendances npm ni du moteur de production.

## 0.5.0 — Contributions Git et mémoire collective

- Contrats de patch, revue obligatoire, réponse diff bornée et validation de format.
- CLI de staging manuel : worktree détaché, contrôle du SHA256, base Git et liste de chemins.
- Recherche lexicale locale des résultats relus, avec provenance et signalement des runs illisibles.
- Nouveaux outils coordinator-only et journal de staging sans contenu du patch.
- 43 tests locaux, dont tests avec Git réel ; vérification TypeScript du noyau. Pas de validation OpenCode réelle.

## 0.4.0 — Agent principal et collaboration continue

- Agent primaire `synapse`, installateur local/global avec aperçu, sauvegardes et conservation des paramètres.
- Ordonnanceur continu (suppression des barrières de lot), correction de l’annulation déjà déclenchée et retour d’état après interruption.
- Retours de revue transmis aux retries ; résultats paginés.
- Suggestions des workers enregistrées dans Evolution Council ; pas de modification automatique du code.
- Restriction des outils de coordination pour les sessions du conseil connues.
- 34 tests locaux réussis ; hôte OpenCode réel non testé.

## 0.3.0 — Logs et rapports de diagnostic

- Logs JSONL structurés et rotatifs, sans données de conversation brutes.
- Instrumentation des runs, tâches, agents, sessions, messages (métadonnées), revues, erreurs et Evolution Council.
- Export ZIP local depuis l'outil OpenCode ou la CLI hors ligne.
- Rapport contenant les chronologies, statuts, erreurs et métriques, sans prompts/réponses/messages bruts.
- Masquage best-effort des secrets, tests de confidentialité et résilience en cas d'échec du disque.
- 25 tests automatisés réussis localement ; intégration OpenCode réelle encore non validée.

## 0.2.0 — Evolution Council

- Automatic telemetry-based self-improvement hypotheses after terminal runs, with deduplication and provenance.
- Three-agent independent council; optional second round; objections and counterproposals persisted.
- Advice never triggers code edits, merges, spending outside configured session limits, or deployments.
- Auto-council opt-in (off by default) and 5 new OpenCode tools.
- New tests for proposal generation, debate, evidence requirements, persistence and opt-in.
- Still requires real OpenCode V2 host integration testing.

## 0.1.0 — Collaborative Runtime

- DAG scheduler, sessions, peer messages, restricted read-only workers, independent review, retry and durable JSON.
