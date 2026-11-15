# Retrait des vagues — cartographie de `cadence orchestrate` (L727)

Étude en lecture seule, au sha `44a825d0` (2.0.8 + travaux en cours), le 15-11-2026. Aucun code, gabarit, agent ni
test n'a changé : ce document est le seul livrable.

**Pourquoi.** Depuis le 09-11, cadence 2 fait le travail d'un lot avec `cadence run` (une demande, une session,
porte, intégration). Le compte pro ne lance plus de vague depuis cette date et l'a écrit en commentaire de l'issue
#50. Ce qui servait aux vagues (`cadence orchestrate` et tout ce qui l'entoure) coûte encore à chaque lot : une porte
plus lente, des refus et des gardes à maintenir, 375 Ko de documentation. Il continue pourtant de porter des
fonctions que le compte pro utilise toujours : `spec reseal` et `spec green`, `verify --gate`, les créneaux,
`lead hold`.

**Question.** Pour chaque commande et chaque module : **encore utilisé** (par Sylvain ou par le compte pro, hors
vague) ou **ne sert qu'aux vagues** ? Avec le nombre de lignes et de tests concernés, et un ordre de retrait.

**Préalable au retrait.** Le compte pro doit **confirmer par écrit** sur #50 la liste « encore utilisé » de la
[section 2](#2-commandes) et répondre aux [questions ouvertes](#5-questions-au-compte-pro). Aucun lot de retrait ne
démarre avant.

## Verdict

- **Le code des vagues est presque tout séparable.** Dans `src/`, **11 404 lignes de déclarations** (36 % du code
  du paquet hors `v2/`) ne vivent **que** par la commande `orchestrate`. Ce chiffre ne compte ni les imports ni les
  lignes vides. 11 031 de ces lignes sont dans `src/orchestrate/` et 373 dans 17 autres fichiers.
- **73 des 104 fichiers de `src/orchestrate/` ne servent qu'aux vagues** (11 221 lignes physiques, dont tout
  `cycle/`). Ils peuvent partir entiers.
- **31 fichiers sont mixtes.** Ils portent 2 545 lignes encore utilisées par `verify --gate`, `spec reseal`/`green`,
  les créneaux, `lead hold`/`tour`, les tâches locales, `ref` et le hook. Ce code doit être **extrait** avant de
  supprimer le dossier. Les fichiers les plus vivants sont `state.ts` (514 lignes vivantes),
  `launch.ts` (360), `registry.ts` (231), `accept.ts` (205), `ci-parity.ts` (171) et `worktree.ts` (146).
- **Second ordre.** Des commandes qui restent contiennent des **gardes et des lignes qui ne parlent que des vagues**.
  On les simplifie après le retrait (voir [section 3](#3-ce-qui-reste-mais-se-simplifie)).
  `perf`, `corrections` et `inspect` ne lisent que les journaux de vague et ajoutent 513 lignes.
- **Tests.** Sur 9 013 cas (`it`/`test`) répartis dans 589 fichiers de `test/`, **3 444 cas (38 %) ne testent que les
  vagues**. 892 cas (10 %) testent une fonction encore utilisée à partir d'un **montage de vague** (`newLot`,
  `registerWave`, `sealAcceptation`…) : il faut les réécrire, pas les supprimer. 4 677 cas (52 %) ne sont pas
  concernés. **144 fichiers de test partent entiers** (2 047 cas) et 160 sont à élaguer.
- **Le retrait demande une version majeure.** `orchestrate`, sa clé `orchestrate:` de `cadence.yaml`, le skill
  `orchestrate` et ses pages sont des surfaces garanties ([stabilite.md](../stabilite.md) l. 12-21). On les retire en
  **3.0.0**, pas dans une 2.x.
- **Ordre proposé** : la confirmation écrite d'abord, puis 7 lots ≤ 0,5 j (3,5 j au total). On coupe et on supprime
  d'abord, on déplace ensuite : ainsi on ne déplace pas du code qui va disparaître.
  Voir l'[ordre de retrait](#4-ordre-de-retrait-proposé).

## 1. Méthode

Le graphe des imports par fichier ne suffit pas. Par exemple, `lead.ts` importe `continue.ts` pour une seule
fonction (`readPriority`), et cet import tire toute la chaîne des vagues : par fichier, seuls 18 fichiers sortiraient
« vagues seulement ». La mesure se fait donc **par déclaration**, avec l'API du compilateur TypeScript du dépôt
(`node_modules/typescript`, `createProgram` sur `src/**/*.ts` et `test/**/*.ts`) :

1. Chaque instruction de haut niveau d'un fichier de `src/` (fonction, constante, classe, type) est un nœud. Ses
   arêtes sont les identifiants qu'elle cite, résolus par le vérificateur de types, alias d'import compris, jusqu'à
   leur déclaration dans `src/`.
2. **Atteint « complet »** : tout ce qu'on atteint depuis les déclarations de `src/cli.ts`.
   **Atteint « sans vagues »** : la même chose, mais `orchestrate` et `realOrchestrateDeps` de
   `src/orchestrate/command.ts` sont bloqués. Ce sont les deux seuls points d'entrée de la commande, `src/cli.ts:133`.
3. Une déclaration atteinte dans le premier cas mais pas dans le second **ne sert qu'aux vagues**. Une déclaration
   que ni l'un ni l'autre n'atteint est déjà morte : 34 lignes, hors sujet ici.
4. Les lignes d'une déclaration vont de son premier à son dernier caractère, sans les commentaires de tête.
5. **Tests.** Pour chaque appel `it`/`test`, on calcule les déclarations de `src/` qu'il atteint, directement ou par
   les fonctions d'aide de haut niveau du même fichier de test. Un cas est classé ainsi :
   - **pilote** : il atteint le moteur (un fichier de `cycle/`, `execute.ts`, `command.ts`, `pool.ts`, `resume.ts`…)
     ou il appelle la CLI avec `'orchestrate'` ;
   - **helpers seuls** : il n'atteint que du code des vagues ;
   - **mixte** : il atteint du code des vagues **et** une fonction encore utilisée ;
   - **hors** : il n'atteint aucun code des vagues.
6. **Second passage.** On bloque en plus `perf`, `corrections` et `inspect` de `src/cli/stats-commands.ts`, pour mesurer
   ce que leur retrait ajouterait (+513 lignes).

Limites :

- Le paquet `v2/` (`cadence run`) n'importe rien de `src/` (`v2/src/verrou.ts:3`, `v2/src/socle.ts:14`) : il est hors
  du graphe. On a vérifié à la main ce qu'il lit de `cadence.yaml` et de `CADENCE_HOME` (voir
  [section 2](#2-commandes)).
- Le greffon `plugins/cadence-hud/` est hors du graphe, et son code ne passe pas par `src/`. Ses panneaux `lots`,
  `cycle` et `decisions` lisent les vagues et sont à revoir à la main (lot R6).
- Un appel par `import()` dynamique ou par nom de fichier n'est pas vu. Aucun n'a été trouvé vers `src/orchestrate/`
  hors `cli.ts`.

Les scripts de mesure ne sont pas commités, car le lot interdit tout code. Le lot R1 les réécrira en test (voir plus
bas).

## 2. Commandes

| Commande | Classement | Ce qui la tient dans `src/orchestrate/` | Parties qui ne servent qu'aux vagues |
|---|---|---|---|
| `cadence run` (v2) | **encore utilisé** (Sylvain, compte pro) | rien par import. Lit dans `cadence.yaml` `orchestrate.test`, `orchestrate.build` et `orchestrate.prodAccess` (`v2/src/run/run.ts:103-123`) et écrit son registre sous `CADENCE_HOME` (défaut `~/.cadence/orchestrate`, `v2/src/verrou.ts:59-65`), que lit `liveRuns` (`registry.ts:209`) | — |
| `cadence verify --gate --sha` | **encore utilisé** (compte pro, `livreur`, pre-push) | `workers.ts` (90 l.), `gate-parts.ts` (98), `baseline.ts` (130), `ci-parity.ts` (171), `worktree.ts` (`git`, `copyDeps`, `ignoredDeps`…), `lock.ts`, `status.ts#configuredCap` | la reprise du « verdict de la porte de la vague » : `gate-record.ts:69-74` lit `.cadence/runs` |
| `cadence spec reseal` / `spec green` | **encore utilisé** (compte pro, #60 → L729) | `accept.ts` (205 l. vivantes : `resealAcceptation`, `resealForGreen`, `runAcceptation`, `setVert`…), `fiche-amendee.ts` (42) | le refus « pendant une vague » et la commande `--resume … --drop` proposée (`cli/spec-commands.ts:32-60`) |
| `cadence spec check` / `spec qa` | encore utilisé | `maquette-ecran.ts#maquetteEcranProblems` (3 l.) | — |
| `cadence lead hold` / `lead release` | **encore utilisé** (compte pro) | `registry.ts` (`addHold`, `releaseHold`, `liveHolds`, `runNamedBy`) | — |
| créneaux (ligne de `lead tour`, `lead hold`) | **encore utilisé** (compte pro) | `status.ts#slotsLine`, `#configuredCap`, `#expiredHoldLines` (24 l.), `command-args.ts#parseMaxSessions` (5), `registry.ts#freeSlots`/`commonCap`/`liveWaves` | sans vague, `liveWaves` est toujours vide : il reste plafond − `lead hold` − `cadence run` |
| `cadence lead tour` | encore utilisé | `continue.ts#readPriority`/`priorityRank`/`decisionPending` (14 l.), `ci-parity.ts`, `no-test.ts` (32), `state.ts#RunStore`, `worktree.ts#keptTrees` | les lignes « lot rendu » et « intégrable » (`lead.ts:208-224`), les worktrees conservés (`lead.ts:273`), les lots tenus par une vague dans « prochain tirable » (`ready-free.ts:53-91`) |
| `cadence lead priority`, `config set` | encore utilisé | `continue.ts#readPriority` | — |
| `cadence local start\|done\|abort` | encore utilisé | `lock.ts` (verrou du dépôt), `guard.ts#longDuration` (7 l.) | le refus « une orchestration est en cours » et la formule « verrouille comme une vague » de l'aide |
| `cadence deliver`, hook `pre-push` | encore utilisé | `table.ts#blockingLots`/`LABEL` (53 l.), `registry.ts#waveLotsIn` | la garde des lots ouverts d'une vague (`cli/deliver-commands.ts:85-89`, `push-guard.ts:24-32`, `cli/gates.ts:200`, `deliver.ts:388`) |
| `raf done` (contrôles de clôture) | encore utilisé | `accept.ts#redAcceptations`, `state.ts#lotKey`, `worktree.ts#lotBranch` | le refus « lot rendu dans une vague » (`raf-close-checks.ts:43-47`) |
| `cadence claude-hook retour` | encore utilisé | `geste.ts` (51 l. vivantes : `refusalGestures`, `killedGesture`) | les gestes des refus d'`orchestrate` (`--integrate`, `--replay`, `--resume`…) : 54 l. et une partie de la table `REFUSALS` |
| `cadence ref …` (expérimental) | encore utilisé | `launch.ts` (360 l. : `runSession`, `realClaude`, `readAgents`, `claudeConfigDir`), `result.ts` (87), `snapshot.ts#PACKAGE_ROOT`, `decisions.ts#isProgramNote` | — |
| `raf` (tout le reste), `news`, `session`, `release`, `migrate`, `attente`, `demande`, `skills`, `cost` | encore utilisé | `state.ts` (types), `registry.ts#cadenceHome`, `repo-busy.ts` → `integrate.ts#INTEGRATION_LOCK` (1 l.), `main-tree.ts` | `repo-busy.ts:67` (lots ouverts d'une vague) |
| `cadence perf` | **vagues** (en majorité) | — | lit `.cadence/runs` (durées par étape, revue, portes) et les plans ; `cadence run` n'y écrit pas (`v2/src/verrou.ts:65`) |
| `cadence corrections` | **vagues** | `state.ts#PRECHECK_UNREADABLE` | ne lit que les journaux de vague (passes de correction) |
| `cadence inspect` | **vagues** | — | « l'inspection des travaux de la dernière vague » |
| `cadence orchestrate` (tous ses modes) | **vagues seulement** | — | lancement, `--continue`, `--queue`, `queue add\|show\|drop`, `--status [--watch]`, `--follow`, `--resume`, `--answer`, `--add`, `--drop`, `--stop-after-current`, `--waits`, `--integrate`, `--replay`, `--remove-worktree`, `--dry-run` |

Le seul mode d'`orchestrate` qui sert hors vague est `--status`, qui affiche les créneaux libres et les worktrees
conservés. La ligne des créneaux de `lead tour` donne la même information (même `slotsLine`) : `--status` peut partir
si le compte pro le confirme (question Q2).

### Clés de `cadence.yaml` sous `orchestrate:`

- **Encore lues hors vague** : `test`, `build` (porte de `cadence run` et de `verify --gate`), `testReplay`,
  `testRelated`, `worktreeDeps` (worktree jetable de `verify --gate`), `gate` (porte déportée, `remote-gate.ts`),
  `accept` (`spec green`), `prodAccess` (`cadence run`).
- **Lues seulement par les vagues** : `precheck`, `precheckLocal`, `maquette`, `maquetteReviews`, `fiche`, `probe`,
  `spec`, `review`, `ux`, `verdict`, `start`, `testGate`, `escalation`, `budgetTopUp`, `continue`, `effort`,
  `permissionMode`, `addDirs`, `timeouts`, `worktrees`.
- Ce classement vient d'une recherche de chaque clé dans le texte des déclarations vivantes et mortes. Il faut le
  confirmer clé par clé au lot R6, car `config.ts` les lit toutes et reste vivant.

### Hors code

| Pièce | Taille | Classement |
|---|---|---|
| `docs/orchestrate.md`, `-cycle`, `-gate`, `-spec`, `-worktrees` | 375 Ko (1 483 lignes) | vagues. À garder et réécrire : la partie porte de `orchestrate-gate.md` (lue par `verify --gate`) et la partie acceptation de `orchestrate-spec.md` (`spec reseal`/`green`) |
| `skills/orchestrate/` | 41 lignes | vagues |
| `skills/lead/SKILL.md` | 318 lignes, 33 mentions d'`orchestrate` | mixte : délégation à la main, `livreur` et `verify --gate` restent |
| agents `precheck-reader`, `spec-writer`, `acceptance-writer` | 14 Ko | internes à `orchestrate` d'après [stabilite.md](../stabilite.md) l. 37. Voir Q3 : qui écrira les tests d'acceptation ? |
| agents `code-reviewer`, `ux-reviewer`, `doc-keeper`, `livreur`, `qa-reviewer` | — | encore utilisés (lead à la main) ; les modes maquette et conformité d'`ux-reviewer` sont des vagues |
| `templates/orchestrate/` (briefs) | 16 fichiers, 400 lignes | vagues (`briefs.ts#TEMPLATES_DIR`) |
| `.cadence/runs/` des projets | — | journaux de vague, lus par `perf`, `corrections`, `inspect`, `gate-record`, `lead tour` |

## 3. Ce qui reste mais se simplifie

Les 31 fichiers mixtes de `src/orchestrate/`. Colonnes : lignes physiques du fichier, lignes de déclarations encore
utilisées, lignes de déclarations qui ne servent qu'aux vagues.

| Fichier | Lignes | Vivantes | Vagues | Utilisé par (hors `orchestrate/`) |
|---|---:|---:|---:|---|
| `state.ts` | 602 | 514 | 41 | lead.ts, corrections.ts, ready-free.ts, gate-record.ts, raf-close-checks.ts |
| `launch.ts` | 555 | 360 | 59 | ref/command.ts, ref/session.ts, memory-index.ts |
| `registry.ts` | 439 | 231 | 69 | lead.ts, cli/lead-commands.ts, cli/spec-commands.ts, cli/deliver-commands.ts, cli/gates.ts, ready-free.ts, repo-busy.ts, quota-tour.ts, hud-context.ts |
| `accept.ts` | 497 | 205 | 171 | cli/spec-commands.ts, raf-close-checks.ts, audit.ts |
| `ci-parity.ts` | 225 | 171 | 0 | verify-gate.ts, lead.ts |
| `worktree.ts` | 558 | 146 | 250 | verify-gate.ts, verify-gate-plan.ts, remote-gate.ts, gate-record.ts, lead.ts, ready-free.ts, raf-close-checks.ts |
| `baseline.ts` | 199 | 130 | 4 | verify-gate.ts |
| `gate-parts.ts` | 195 | 98 | 21 | verify-gate.ts, config.ts, test-sans-code.ts |
| `workers.ts` | 162 | 90 | 14 | verify-gate.ts, verify-gate-plan.ts, verify-gate-remote.ts |
| `accept-regles.ts` | 165 | 88 | 23 | audit.ts |
| `result.ts` | 118 | 87 | 4 | ref/session.ts |
| `lock.ts` | 99 | 71 | 0 | verify-gate.ts, local-task.ts, repo-held.ts, repo-busy.ts, quota-tour.ts |
| `table.ts` | 340 | 53 | 179 | push-guard.ts, cli/deliver-commands.ts, cli/spec-commands.ts |
| `geste.ts` | 183 | 51 | 54 | claude-hook.ts |
| `fiche-amendee.ts` | 69 | 42 | 0 | (par `accept.ts` : `spec reseal --porteur`) |
| `no-test.ts` | 46 | 32 | 0 | lead.ts |
| `lot-diff.ts` | 76 | 26 | 17 | ready-free.ts |
| `status.ts` | 269 | 24 | 184 | (par `cli/lead-commands.ts` et `verify-gate*.ts`, via `command.ts`) |
| `sandbox.ts` | 40 | 24 | 0 | (par `launch.ts`) |
| `main-tree.ts` | 35 | 21 | 0 | repo-busy.ts |
| `git.ts` | 23 | 15 | 0 | (par `accept.ts`, `worktree.ts`) |
| `partage.ts` | 159 | 15 | 98 | (types seulement) |
| `continue.ts` | 313 | 14 | 211 | lead.ts, priority.ts, config-set.ts, ready-free.ts |
| `integration-vivante.ts` | 144 | 9 | 94 | lead.ts |
| `cycle/plan-writes.ts` | 315 | 9 | 203 | (4 constantes de remise au lead) |
| `guard.ts` | 403 | 7 | 298 | local-task.ts |
| `command-args.ts` | 178 | 5 | 147 | (par `status.ts#configuredCap`) |
| `maquette-ecran.ts` | 88 | 3 | 57 | spec.ts |
| `decisions.ts` | 50 | 2 | 22 | ref/coverage.ts |
| `snapshot.ts` | 278 | 1 | 193 | ref/analyse.ts, ref/regard.ts (`PACKAGE_ROOT`) |
| `integrate.ts` | 410 | 1 | 284 | repo-busy.ts (`INTEGRATION_LOCK`) |

Les 73 fichiers **entiers** qui ne servent qu'aux vagues (lignes physiques) :

- **moteur** : `cycle/` (24 fichiers sur 25, 3 907 ; `plan-writes.ts` est mixte), `cycle.ts` (156), `execute.ts` (467), `pool.ts` (263),
  `resume.ts` (424), `reprise-objectif.ts`, `reprise-rebase.ts`, `retrait.ts` ;
- **commande** : `command.ts` (259), `command-checks.ts`, `dry-run.ts` (267), `draw.ts` (250), `follow.ts`,
  `waits.ts`, `preflight.ts` (207), `node-env.ts`, `queue*.ts` (723) ;
- **étapes** : `ajout.ts` (478), `briefs.ts` (290), `spec.ts` (404), `probe.ts` (241), `precheck.ts`, `tiers.ts`,
  `schemas.ts`, `objectif.ts`, `maquette.ts`, `fiche.ts`, `deja-traitee.ts`, `pires-cas.ts`, `no-finding.ts` ;
- **porte placée** : `gate-place.ts` (247), `gate-host-slots.ts`, `gate-notes.ts`, `portes-table.ts` ;
- **budget et intégration** : `lot-budget.ts`, `budget-mesure.ts`, `cout.ts`, `wall-cap.ts`, `timeouts.ts`,
  `changelog-merge.ts` (252), `mutex.ts`, `app.ts` (206), `attente.ts`, `aval.ts`, `depot.ts`, `express.ts`,
  `constat-classes.ts`, `reglages-lot.ts`.

Hors de `src/orchestrate/`, 373 lignes ne servent qu'aux vagues. Les plus grosses : `doc-readers.ts` (95, le fichier
entier), `test-sans-code.ts` (53, entier), `git.ts` (49), `plan-commit.ts` (34, les messages de commit de vague),
`cost.ts` (26), `audit.ts` (19), `docsync.ts` (17), `ref/coverage.ts` (16) et `testgate.ts` (14).

**Gardes et lignes de second ordre.** Ces fonctions sont vivantes aujourd'hui, mais ne disent quelque chose que
pendant une vague. Elles se suppriment après le retrait et on vérifie chacune par ses tests :

- la reprise du verdict de vague par `verify --gate` (`gate-record.ts:69`) ;
- le refus de `spec reseal`/`green` pendant une vague (`cli/spec-commands.ts:43-60`) ;
- les gardes de `deliver` et du pre-push (`cli/deliver-commands.ts:85`, `push-guard.ts:24`, `cli/gates.ts:200`) ;
- le refus de `raf done` sur un lot rendu dans une vague (`raf-close-checks.ts:43`) ;
- dans `lead tour` : les lignes de vague (`lead.ts:208-273`) et les lots tenus par une vague (`ready-free.ts:53-91`) ;
- `repo-busy.ts:67` ;
- les gestes de `claude-hook retour` pour les refus d'`orchestrate` ;
- les vagues dans le calcul des créneaux (`registry.ts#freeSlots`).

`state.ts#RunStore` (le stockage `.cadence/runs`) n'a plus de lecteur une fois que tout ce qui précède est parti,
ainsi que `perf`, `corrections` et `inspect`.

### Tests

| Classe | Cas | Part |
|---|---:|---:|
| pilote (moteur ou CLI `orchestrate`) | 2 752 | 31 % |
| helpers seuls (n'atteint que du code des vagues) | 692 | 8 % |
| mixte (fonction vivante sur montage de vague) | 892 | 10 % |
| hors (aucun code des vagues) | 4 677 | 52 % |
| **total** (589 fichiers `test/**/*.test.ts`) | **9 013** | |

- **144 fichiers partent entiers** (2 047 cas), dont 95 `orchestrate-*.test.ts` (1 598 cas), 9 `probe*`,
  5 `porte*`, 3 `integrate*` et 3 `plan*`.
- **160 fichiers sont à élaguer** (3 100 cas : 1 397 pilote ou helpers, 892 mixtes, 811 hors). Ceux qui ont le plus
  de cas de vague : `orchestrate-command.test.ts` (149 cas de vague sur 154), `orchestrate-spec-back` (57/59),
  `orchestrate-briefs` (51/54), `orchestrate-sonde-l497` (50/52), `brief-implementation-enrichi-l523` (34/44),
  `orchestrate-maquette-exhaustive` (34/39), `orchestrate-guard` (33/42), `maquette-legere-l459` (32/35),
  `orchestrate-add-goal-budget-l657` (30+3 mixtes/33), `mise-en-service` (28/35).
- **Cas mixtes** : ce sont surtout des tests de `spec reseal`/`green`, `lead tour`, `ready-free`, `verify --gate` et
  `raf done`, montés avec `newLot` (1 952 cas le citent, toutes classes confondues), `registerWave` (393),
  `sealAcceptation` (383) ou `prepareTree` (242). Quand ces aides partent, il faut leur trouver un remplaçant :
  - soit une aide de test (`test/accept-helpers.ts` existe déjà pour l'acceptation) ;
  - soit le montage disparaît avec la garde qu'il servait (second ordre).
- Les tests de `perf`, `corrections` et `inspect` (23 fichiers dont le nom commence ainsi) suivent la décision Q4.

## 4. Ordre de retrait proposé

Le principe : **couper, supprimer, simplifier, puis déplacer**. Ainsi on ne déplace jamais du code qui va mourir, et
chaque lot laisse la suite verte. Chaque lot cite la mesure qui prouve qu'il a fini.

| Lot | Contenu | Est. | Mesure de fin | Risque |
|---|---|---:|---|---|
| **R0** | Pas de code. Poster sur #50 le tableau de la [section 2](#2-commandes) (« encore utilisé ») et les questions Q1-Q5 ; noter la réponse écrite du compte pro dans le plan | — | réponse écrite du compte pro citée en note de R1 | nul |
| **R1** | Couper `cadence orchestrate` : branche `src/cli.ts:133-135`, liste de `bin/cadence.js:19`, ligne d'aide `src/cli.ts:85-86`. Supprimer les 73 fichiers « vagues seulement » et les 144 fichiers de test entiers. Ajouter un test qui rejoue la mesure de la [section 1](#1-méthode) : aucun fichier de `src/orchestrate/` sans déclaration vivante | 0,5 | `npm run typecheck`, `knip` et `npm test` verts ; `cadence orchestrate` répond « outil inconnu » (code 2) | moyen : gros diff, mais purement soustractif |
| **R2** | Dans les 31 fichiers mixtes, retirer les 2 697 lignes de déclarations de vague (sauf `status.ts`, `command-args.ts`, `continue.ts` : ils ne gardent que leurs fonctions vivantes). Élaguer les 1 397 cas pilote ou helpers des 160 fichiers partiels | 0,5 | `knip` sans export inutilisé dans `src/orchestrate/` ; le test de R1 vert | moyen |
| **R3** | Réécrire les 892 cas mixtes sans montage de vague : aides de test dédiées pour l'acceptation et le registre | 0,5 | aucun test n'importe `newLot`, `registerWave` ni `sealAcceptation` ; nombre de cas « hors » ≥ 4 677 + 892 | moyen : il ne faut pas perdre ce que ces cas prouvaient |
| **R4** | Second ordre : gardes de vague de `deliver`, pre-push, `spec reseal`/`green`, `raf done`, `lead tour`, `ready-free`, `repo-busy`, `gate-record`, `claude-hook retour`, `local start` ; créneaux = plafond − `lead hold` − `cadence run` | 0,5 | plus aucun lecteur de `liveWaves`, `waveLotsIn` ni `openWavesIn` ; la ligne des créneaux de `lead tour` est identique hors vague (test de contrat) | faible |
| **R5** | `perf`, `corrections`, `inspect` : les retirer, ou les rebrancher sur les journaux de `cadence run`, selon Q4. Ensuite `RunStore` et `.cadence/runs` n'ont plus de lecteur | 0,5 | plus aucun lecteur de `.cadence/runs` dans `src/` | faible |
| **R6** | Extraire le vivant hors de `src/orchestrate/`, puis supprimer le dossier. Cibles : `src/porte/` (workers, gate-parts, baseline, ci-parity, la partie vivante de worktree, lock), `src/acceptation/` (accept, accept-regles, fiche-amendee, maquette-ecran), `src/registre/` (registry, slotsLine), `src/session-claude/` (launch, result, sandbox, `PACKAGE_ROOT`). Rien d'autre ne change : seuls les fichiers bougent. Revoir les panneaux de vague de `plugins/cadence-hud/`. Trancher les clés `orchestrate:` (Q5) | 0,5 | `src/orchestrate/` n'existe plus ; diff de comportement nul (même suite verte, mêmes sorties d'aide hors ligne `orchestrate`) | faible |
| **R7** | Docs et surfaces garanties : réécrire `orchestrate-gate.md` (porte) et `orchestrate-spec.md` (acceptation) en pages `porte.md` et `acceptation.md`, et supprimer les 3 autres pages ; retirer `skills/orchestrate/`, les agents internes (selon Q3) et `templates/orchestrate/` ; élaguer le skill `lead`. Mettre à jour `stabilite.md`, `files` de `package.json`, `CHECKED` de `scripts/check-links.mjs` et `test/orchestrate-pages-l599.test.ts`. Ajouter le fragment `changelog.d/<lot>.md` en `### Removed`. Publier en **3.0.0** | 0,5 | `test/docs-publiees-l626.test.ts` et vérification des liens verts ; `docs/stabilite.md` ne cite plus `orchestrate` | faible : documentation |

Total : 3,5 j après R0. R1 et R2 peuvent être fusionnés si la porte tient le diff. R5 et R6 sont indépendants l'un de
l'autre une fois R4 fait.

**Ce que le retrait doit garder, et le test qui le prouve.** Chaque lot rejoue les tests existants de ces fonctions :

- `verify --gate` (verdict, rejeu dans un worktree jetable, porte déportée) ;
- `spec reseal`, avec `--porteur` (L729) ;
- `spec green` ;
- la ligne des créneaux et `lead hold`/`release` ;
- `local start|done|abort` ;
- le pre-push ;
- `cadence run`, qui lit `orchestrate.test`, `orchestrate.build` et `orchestrate.prodAccess` (tests de `v2/`, inchangés) ;
- `ref`.

## 5. Questions au compte pro

À poser sur #50 avec la [section 2](#2-commandes), réponse écrite attendue avant R1 :

1. **Q1 — la liste.** Le tableau « encore utilisé » est-il complet ? Utilisez-vous une autre commande ou une autre
   option d'`orchestrate` hors vague, par exemple `--status`, `--remove-worktree` ou `queue` ?
2. **Q2 — les créneaux.** La ligne des créneaux de `lead tour` (plafond − `lead hold` − `cadence run`) suffit-elle à
   la place d'`orchestrate --status` ?
3. **Q3 — l'acceptation.** Les tests d'acceptation scellés que `spec reseal` et `spec green` entretiennent étaient
   écrits par l'agent `acceptance-writer` pendant les vagues. Qui les écrit maintenant : la session `cadence run`, ou
   l'agent appelé à la main ? Faut-il garder les agents `acceptance-writer`, `spec-writer` et `precheck-reader` comme
   agents publics ?
4. **Q4 — les mesures.** `perf`, `corrections` et `inspect` ne lisent que des journaux de vague. Faut-il les retirer,
   ou les rebrancher sur les runs de `cadence run` ?
5. **Q5 — la configuration.** En 3.0.0, faut-il garder la clé `orchestrate:` de `cadence.yaml` pour `test`, `build`,
   `testReplay`, `testRelated`, `worktreeDeps`, `gate`, `accept` et `prodAccess`, ou la renommer (par exemple
   `porte:`) avec une migration `cadence migrate` ? Les autres clés deviendraient inconnues : faut-il un avertissement
   ou un refus ?
