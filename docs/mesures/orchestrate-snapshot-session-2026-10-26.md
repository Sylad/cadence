# orchestrate-snapshot rouge en session de vague (L360, 26-10)

Relevé fait depuis deux sessions de vague du lot L360 (vague 2026-10-26-1700), pour que la mesure reste dans le dépôt.
Les trois rouges visés (L346 le 26-10 au matin, L354 dans la vague 1500, sessions 4 à 6) sont, dans `test/orchestrate-snapshot.test.ts` :
« L330 — --resume dont le node_modules de l'instantané est pendu … refus clair, code 2 », « (L61/t2) … yaml introuvable : refus AVANT toute copie, code 2 »
et « L355 R1 — un paquet sans node_modules ne résout pas « yaml » … », avec les assertions « expected +0 to be 2 » (×2) et « expected [Function] to throw ».
Tous trois disent la même chose : un paquet jetable **sans** `node_modules`, créé par `tempDir()` dans la racine privée de la suite, résout quand même `yaml`.

## Environnement d'une session de vague

- `cwd` : `<dépôt>/.cadence/runs/<vague>/worktrees/cadence--<lot>` (un worktree sous le dépôt installé).
- `TMPDIR` : `/tmp/cadence-<8 hex>` — `shortTmpBase()` (`src/orchestrate/state.ts`) retombe sur `/tmp` quand le chemin est long, donc **hors de tout dépôt**.
  Le nom est le sha1 du dossier du lot : **toutes les sessions d'un même lot dans une même vague partagent ce TMPDIR**, et ce qu'une session y laisse
  est encore là pour la suivante (dans celui de L360, la première session avait laissé `old/`, copie du commit d'avant le lot avec un `node_modules` lié, et `np/yaml`).
- `PATH` : `<dépôt>/.cadence/runs/<vague>/tool/bin` en tête, puis le Node du projet, puis le `PATH` du lead.
- `HOME=/home/sylvain_ladoire` hérité ; `NODE_PATH` absent ; posés par la vague : `CADENCE_ORCHESTRATED`, `CADENCE_SESSION`, `CADENCE_MAX_SESSIONS`, `CADENCE_TEST_WORKERS`, `CLAUDECODE`, `PYTHONDONTWRITEBYTECODE`, `KUBECONFIG=/dev/null`.
- Node : `v22.22.3`, `execPath` `~/.nvm/versions/node/v22.22.3/bin/node`. `require('module').globalPaths` : `~/.node_modules`, `~/.node_libraries`, `~/.nvm/versions/node/v22.22.3/lib/node` — **aucun des trois n'existe** sur cette machine.
- `node_modules` du worktree : un vrai dossier dont chaque entrée est un lien vers celle du dépôt vivant (`src/orchestrate/worktree.ts`) ; `node_modules/yaml → ~/projects/developpeur/cadence/node_modules/yaml`.
  La session L354 (vague 1500, rapport 4-fix) parlait d'un `node_modules` lié en bloc : c'était celui du worktree jetable de la base qu'elle avait créé elle-même **sous `$TMPDIR`** (`git worktree add --detach $TMPDIR/base-bbecf26`).

## Mesures

- `createRequire('<TMPDIR>/x.json').resolve('yaml')` échoue pour `TMPDIR`, `/tmp` et `/var/tmp` au moment du relevé : ces dossiers étaient propres.
- Le commit d'avant le lot (384bd0e), extrait dans `$TMPDIR`, passe `test/orchestrate-snapshot.test.ts` 17/17 dans cette session, sans le correctif : le rouge ne tient pas à l'environnement d'une session de vague en soi.
- Reproduction **hors vague** (dossier de brouillon de la session, worktree détaché de 384bd0e dont `node_modules` est un lien vers celui du lot, `vitest run --minWorkers=1 --maxWorkers=10 test/orchestrate-snapshot.test.ts`) :

  | Scénario | À 384bd0e (avant le lot) | À HEAD du lot |
  |---|---|---|
  | `TMPDIR` sous un dossier qui a `node_modules/yaml` | **3 rouges, les mêmes trois tests, les mêmes assertions** que L354 | 18 verts : `pickRootBase` écarte ce `TMPDIR`, la racine privée part de `/tmp` |
  | `HOME` dont `~/.node_modules/yaml` fournit `yaml` | non joué | R1 et R2 rouges, R2 nomme `<HOME>/.node_modules/yaml/index.js` ; L330 et L61/t2 restent verts |

- Pourquoi la seconde ligne ne donne pas la signature : `resolveModulesDir` (`src/orchestrate/snapshot.ts`) refuse déjà, code 2, un `yaml` résolu hors de tout `/node_modules/` — et `~/.node_modules/`, `~/.node_libraries/`, `<prefix>/lib/node/` n'en contiennent pas. Les trois rouges ensemble exigent donc un `yaml` **sous un `node_modules`** atteint depuis un paquet jetable : un `node_modules` d'un dossier parent de la racine privée (`<TMPDIR>/node_modules`, `/tmp/node_modules`), ou `NODE_PATH` pointant sur un `node_modules` — exclu pour les workers depuis L355.

## Conclusion

- Le seul mécanisme qui reproduit la signature est un `node_modules/yaml` dans un dossier parent de la racine privée, donc dans le `TMPDIR` de la session ou dans `/tmp`. Il est compatible avec tout ce qui a été vu : la porte du programme (lancée avec le `TMPDIR` de l'orchestrateur, pas celui du lot) était verte ; les trois sessions de correction de L354, qui partageaient le même `TMPDIR`, l'ont vu rouge l'une après l'autre ; L346 l'a vu vert à la vague suivante, dans un autre `TMPDIR`.
- Il n'est **pas observé directement** : les `TMPDIR` de la vague 1500 ont été supprimés avec elle. L'hypothèse la plus simple est qu'une session du lot (la revue, ou une session qui a rejoué un worktree jetable sous `$TMPDIR`) y a laissé un `node_modules` (lien ou `npm install`), que les sessions suivantes du lot ont hérité.
- Ce qui est tenu : au départ de la suite, `pickRootBase` (`test/global-setup.ts`) écarte tout candidat d'où `yaml` se résout par un dossier parent et nomme ce qui l'a fait écarter. Ce qui ne l'est pas : un `node_modules` écrit dans `TMPDIR` **pendant** le run, et les chemins globaux de Node (là, R1 et R2 rougissent, et R2 nomme le fichier).
- Si le rouge revient : lire le message de `R2 — …` (fichier qui fournit `yaml`, `NODE_PATH`, `HOME`, Node, chemins globaux), puis, avant la fin de la passe, `ls -la $TMPDIR /tmp | grep node_modules`.
