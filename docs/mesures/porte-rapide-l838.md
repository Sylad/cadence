# Porte rapide de cadence run : mesure avant/après sur cadence (L838, D-33)

Constat de l'étude L835 : chaque porte de `cadence run` rejouait la suite complète (11 min sur cadence), à la porte du travail et
après chaque correction, puis encore à la livraison (`cadence verify --gate`). La porte rapide (`run.fastGate`, voir
[config.md](../config.md#fast-gate-during-a-run-runfastgate)) ne joue pendant le run que les tests touchés par le diff du lot ; la suite
complète reste jouée une fois, à la porte de livraison, car aucun verdict n'est noté pour une porte rapide.

## Méthode

- Avant : `npx vitest run` sur l'arbre du lot, une fois (`Duration` de vitest).
- Après : pour des lots déjà livrés, la sélection que fait `choisir` (scripts/porte-rapide.mjs) sur leur diff, avec la clé
  `run.fastGate` préparée dans `cadence.yaml` (en commentaire jusqu'à la publication de la version qui contient L838), puis la commande liée jouée telle quelle (`npx vitest related --run <fichiers>`).
- Machine : Big-Blue, 32 cœurs, charge 12 à 47 pendant la mesure (d'autres runs tournaient) : les durées sont des ordres de grandeur.
- Dans un run, chaque porte garde désormais sa portée et sa durée dans l'état (`portes[]` : `ciblee`, `ok`, `duree_s`) : la mesure
  continue sur les vrais runs sans outil à part.

## Résultats

| Lot | Fichiers touchés | Sélection | Fichiers de test joués | Durée |
|---|---|---|---|---|
| (suite complète) | — | — | 690 | 440 s |
| L757 (agents, doc, un script) | 8 | ciblée | 13 | 45 s |
| L811 (`scripts/analyse.mjs`) | 5 | ciblée | 504 | 356 s |
| L841, L794, L781, L778 | 9 à 37 | ciblée | non joués | — |
| L803 | — | suite complète : `cadence.yaml` touché | 690 | 440 s |
| L840 | — | suite complète : fichier supprimé | 690 | 440 s |

Lecture : le gain est net pour un lot périphérique (L757 : ÷ 10). Il est faible pour un lot qui touche un module central, importé
par presque tout (`scripts/analyse.mjs`, `scripts/etapes-porte.mjs` : 523 fichiers de test, 502 s, `src/cli.ts`, `v2/src/run/run.ts`) :
`vitest related` suit le graphe d'import et retrouve alors presque toute la suite. Le repli sûr (fichier supprimé ou déplacé, fichier
de `full`, `cadence.yaml`) joue la suite complète, comme avant.

## Limites

- Non mesuré : un run complet avec corrections, où le gain se multiplie par le nombre de portes rejouées. Le champ `portes[]` le
  donnera sur les prochains runs de cadence.
- Un test qui lit un fichier sans l'importer n'est trouvé que s'il cite son nom (lecteurs par nom) ou s'il est déclaré dans `bounds`.
  Ce qu'il manque est rattrapé par la suite complète de la porte de livraison.
