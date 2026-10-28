# Tests rouges à la porte après une implémentation « verte » (L399)

Mesure du 28-10 sur les journaux de vagues du 22 au 28-10 (`.cadence/runs/<vague>/<projet>--<lot>/<n>-fix.json`, rapports de session). `cadence perf` comptait 30 passes de correction « sans revue (tests rouges) » sur 205 : une passe `fix` jouée juste après une écriture, sans constat de revue à lire. Le journal ne dit pas pourquoi la porte était rouge ; la cause se lit dans le rapport de la session de correction (`resume`, `tests`), pas dans un champ structuré.

## Lecture

40 passes de ce type relues dans les rapports (toute passe `fix` qui suit une écriture ou une autre passe, ou ouvre un lot repris ; `perf` en compte 30 dans sa fenêtre). Le rangement par cause est celui des résumés de session, non recompté passe par passe. Trois causes, par lot :

| Cause | Lots | Nature |
|---|---|---|
| Test instable sous charge (le test passe seul) | L251, L256, L320, L325, L329, L332, L341, L342, L344, L349, L350, L346, L354, L364 (deliver Ctrl-C, verify SIGINT/SIGHUP, intégration R23/R25, R16 plan-writes, snapshot, mise-en-service) | Vagues à 31 workers par suite sur 4 sessions : supprimée par L350 (part de machine) et L354 (rejeu seul), 26-10 |
| Échec déjà présent au sha de départ | L346 (2 échecs de `orchestrate-snapshot`) | Supprimée par L213/L361 (ligne de base) |
| **Commande de la session ≠ commande de la porte** | L330 (`scripts/*.d.mts`), L353 (`'doing'` n'est pas un `LotStatus`), L155 finance (`plan-data.test.mjs`) | Voir ci-dessous |
| Test d'un autre projet (e2e Chromium, jest) | L165, L176, L184, L188 (warhammer), L34/L36 | Exclus de la porte de ces projets (`cadence.yaml`) |

Aucune passe sans revue sur les lots de cadence depuis le 26-10 19:50 (vague 2026-10-26-1950 comprise, jusqu'à la vague en cours du 28-10) : les deux premières causes sont éteintes par les lots déjà livrés.

## La cause restante : la commande de la session

Le brief disait « run the project's full test suite and build ». Dans ce dépôt `npm run build` est `tsc -p tsconfig.build.json --noEmit` (`src` seul) alors que la porte (`orchestrate.build`) est `npx tsc --noEmit` (`src` et `test`). Une session qui joue `npm run build` annonce un build vert que la porte rejette : L330 (types de `scripts/mise-en-service.d.mts` absents) et L353 (une valeur de statut invalide dans un test), chacun une passe de correction entière.

## Suppression (L399)

Les briefs `implement`, `fix`, passe des mineurs et passe du bibliothécaire portent désormais `{{gate}}` : les commandes **exactes** de `orchestrate.test` et `orchestrate.build`, à jouer telles quelles, pas une commande plus étroite. Sans commande déclarée, aucune consigne.

## Non mesuré

La sortie rouge de la porte n'est pas gardée dans le journal du lot (seulement dans le constat de la passe `fix`, perdu à la passe suivante) : la cause de chaque passe est relue dans la prose du rapport de session. Un champ structuré par passe est une suite possible, non faite ici.
