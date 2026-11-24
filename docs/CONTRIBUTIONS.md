# Contributions Git — v0.5.2

La fonctionnalité permet de matérialiser des propositions parallèles sous forme de diff Git relu. Les workers et reviewers restent en mode lecture seule. La revue d'un agent n'est pas une preuve de correction et le CLI n'exécute jamais les tests du projet.

## 1. Préparer le run

Dans un dépôt Git local de confiance, utiliser un commit de référence et des chemins explicites. Il est recommandé de partir d'un checkout propre pour que le code lu par les agents corresponde au commit. Les changements locaux ne sont pas copiés vers le worktree. Exemple de demande dans OpenCode :

> Prépare des contributions indépendantes pour cette fonctionnalité. Utilise des tâches Synapse avec contrat de patch, chemins disjoints et revue obligatoire. N'applique pas les patchs. Présente les résultats et leur SHA256.

Le champ `patch` des tâches accepte par exemple :

```json
{"baseCommit":"0123456789abcdef0123456789abcdef01234567","paths":["src/example.ts"]}
```

Le SHA est un exemple à remplacer par le vrai commit. Un résultat doit contenir un seul bloc Markdown `diff`, d'au plus 55 000 octets. Le système refuse les changements binaires, renommages, copies, modes spéciaux et chemins protégés. Le format est contrôlé avant la revue ; l'applicabilité réelle est contrôlée au staging.

## 2. Examiner et placer dans un worktree

Depuis le dossier d'installation de Synapse, avec OpenCode arrêté ou sans run en cours :

```bash
npm run contribution -- inspect --project /chemin/du/projet --run RUN_ID --task TASK_ID
```

Vérifier le diff complet, les chemins et la base. Copier le SHA256 renvoyé. Si tu acceptes le diff :

```bash
npm run contribution -- stage --project /chemin/du/projet --run RUN_ID --task TASK_ID --sha256 HASH
```

Le CLI nécessite Git et Node.js 22+. Il exige un run terminé et une tâche de patch relue. Le résultat indique le chemin temporaire du worktree détaché et `testsExecuted:false`. Il refuse si HEAD a changé, même si le patch aurait pu s'appliquer. La copie initiale du dépôt peut consommer de l'espace disque. Utiliser uniquement avec un dépôt et une configuration Git de confiance : un worktree n'est pas une sandbox système, et Git peut utiliser des filtres locaux de checkout.

Inspecter le diff dans le worktree renvoyé :

```bash
git -C /chemin/du/worktree diff --cached
```

Exécuter uniquement les vérifications du projet que tu as examinées et autorisées. Le CLI n'intègre rien dans la branche initiale. Les worktrees temporaires peuvent disparaître après redémarrage selon la politique de `/tmp`. Pour conserver le résultat, enregistrer manuellement le diff ou la contribution avant de supprimer le worktree. Nettoyer via les commandes Git habituelles après avoir sauvegardé tout travail utile ; le CLI ne supprime pas les worktrees réussis automatiquement.

## 3. Mémoire de projet

L'outil `synapse_memory_search` recherche les mots-clés dans les objectifs, titres et résultats des tâches terminées et relues. Il indique les IDs de provenance, un extrait, le commentaire de revue et la date. Jusqu'à 500 fichiers de run (ordre d'identifiant), jusqu'à 20 résultats, par projet. Pas de modèle d'embeddings, pas de recherche interprojet, pas d'injection automatique des résultats dans les prompts des workers. Les données historiques sont potentiellement périmées ou incorrectes : les vérifier avant réutilisation.

## Limites

Pas de session d'édition native isolée, de fusion automatique, d'intégration multi-patch, ni de tests automatiques du code proposé. Aucun mécanisme ne réécrit Synapse lui-même. Les autorisations d'OpenCode et l'intégration V2 restent à valider dans un hôte réel. Le registre de sessions et le stockage de la v0.4 sont toujours mono-processus.
