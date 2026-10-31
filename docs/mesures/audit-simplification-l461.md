# Audit de simplification du code (L461, 31-10-2026)

Lecture seule : aucun fichier du paquet, aucun test n'a été changé. Chaque point ci-dessous est un lot de nettoyage
possible (≤ 0,5 j, sans changement de comportement observable, suite verte sans toucher aux tests sauf ceux de code
mort), à créer par le lead. Les mesures viennent des outils de L462 (`node scripts/qualite.mjs`, `qualite-baseline.json`)
et se rejouent avec les commandes de la dernière section ; chaque lot doit **faire baisser la ligne de base**
(`npm run qualite:cliquet`), le découpage d'un fichier passant par `--migrer --contre main` (voir `docs/qualite.md`).

## Mesures de départ (sha `e6c018ee`)

| Mesure | Valeur |
|---|---|
| Fichiers source / lignes (`src`, `scripts`, `bin`) | 95 fichiers, 19 064 lignes (jscpd) |
| Plus gros fichiers (lignes physiques) | `orchestrate/cycle.ts` 3 047 · `orchestrate/command.ts` 1 768 · `cli.ts` 1 619 · `plan.ts` 1 239 · `perf.ts` 963 |
| Base ESLint / sonarjs | 282 constats ; `cycle.ts`, `command.ts` et `cli.ts` ont chacun les quatre règles de taille et de complexité en défaut |
| Base knip | 153 (67 exports + 85 types jamais importés, 1 dépendance non déclarée) dont 15 dans `test/` |
| Base jscpd | 8 blocs, 82 lignes (0,19 % des lignes) |
| Tests | 252 fichiers, 59 356 lignes, 4 843 tests dont 8 sautés par condition d'environnement (suite : 4 835 verts) ; aucun `skip`/`todo`/`only` inconditionnel (seulement des `it.skipIf`) |

## Points classés (gain décroissant, risque croissant à gain égal)

Colonne « Protégé par » : les tests qui échoueraient si le nettoyage changeait le comportement.

### A. Retirer `export` des symboles que personne n'importe — gain fort, risque nul

- **Quoi** : 150 des 152 exports/types signalés par knip sont utilisés dans leur propre fichier ; seul le mot `export` est en trop
  (`audit.ts` 9, `config.ts` 8, `perf.ts` 8, `corrections.ts` 13, `ref/*` 36, `lead.ts` 5, `hud-context.ts` 6, `release.ts` 5…).
  Les deux seuls vraiment morts (déclarés, jamais lus) : le type `Exclusion` (`ref/coverage.ts:72`) et `ÉcritBack` (`test/spec-helpers.ts:52`).
- **Mesure** : base knip 153 → ≈ 3 (reste : `vite` non déclaré, voir E). Lignes : −0 (le contrôle est le compilateur).
- **Protégé par** : `tsc --noEmit` (un import cassé ne compile plus) ; aucun test à toucher. Deux lots d'une demi-journée :
  `src/` (hors `ref/`) puis `src/ref/` + `test/`.
- **Piège** : un export retiré dont le test est le seul lecteur (cf. B) fait échouer le test : traiter B avant.

### B. Code de production que seuls les tests appellent — gain moyen, risque faible

Trois fonctions ne sont appelées par aucune ligne de production (`grep` sur `src`, `bin`, `scripts`) :

| Fonction | Fichier | Tests qui la lisent | Remarque |
|---|---|---|---|
| `staleFiles` | `src/clean.ts:231` | `clean.test.ts` | enveloppe de `scanStale(...).stale` ; le test peut appeler `scanStale` |
| `claudeConfigDir` | `src/orchestrate/launch.ts:156` | `orchestrate-launch.test.ts` (L398) | **jumelle oubliée** : la même expression `env.CLAUDE_CONFIG_DIR \|\| join(…, '.claude')` est recopiée dans `orchestrate/command.ts:1766` et `ref/command.ts:39`. Le bon nettoyage est de **l'utiliser** aux deux endroits, pas de la supprimer |
| `readFailedDeliveries` | `src/state.ts:295` | `deliver-rouge.test.ts`, `deliver-rouge-raison.test.ts` | enveloppe de `readFailedEntries(dir).map(e => e.day)` ; les 4 appels de test passent à `.map` |

- **Mesure** : −3 fonctions (≈ −10 lignes), −2 copies de l'expression `claudeHome`. Base knip inchangée (ces trois sont exportées, importées par les tests) mais le code de production baisse.
- **Protégé par** : les tests ci-dessus (ce sont eux qu'il faut adapter : « sauf ceux de code mort »).
- Une trentaine d'autres exports ne sont lus que par un test (`articleHeadings`, `parseWaits`, `shellArg`, `buildRetryArgs`…) ;
  ils sont utilisés dans leur fichier, donc A suffit si le test les importe encore par le chemin d'un autre export. À ne pas
  traiter : ce sont des points d'entrée de test légitimes.

### C. Découper les trois gros fichiers — gain fort, risque moyen (un lot par fichier, ≤ 0,5 j chacun)

La découpe se fait par `--migrer --contre main`. Les tests importent `cycle.js`, `command.js`, `cli.js` : **garder chaque
module d'origine comme façade qui ré-exporte** pendant le lot, pour ne toucher à aucun test.

**C1. `orchestrate/cycle.ts` (3 047 l., base `max-lines` 2 371, complexité cognitive 796, fonctions 565 l. hors limite)**
Coupes naturelles, repérées aux frontières de responsabilité (numéros de ligne à `e6c018ee`) :

| Module cible | Contenu | Lignes |
|---|---|---|
| `cycle/ctx.ts` | `Budget`, `WaveCtx`, `LotTree`, `LotCtx`, `workDir`, `save`, `transition`, `stop` | 45–172 |
| `cycle/budget.ts` | `lotSpent`, réserves, `budgetStep`, `fixAffordable`, `overBudget`, `halted` | 629–715, 1262–1283 |
| `cycle/plan-writes.ts` | `planBefore`, `commitPlan`, `planWrite`, `refusal`, `foreignDirty`, `leadMoved`, notes d'hypothèses/mineurs | 174–250, 1719–1792, 2686–2760 |
| `cycle/brief.ts` | `briefFor` (134 l.) et ses `…Text` | 359–624 |
| `cycle/session.ts` | `session` (340 l.), `checkTiers`, `handBack`, `moveStray`, `badReport` | 714–1320 |
| `cycle/precheck.ts` | `needsPrecheck`, `precheckNothingToFind`, `precheck` | 1323–1480 |
| `cycle/spec-steps.ts` | `specStep`, `reviewSpecStep`, chemin fiche/maquette | 1480–1866 |
| `cycle/accept-step.ts` | `acceptStep`, `acceptProblems`, `greenDrift` | 1868–2034 |
| `cycle/checks.ts` | `runChecks`, `integratedChecks`, `replayAlone` | 2035–2150 |
| `cycle/work.ts`, `cycle/review.ts` | `work` (210 l.) ; `review`, `reviewStep`, `conclude`, `writeVerdict` | 2151–2380, 2380–2685 |
| `cycle/integrate-lot.ts` | `integrateLot`, `shortReview`, questions non-bloquantes | 2760–2935 |

Ordre conseillé : `ctx` d'abord (tout le reste en dépend, ce qui évite les cycles d'import), puis `budget`, `brief`, `plan-writes`,
puis les étapes une par une. Un lot = `ctx` + 3 modules feuilles ; un second = `session` ; un troisième = les étapes.
- **Mesure** : `max-lines` du fichier 2 371 → ≈ 300 de façade ; la somme `max-lines` n'augmente pas (transfert admis).
- **Protégé par** : `orchestrate-cycle.test.ts` (3 105 l.) et 46 autres fichiers qui importent `cycle.js`
  (`orchestrate-spec-back`, `orchestrate-aval`, `orchestrate-guards`, `orchestrate-porte-test`, `orchestrate-worktree-*`…) ; fortement protégé.
- **Risque** : cycles d'import (`session` ↔ étapes) — d'où `ctx` en premier ; fonctions `session` et `work` à ne **pas** réécrire dans ce lot (les couper en plus petites est un lot à part).

**C2. `orchestrate/command.ts` (1 768 l., complexité 769)** : `resume` (286 l.) et `execute` (229 l.) sont les deux
fonctions les plus longues du fichier.

| Module cible | Contenu | Lignes |
|---|---|---|
| `command-args.ts` | `Args`, `parseOrchestrateArgs`, `parseBudget`, `lotBudgetArg`, `lotArg` | 143–280 |
| `budget-basis.ts` | `lotBudget*`, `ordinaryBasis`, constantes `LOT_BUDGET_*` | 83–140 |
| `preflight.ts` | `preflight`, `resolveTargets`, `notLoggedIn`, versions Node | 281–484 |
| `dry-run.ts` | `dryRun`, `continueDryRun`, `ficheMeasure`, `planMessageLines` | 485–620, 967–1000 |
| `status.ts` | `slotsLine`, `liveLines`, `statusView`, `control`, `answerLive`… | 622–722, 1321–1427 |
| `resume.ts` | `resume`, `resumeArgv` | 1428–1728 |

- **Mesure** : `max-lines` 1 475 → ≈ 600 pour `command.ts` (le corps de `orchestrate` + `execute`).
- **Protégé par** : `orchestrate-command.test.ts` (2 239 l.) et 22 autres fichiers (`orchestrate-control`, `orchestrate-reprise-*`, `orchestrate-reseal`…).

**C3. `cli.ts` (1 619 l.)** : `dispatch` fait 597 lignes (complexité 526 pour le fichier, cognitive 723).
Le `switch` de ~40 `case` se découpe en **un module par famille de commandes**, `dispatch` ne gardant que la table
commande → fonction : `cli/gates.ts` (`gate`, `preCommit`, `postCommit`, `prePush`, `warn*`), `cli/spec-commands.ts`
(`specGreen`, `specReseal`, `openWavesRefusal`, `unfinishedWaves`), `cli/session-commands.ts` (`session*`, `now`, `news`, `morningEffects`),
`cli/stats-commands.ts` (`corrections`, `perf`, `readPerf`), `cli/lead-commands.ts` (`leadHold`, `leadPriority`).
- **Mesure** : `max-lines` 1 399 → ≈ 400 ; `max-lines-per-function` de `dispatch` 542 → ≈ 80 (table).
- **Protégé par** : 101 fichiers de test appellent `run()` de `cli.ts` ; c'est le plus protégé des trois.
- **Risque moyen** : l'ordre des `case` porte des priorités (options partagées) ; relire le `switch` pour ne pas perdre une garde commune.

### D. Doublons — gain faible à moyen, risque faible

| # | Doublon | Où | Mesure | Protégé par |
|---|---|---|---|---|
| D1 | `ollamaClassifier` / `ollamaSousClassifier` : même requête `/api/chat`, mêmes gardes, seuls le schéma, le prompt système et le parseur changent | `corrections.ts:323-339` ≈ `461-477` | jscpd −2 blocs, −22 l. ; −1 fonction à tester | `corrections.test.ts`, `sous-causes.test.ts` |
| D2 | `buildArgs` / `buildRetryArgs` : 9 lignes sur 11 identiques (agent, `--add-dir`, `--settings`, `--disallowedTools`, MCP) | `orchestrate/launch.ts:190-206` ≈ `261-281` | −10 l. ; ces deux listes d'arguments divergeraient en silence | `orchestrate-launch.test.ts` |
| D3 | Lecture d'un verrou : `readLockFile` / `read` | `state.ts:77-88` ≈ `orchestrate/lock.ts:28-39` | jscpd −1 bloc, −12 l. | `deliver-lock-faults.test.ts`, `deliver-rouge*.test.ts`, `hook-pre-push-vague.test.ts` |
| D4 | Choix de l'agent d'une étape recopié en chaîne de ternaires (jscpd ne le voit pas) | `orchestrate/command.ts:611` ≈ `orchestrate/cycle.ts:801` | −1 chaîne ; un nouvel agent oublié d'un côté fausse le `--dry-run` | `orchestrate-command.test.ts` (dry-run), `orchestrate-cycle.test.ts` |
| D5 | Même bloc de lecture d'une clé du `cadence.yaml` copié à 10 emplacements (relevés par jscpd à 5 lignes) | `config.ts:77,167,193,223,269,403,427,621,677,701` | jscpd −2 blocs, −18 l. ; `config.ts` `max-lines` 562 → ≈ 500 | `config.test.ts` et les tests de refus par clé |
| D6 | Bloc de lecture de `cadence.yaml` (existe → `parse` → « illisible ») | `orchestrate/continue.ts:33-40` ≈ 8 emplacements de `config.ts`, `lead.ts`, `resources.ts` | −1 bloc de 8 lignes par emplacement si une fonction commune est extraite | tests de config et de `lead` |

Pas de doublons : les 11 noms de tests en double (`R11 — worktree enregistré mais dossier disparu…`, `R25 — verrou libéré…`) testent
deux niveaux différents (unitaire `prepareTree` contre vague complète) ; ils ne sont pas à fusionner.

### E. Divers — gain faible, risque nul

- `test/vitest-config-clone-neuf.test.ts:3` importe `vite`, absent des `devDependencies` (knip : « unlisted ») : le déclarer
  (`npm i -D vite@<version>`) ou l'importer via `vitest/node`. Base knip −1.
- `knip.json` : `scripts/*.d.mts` dans `ignore` est inutile (indication de knip, « Remove from ignore »). **Décision du plan, livrée seule** :
  `scripts/qualite.mjs` refuse tout lot dont `knip.json` diffère de `main` (`docs/qualite.md` : « a lot judged by those thresholds cannot move them »).
  Ce point ne peut donc pas être rangé dans un lot de nettoyage.
- `test/orchestrate-registry.test.ts:304` (`R3 — un hold dont le TTL est échu…`) n'a aucun `expect` : il ne peut échouer que
  par dépassement de délai. Ajouter l'assertion sur le créneau rendu (test faible, pas vide).
- Directives : 2 `eslint-disable` (`state.ts`, `orchestrate/baseline.ts`) et 4 étiquettes knip dans `qualite-l462.test.ts`
  sont comptés par le cliquet ; à retirer en traitant A.

### Non retenu

- Options ou branches « sans effet » : chaque champ de `Args` (`orchestrate/command.ts:143-183`) est lu au moins une fois hors de sa
  déclaration (`untilAt` : `command.ts:1027`) ; les clés de `cadence.yaml` n'ont pas été passées en revue une à une. Aucune branche morte n'a été trouvée sans exécution du code : une recherche
  par couverture (`vitest --coverage`) reste à faire, c'est la seule façon de les voir (non mesuré ici).
- Tests vides ou redondants : aucun `skip`/`todo`/`only` inconditionnel ; 18 tests sans mot `expect` dans leur corps : 17 vérifient via un assistant
  (`refused(...)` dans `perf.test.ts`, `valide(...)` dans `ref-check.test.ts`), le dix-huitième est le R3 du registre (point E). `comptes-rendus-courts-l440` et `-l452` répètent
  une même section `R1` mais contrôlent chacun un texte différent du brief : à garder.
- Fonctions de plus de 80 lignes autres que celles de C (`session`, `work`, `briefFor`, `resume`, `execute`, `dispatch`) :
  les couper est un second temps, après C, avec la base `max-lines-per-function` (542 + 565 + 766 = 1 873 lignes) pour cible.

## Ordre proposé des lots

1. **A** (2 lots) puis **B** : base knip 153 → ≈ 3, sans risque.
2. **D1–D4** (un lot) ; **D5–D6** (un lot).
3. **C3** (cli.ts, le plus testé), puis **C2**, puis **C1** (3 lots, le plus gros gain : `max-lines` total −2 000).
4. **E**, sauf `knip.json` : au passage du premier lot qui touche le fichier concerné. Le retrait de `scripts/*.d.mts` de `knip.json` est une
   décision du plan, dans un lot à part qui ne change que ce fichier.

## Rejouer les mesures

```
node scripts/qualite.mjs                       # cliquet contre la base
npx knip --no-progress --reporter json         # exports et types non importés
npx jscpd src scripts bin --min-lines 8 --min-tokens 70 --reporters json
wc -l src/orchestrate/cycle.ts src/orchestrate/command.ts src/cli.ts
```
