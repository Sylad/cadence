# Du lot fini à la prod, et ce que valent nos tests (L835, D-33)

Étude de mesure seule, le 25-11-2026, au sha `2c4fc55d`. Aucun code, aucune CI, aucun test n'a changé : ce document est
le seul livrable. Demande de Sylvain (D-33) : « qu'est-ce qui ralentit, est-ce qu'on peut mutualiser des traitements CI,
banc de tests, etc. — l'idée est de ne pas ralentir les devs », précisée par « il manque la couverture de code par les
tests, et vérifier ce qu'ils font, ça me paraît énorme comme nombre de tests ».

Sources : les 575 états de run de `.cadence-run/*.json` (10 au 25-11), les journaux de livraison
`<projet>/.git/cadence/deliveries-steps.log` et `deliveries-failed.log`, le plan de cadence, et des mesures faites ce
jour (suite de cadence, couverture de 8 suites). `gh run list` était refusé dans la session : la durée de CI vient de
l'étape `ci` des livraisons (attente de la CI à partir du lancement de la livraison) et des notes du plan (L834, L256).

## Verdict

1. **Le temps ne part pas dans la CI ni dans le déploiement, mais dans les portes locales et les attentes.** Une
   livraison loisir prend 1 à 4 min (CI comprise) ; seule warhammer40k dépasse, à 10 min de médiane (15 min le 23-11).
   Entre la fin d'un run et le début de sa livraison, il passe **8 à 35 min de médiane, jusqu'à 3 h au 9ᵉ décile**.
2. **Les portes rouges ne trouvent presque jamais de défaut.** Sur les 54 corrections « porte rouge » de la période,
   **9 (17 %)** ont attrapé un vrai défaut ; **22 (41 %)** étaient des tests sensibles à la charge de la machine,
   **11 (20 %)** un environnement de porte incomplet, 11 une règle du dépôt ou une donnée de doc pas régénérée.
3. **La couverture est bonne, pas le manque.** cadence couvre 96 % de ses lignes (98 % de `src/`). Les trous sont
   ailleurs : maritime frontend 54 %, warhammer backend 58 %.
4. **Le nombre de tests de cadence vient des vagues.** 11 186 tests en 686 fichiers ; les tests d'`orchestrate`
   (les vagues, que cadence 2 a remplacées) en font 3 363 en 168 fichiers et **52 % du temps de la suite**. Les tests de
   texte de doc sont 5,6 % des tests et moins de 1 % du temps : ils coûtent en fausses alertes, pas en minutes.
5. **Ce qui rend la suite lente, ce sont les processus.** 380 fichiers lancent `git`, `node` ou un faux `claude` :
   84 % du temps. La suite a passé 42 min en temps système pour 52 min de calcul (11 min de mur sous une charge de 20 à 57).

## 1. Où part le temps entre la fin d'un lot et la prod

### Le run lui-même (travail + porte)

| projet | runs | durée med / p90 (min) | runs passés par « porte rouge » | coût médian |
|---|---:|---|---:|---:|
| cadence | 179 | 23 / 46 | 16 (20 passes) | 2,9 $ |
| maritime-atlas | 108 | 24 / 55 | 5 | 4,8 $ |
| warhammer40k | 69 | 18 / 55 | 1 | 2,5 $ |
| claude-code-codex | 58 | 25 / 59 | 8 | 2,1 $ |
| avatar-pandora | 43 | 26 / 79 | 6 | 2,5 $ |
| ol-companion | 34 | 11 / 23 | 2 | 2,9 $ |
| jobmail-assistant | 22 | 7 / 11 | 0 | 1,5 $ |
| expertise-gis | 21 | 5 / 11 | 3 | 2,3 $ |
| evatosorus | 18 | 20 / 41 | 4 | 2,1 $ |
| finance-tracker | 17 | 7 / 14 | 0 | 1,9 $ |

Durée = début du run → dernière écriture de son état (le journal ne date pas la fin de chaque passe : la part de la
porte dans un run n'est pas séparable). Passes jouées : 448 travaux, 51 corrections de porte rouge, 56 corrections après
revue, 14 résolutions de conflit au rebase, 17 reprises.

**Porte de cadence, mesurée ce jour** : `tsc` 12 s, `qualite.mjs --contre main` 28 s, `vitest run` **11 min 3 s**
(charge 20 au départ, 57 en cours, 32 cœurs). Le même passage avait pris 33 min (1 998 s) sous `CADENCE_TEST_WORKERS=4`
et une charge de 72 à 76 le 23-11 (run L808). Porte maritime : 21 étapes en 120 à 418 s (médiane 228 s sur 5 relevés).

### La livraison (CI, déploiement, contrôles)

D'après `deliveries-steps.log` (secondes, par livraison) :

| projet | livraisons | attente CI med / p90 | CI rouges | déploiement | contrôles | total med / p90 |
|---|---:|---|---:|---:|---|---|
| warhammer40k | 42 | 507 / 799 | 6 | 22 | 47 / 71 | **621 / 913** |
| finance-tracker | 13 | 118 / 133 | 0 | 24 | 39 / 58 | 191 / 214 |
| ol-companion | 26 | 128 / 142 | 0 | 20 | 39 / 81 | 185 / 234 |
| claude-code-codex | 37 | — | 0 | — | 52 / 71 | 52 / 71 |
| evatosorus | 15 | — | 0 | — | 53 / 67 | 53 / 67 |
| avatar-pandora | 27 | — | 0 | — | 44 / 56 | 44 / 56 |

Les sites Pages n'ont qu'une étape de contrôle. **maritime-atlas** et **cadence** ne laissent pas de journal d'étapes :
maritime livre par `aetherwx-livrer/livrer.sh` (seul `deliveries.log` les date au jour), cadence publie par
`cadence release` (banc mécanique ~25 min par version, CI 55 → 30 min depuis L834, dont Node 24 à 30 min contre 19 min
pour Node 22).

**warhammer40k se dégrade** : attente de CI de 5 min le 14-11 à 12–15 min les 23 et 24-11 (897 et 987 s), 6 CI rouges
dont deux annulées et au moins une sans test rouge (délai de l'e2e dépassé, L256). Sa suite frontend a pris 7 min 37 s
ce jour : elle mêle aux tests unitaires des tests « navigateur, dist » de 1 à 12 s chacun.

### L'attente du lead (fin du run → début de la livraison)

| projet | med (min) | p90 (min) | n |
|---|---:|---:|---:|
| finance-tracker | 8 | 17 | 17 |
| ol-companion | 11 | 46 | 25 |
| warhammer40k | 14 | 103 | 63 |
| evatosorus | 16 | 47 | 12 |
| claude-code-codex | 17 | 181 | 53 |
| avatar-pandora | 35 | 150 | 33 |

Ce délai couvre la revue de code, le verdict UX et la file du lead. C'est **le plus gros poste après la porte** : à
lui seul il dépasse 10 fois la livraison sur les sites Pages.

### Acquis déjà mesurés (rappel)

CI de cadence 55 → 30 min (L834, un run par rafale, la suite une fois par Node) ; CI warhammer : délai de l'e2e mis à
la mesure (L256) — la durée n'a pas baissé ; pids.max : 5 échecs de la porte de L826 venaient du plafond de processus du
groupe de contrôle, pas du lot.

## 2. Couverture de code

Mesurée avec l'outil de chaque pile, rapports hors des dépôts (scratchpad), paquet de couverture installé sans
`--save` puis retiré (`npm prune`, `npm ci` pour warhammer backend) ; aucun `git status` modifié.

| suite | outil | tests | lignes | branches | fonctions |
|---|---|---:|---:|---:|---:|
| cadence (`src/`, `v2/src/`, `scripts/`) | vitest + v8 | 11 186 | **96,1 %** | 93,8 % | 97,6 % |
| ol-companion backend | jest | 656 | 91,8 % | 78,8 % | 85,4 % |
| ol-companion frontend | vitest + v8 | 1 528 | 89,8 % | 83,8 % | 90,2 % |
| warhammer40k frontend | vitest + v8 | 2 222 | 87,0 % | 89,7 % | 83,6 % |
| finance-tracker frontend | vitest + v8 | 1 000 | 83,7 % | 85,8 % | 65,7 % |
| maritime-atlas api | jest | 2 726 (+428 sautés) | 80,5 % | 70,6 % | 73,3 % |
| finance-tracker backend | jest | 1 328 | 78,7 % | 64,0 % | 75,0 % |
| jobmail-assistant | pytest-cov | — | 76 % | — | — |
| warhammer40k backend | vitest + v8 | 186 | **57,7 %** | 41,1 % | 47,7 % |
| maritime-atlas frontend | vitest + v8 | 4 508 | **54,3 %** | 53,9 % | 50,6 % |

Détail cadence : `src/*.ts` 98,2 %, `src/orchestrate` 97,4 %, `v2/src` 97,8 %, `src/ref` 97,0 %, `src/cli` 95,7 %,
`scripts` 86,3 %. Les plus bas : `scripts/sondes-page.mjs` 35 %, `v2/src/trace.ts` 40 %, `src/ref/corpus-render.ts`
29 %. La mesure ne voit que le code chargé dans le processus de test : les tests qui lancent `bin/cadence.js` exécutent
`dist/`, non compté — la couverture réelle est un peu plus haute.

Non mesurés : les services Python et les plugins Java de maritime ; maritime api compte 53 suites `*.db.spec.ts` sautées
sans base ; les sites Astro et claude-code-codex testent le site construit (`dist/`), où une couverture de source n'a pas
de sens ; expertise-gis (docs), fonds-ecran (.NET absent de Big-Blue).

## 3. Ce que font les tests de cadence

**Population** : 686 fichiers (624 sous `test/`, 62 sous `v2/`), 11 186 tests. Le chiffre de « 298 fichiers qui lisent
docs/CHANGELOG/README/yaml » mélange des tests qui écrivent ces fichiers dans un dépôt jetable pour tester le code :
à la règle « lit un document du dépôt et n'importe aucun code », il reste **31 fichiers** (63 s sur 7 865 s de calcul).

**Échantillon** : 60 fichiers tirés au hasard (`random.seed(835)`), lus un par un (titres des tests, imports, fichiers lus).

| classe | fichiers | part | dont `orchestrate` |
|---|---:|---:|---:|
| comportement (le test fait tourner le code et regarde son effet) | 51 | 85 % | 17 |
| texte de doc (la page dit X, les liens existent) | 4 | 7 % | 2 |
| configuration (package.json, budgets de modules, fiches du dépôt) | 4 | 7 % | 0 |
| doublon net d'un autre fichier | 1 | 2 % | 1 |

Texte de doc : `orchestrate-pages-l599`, `etat-et-portes-l602-bord`, `demarrage-lead`, `orchestrate-contexte-doc-l398`.
Configuration : `docs-publiees-l626`, `probe-l576-fiches-anterieures`, `etape-spec-fiche`, `v2/budget`. Doublon :
`orchestrate-command-modules-l489` rejoue les analyseurs déjà testés par `orchestrate-command` (`parseBudget` mot pour
mot). Plusieurs fichiers de comportement finissent par un « R4 — la doc et le CHANGELOG décrivent… » (`version-et-dossier-l376`).

**Sur toute la population**, test par test (un bloc `it` qui lit un document sans lancer de code) : 566 tests sur
10 153, **5,6 %**. Doublons littéraux : 5,9 % des lignes `expect(…)` de plus de 40 caractères se retrouvent dans
deux fichiers ou plus — le doublon de cadence est de scénario (un même chemin de vague rejoué avec une variante), pas
de copie.

**Où va le temps** (`vitest --reporter=json`, somme par fichier) : `orchestrate-*` 4 123 s (52 %) ; `v2/` 381 s (5 %)
pour 1 091 tests ; les 100 fichiers les plus lents font 73 % du temps. Les dix premiers sont tous des tests de vague
(`orchestrate-worktree-integration` 300 s, `orchestrate-cycle` 295 s, `orchestrate-command` 199 s…). Le produit vivant
(`cadence run`, `v2/`) est donc le moins coûteux à tester ; c'est le code que [retrait-vagues.md](retrait-vagues.md)
propose de retirer qui fait la moitié de chaque porte et de chaque CI.

## 4. Les tests qui ont servi

Les 54 corrections « porte rouge » des runs du 10 au 25-11 (tous projets), classées d'après le diagnostic de la session
de correction (rejeu seul, charge mesurée, cause trouvée) :

| cause du rouge | n | part | exemples |
|---|---:|---:|---|
| **vrai défaut attrapé** | 9 | 17 % | course dans l'enveloppe de session (L760, `bras.ts`) ; `fin()` qui écrit l'état avant le journal (L778) ; `writeFileSync` concurrent sur l'état d'un run (L807) ; règle de publication contredite (L730) ; course de la sonde à la fermeture (L784) ; régressions de rendu et de perf (avatar L32 ×2, L34) ; backticks dans une page (codex L93) |
| test sensible à la charge (minuterie, délai, ordre) | 22 | 41 % | cadence ×13, maritime ×5 (`caches-probe`, `geoserver-ops`, `auth.security`, `catalog-page.anchor`, `chart-wheel-zoom`), codex ×3 (PageHero 594–689 s), warhammer ×1 |
| environnement de porte incomplet | 11 | 20 % | Node 22.22 contre Astro 7 (avatar, codex, evatosorus) ; `dist/` absent ; chemin `developpeur-gitops` faux depuis un worktree ; `.termes-prives` absent ; SDK .NET absent ; pids.max |
| règle du dépôt (budget de module, cliquet, adoption d'analyse, titre public du plan, registre) | 6 | 11 % | L769, L808, evatosorus L54 ×2, ol L256, expertise L13 |
| doc ou donnée de doc pas régénérée | 5 | 9 % | JSON Nouveautés non régénéré (codex ×2, evatosorus), guillemets sans espace fine, phrase de doc prise pour un lecteur par `raf migrate` |
| inachevé | 1 | 2 % | L765 |

Chaque correction est une session Opus de plus. Pour une sur six, elle a servi ; pour les autres, elle a payé
l'instabilité des tests ou de la machine. Les CI rouges de warhammer (6) sont de la même famille : délai dépassé ou
annulation, aucune n'a été tracée jusqu'à un défaut (logs CI non lus, `gh` refusé).

## 5. Lots proposés (non créés)

Classés par gain attendu. Chaque mesure se lit dans les mêmes journaux que cette étude.

| # | lot proposé | gain estimé | mesure de succès |
|---|---|---|---|
| P1 | **Retrait des tests et du code des vagues** ([retrait-vagues.md](retrait-vagues.md) : 73 fichiers de `src/orchestrate` partent entiers) après l'accord du compte pro sur #50 | suite de cadence −50 % (11 → ~5 min sous charge), CI Node 24 30 → ~15 min, −3 363 tests | durée de `vitest run` et du job CI le plus long ; nombre de tests |
| P2 | **Porte par tests touchés pendant le run**, suite complète à la seule porte de livraison (déjà au plan : L838, à démarrer) | porte de run de cadence de 10–30 min à < 2 min ; mêmes ordres pour maritime et warhammer | minutes de porte par run (médiane) ; aucun défaut attrapé à la livraison qui l'aurait été en run |
| P3 | **Rejeu seul d'un rouge avant la correction, dans `cadence run` pour tous les projets** (cadence l'a pour lui-même : `testReplay`, L354) | 22 passes sur 54 évitées (~41 %), soit une session Opus chacune | part des passes « porte rouge » sans commit de code |
| P4 | **Garde contre les tests à l'horloge murale** : le cliquet d'analyse refuse un `performance.now()`/`Date.now()` comparé à une borne absolue dans un test neuf ; lot de reprise des 13 tests cadence et 5 maritime cités | tarit la source de P3 au lieu de la rejouer | rouges « charge » par semaine → 0 |
| P5 | **Préflight d'environnement de porte** : version de Node lue dans `engines`/`.nvmrc`, `build` avant `test` quand les tests lisent `dist/`, outils de la pile présents, fichiers privés résolus depuis le clone principal | 11 rouges sur 54 (20 %) | 0 rouge d'environnement sur deux semaines |
| P6 | **Données générées dans la porte** : les JSON Nouveautés (codex, evatosorus, avatar) régénérés par la commande `build`, pas à la main | 3 rouges, et l'oubli qui les cause | 0 rouge « JSON Nouveautés » |
| P7 | **CI warhammer : tests navigateur à part** (projet vitest séparé ou job parallèle) et budget de durée tenu par un test | attente de CI 12–15 → ≤ 7 min par livraison (42 en 10 jours) | étape `ci` des livraisons, médiane |
| P8 | **Délai lead → livraison** : livrer ensemble les lots prêts d'un même dépôt (une CI) et compter ce délai dans le tour du lead | p90 de 1,7–3 h ramené sous 45 min | délai fin de run → début de livraison, p90 par projet |
| P9 | **Relevé de couverture hebdomadaire** dans `scripts/releve-qualite.py` (pas dans la porte), cliquet par projet seulement là où elle est basse : maritime frontend, warhammer backend (rejoint L838) | couverture visible sans coût de porte | couverture qui ne baisse pas d'une semaine à l'autre ; +10 points sur les deux suites basses en un mois |
| P10 | **Journal d'étapes pour maritime** (`livrer.sh` écrit `deliveries-steps.log` comme `cadence deliver`) | rend maritime mesurable : le plus gros projet est aveugle ici | livraisons maritime chronométrées dans le journal |
| P11 | **Job Node 24 de cadence** : comprendre les 11 min d'écart avec Node 22 ; à défaut, le jouer seulement à la publication | −11 min de mur par push | durée du run CI |
| P12 | **Tests de texte de doc** : un contrôleur unique (liens, ancres, bornes) remplace les « la page dit X » liés à un lot passé, à la sortie de ce lot | peu de minutes (< 1 % du temps), moins de fausses alertes (L801, codex L83) | rouges « doc » par mois |

Ne pas faire : une couverture mesurée à chaque porte (le paquet v8 n'apporte rien au lot et rallonge la suite), un
seuil global de couverture pour cadence (96 % : le seuil ne dirait rien), une chasse aux doublons littéraux (5,9 %).

## Mesures à rejouer

- Runs : pour chaque `.cadence-run/*.json` hors `en-cours`, durée = mtime du fichier − `debut` ; passes `porte` dans
  `passes[].quoi` ; corrections dans `corrections[]` (`rouge`, `message`).
- Livraisons : `<projet>/.git/cadence/deliveries-steps.log`, groupé par `sha`, sommes par `etape` (`ci`,
  `deploiement n/n`, `verification n/n`) ; attente du lead = premier `debut` d'une livraison qui cite le lot − fin du run.
- Suite de cadence : `npx vitest run --reporter=json --outputFile=<f>` (durées par fichier) ; couverture :
  `npm i --no-save @vitest/coverage-v8@2.1.9` puis `npx vitest run --coverage.enabled --coverage.reporter=json-summary
  --coverage.reportsDirectory=<hors dépôt> --coverage.include='src/**' --coverage.include='v2/src/**'
  --coverage.include='scripts/**' --coverage.all`.
- Autres projets : `npx jest --coverage --coverageDirectory=<hors dépôt>` (backends), vitest comme ci-dessus avec la
  version de vitest du projet, `pytest --cov=jobmail` ; puis `npm prune` (ou `npm ci`) et `git status` vide.
- Échantillon : `random.seed(835); random.sample(sorted(glob('test/*.test.ts') + glob('v2/**/*.test.ts')), 60)`.
