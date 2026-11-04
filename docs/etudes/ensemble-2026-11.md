# Étude d'ensemble de cadence — novembre 2026 (L594)

Lecture seule, par un relecteur neuf (Claude Fable 5.1), au sha `f28ba350` (1.53.1 + `[Unreleased]`), le 04-11-2026.
Rien n'a été changé dans le paquet, les gabarits, les agents ni les tests : ce document est le seul livrable.
Question de Sylvain : « construit lot après lot sans plan global, notre tas de briques fait-il un joli palais ? »

Ce que [l'audit L461](../mesures/audit-simplification-l461.md) a déjà couvert (code mort, doublons, gros fichiers,
cliquet de qualité) n'est pas refait ici ; l'étude regarde **l'ensemble** : les concepts, leurs couches, les
recouvrements, les noms, la surface vue par un nouvel utilisateur (le compte pro), les chemins morts et les règles qui
se contredisent entre docs et code. Chaque écart se termine par une correction proposée en lot ≤ 0,5 j.
Le rituel L595 (tous les 14 jours) comparera la prochaine étude à celle-ci : la section [Mesures](#mesures-à-rejouer)
donne les commandes qui ont produit les chiffres.

## Verdict

**Le fond est cohérent, la surface ne l'est pas encore.** Un seul modèle mental tient tout l'édifice et il est
le même partout : *un plan relié aux commits, des sessions neuves enchaînées par un programme, une preuve (porte,
revue, effet) avant chaque passage d'état*. Aucune brique ne contredit ce modèle ; les quelques recouvrements trouvés
sont des **doublons de calcul ou de nom**, pas des doublons de mécanisme. Le palais a de bons murs porteurs.

Ce qui manque, ce sont les couloirs : un nouvel arrivant rencontre **trois noms pour « petit lot »**, **quatre sens
du mot « hook »**, **deux sens de « prêt »**, **deux textes d'aide qui ne disent pas la même chose**, **deux formules
pour les créneaux libres**, **quatre dossiers d'état** dont deux racines utilisateur, une page `orchestrate.md` de
308 Ko dont 106 lignes dépassent 600 caractères, et une documentation en anglais pour une CLI, des clés et des noms de
fichiers en français (`maquette`, `fiche`, `acceptation.json`, `docs/nouveautes/`). Aucun de ces écarts n'est un bug
de fond ; ensemble ils expliquent les trois symptômes du 04-11 (L589, L591, L592 : trois affichages du même nombre
qui divergent) et le coût d'entrée d'un lecteur neuf.

Les 16 écarts ci-dessous se corrigent en **13 lots ≤ 0,5 j**, dont 8 ne touchent que la documentation (risque nul) et
aucun ne casse une garantie de [stabilite.md](../stabilite.md). Les trois de plus fort gain : un seul calcul des
créneaux libres lu par tous (E1), une seule source pour l'aide (E2), le découpage de `orchestrate.md` (E12).

## Carte des concepts et de leurs couches

Chaque notion vit dans une **couche** (où son état est écrit), est manipulée par des **commandes**, et a une **page**.
Les couches, du dépôt vers la machine :

| Couche | Où l'état est écrit | Versionné ? | Lu par |
|---|---|---|---|
| **A. Plan** | `.cadence/raf.yaml` (ou `plan:` de `cadence.yaml`, ou `docs/plan/raf.yaml` hérité), `.cadence/archive/<année>.yaml`, `.cadence/notes/`, `.cadence/docs-ok.yaml` | oui | `raf`, `session`, `news`, `deliver`, `lead tour`, la bande |
| **B. Configuration** | `cadence.yaml` du projet (`plan`, `news`, `hook`, `session`, `deliver`, `verify`, `orchestrate`, `docs`, `qa`, `references`, `migrate`, `repos`) ; `cadence.yaml` du dossier parent (`lead`, `priority`, `resources`, `depth`, `perf`) | oui | tout |
| **C. Vague** | `<dossier de lancement>/.cadence/runs/<vague>/` : état par lot (`<projet>--<lot>.json`), journal, briefs, rapports ; `.cadence/corrections.json` | non (`.git/info/exclude`) | `orchestrate --status`, `perf`, `corrections`, `--waits`, la bande |
| **D. Registre machine** | `~/.cadence/orchestrate/` (`CADENCE_HOME`) : `waves/`, `slots/`, `holds/`, `hud-context/`, `worktrees/` | hors dépôt | `orchestrate`, `lead tour`, `lead hold`, la bande |
| **E. Données utilisateur** | `~/.local/share/cadence/` : copies en service (`npm run service`) ; `$XDG_DATA_HOME/cadence/references/` : documents `ref add` | hors dépôt | `cadence` du `PATH`, `ref` |
| **F. Dépôt git** | commits (`feat(L12): …`), hooks `pre-commit`/`post-commit`/`pre-push`, branches `cadence/<vague>/<projet>--<lot>`, `wip/cadence-<lot>` | oui | `raf check`, `commits`, `deliver --sha`, l'intégration |

Les notions, par couche :

| Notion | Couche | Mots du code / du plan | Commandes | Page |
|---|---|---|---|---|
| **lot** | A | `id`, `title`, `status` (todo/doing/done/dropped), `estimate`, `after`, `tasks`, `notes` ; drapeaux `visible`, `screen`, `spec`, `quickwin`, `local`, `every`, `uses`, `planned`, `public`, `goal`, `repos`, `parent`, `gate` ; verdicts `review`, `ux` ; `delivered`, `docsOk`, `state`, `extras` | `raf add/start/done/drop/todo/title/note/move/…` (une vingtaine de sous-commandes qui écrivent un lot, sur 34) | [raf.md](../raf.md) |
| **plan natif / plan lu** | A + B | `PlanSettings.format` (plan d'un autre outil, lecture seule), `plan.states`, `plan.extras`, `plan.idPattern`, `plan.commit`, `plan.onWrite`, `plan.files` | `raf import --from-config / --to-config`, `raf migrate` | raf.md « A plan elsewhere » |
| **porte** (gate) | B + C | `orchestrate.test`, `build`, `testReplay`, `testGate`, `gate.readsPlan/host/install`, `verify.inPlace` ; dans le plan : `uxSince`, `reviewSince` (`raf ux enable`, `raf review enable`) ; `docs.sync` | `cadence verify --gate`, `local done`, la vague | [orchestrate.md](../orchestrate.md), [remote-gate.md](../remote-gate.md), [deliver.md](../deliver.md) |
| **revue** | A + C | `review:` et `ux:` du lot (verdict, date, commit, `reporte`) ; `LotState.verdict`, `uxVerdict` ; passes `review`, `review-small`, `ux`, `fix` ; agents `code-reviewer`, `ux-reviewer`, `qa-reviewer` | `raf review`, `raf ux`, la vague | [news.md](../news.md) §UX/Code review, orchestrate.md |
| **spec** (fiche) | A + C + dépôt | `spec: true`, `screen: page`, `docs/specs/<écran>/fiche.yaml`, `acceptation-<lot>.json` (scellé), `orchestrate.spec/maquette/maquetteReviews/fiche/accept` ; agents `spec-writer`, `acceptance-writer` | `cadence spec check/qa/reseal/green`, `raf spec on/off` | [spec.md](../spec.md), orchestrate.md « spec step » |
| **vague** | C + D | `WaveStatus` (running/suspended-budget/suspended-quota/done/interrupted), `LotStatus` (queued/implementing/reviewing/fixing/question/ready/handed-back/failed/suspended), budget, `--continue`, `--no-fill`, worktree, intégration | `cadence orchestrate …`, `--status`, `--resume`, `--integrate`, `--replay`, `--remove-worktree`, `--waits` | orchestrate.md |
| **créneau / hold** | D | `slots/slot-<n>.lock`, `holds/<label>.json`, `commonCap`, `freeSlots` | `--max-sessions`, `CADENCE_MAX_SESSIONS`, `cadence lead hold/release` | [lead.md](../lead.md), [concepts.md](../concepts.md) |
| **lead** | B + D + skill | `lead.ux`, `lead.contextThreshold`, `priority`, `resources`, `depth` ; skill `lead` ; agent `livreur` ; hook Claude Code `claude-hook retour|attente|pipe` | `cadence lead tour/priority/hold/release`, `cadence local start/done/abort`, `cadence config set --all` | lead.md, [skills.md](../skills.md) |
| **livraison** | A + F + journal | `delivered: { date, sha }`, `plan.deliveredState`, `deliveries.log`, livraison rouge, « livrable jusqu'à `<sha>` », `deliver.blocks`, `deliver.script` | `cadence deliver`, `verify`, `verify --gate`, hook `pre-push` | deliver.md |
| **news** | A + dépôt | `docs/nouveautes/*.json` + captures, `public:`, `nocapture`, `news.publicTitleMax` | `raf news new/list/check/stamp/build` (= `cadence news`) | news.md |
| **docs qui suivent le code** | B + A | `docs.sync`, `docs.since`, `docs.articles`, `docs_ok` du lot, `.cadence/docs-ok.yaml` ; agent `doc-keeper` | `raf docs-ok`, `raf check`, la vague | news.md « Documentation that follows the code » |
| **ref** | E + dépôt | `references.dir`, `inventaire.json`, `lectures/a.json`, agents `reference-analyst/-planner/-verifier` | `cadence ref add/measure/check/eval/diff/analyse/coverage/corpus` | [ref.md](../ref.md) |
| **perf / corrections** | C (lecture) | `perf.prices`, `perf.currency` ; classes `bug-code`… ; `.cadence/corrections.json` | `cadence perf`, `cadence corrections`, `orchestrate --waits` | [perf.md](../perf.md), [corrections.md](../corrections.md) |
| **bande** (hud) | D + C (lecture) | plugin `cadence-hud` (version propre 0.7.0), `hud-context/<session>.json`, `/hud lots` | `cadence session context` | [cadence-hud.md](../cadence-hud.md) |
| **service / release** | E + F | `npm run service -- <sha>`, `cadence release patch|minor|major`, `qualite-baseline.json` (cliquet) | `cadence release`, `npm run qualite` | [fonctionnement.md](../fonctionnement.md) §4, [releasing.md](../releasing.md), [qualite.md](../qualite.md) |

Lecture de la carte : **le plan (A) est bien la seule source de vérité** pour ce qu'un lot *est* ; la vague (C) ne
garde que ce qu'un lot *fait en ce moment* ; le registre (D) ne garde que ce que *la machine* porte. Cette séparation
est respectée dans le code (le programme seul écrit le plan depuis un worktree, L279/L456). Les frottements viennent
des **lectures croisées** : la bande relit C et D et recalcule ce que `orchestrate --status` sait déjà (E1) ; `perf`,
`corrections` et `--waits` relisent les mêmes journaux chacun avec son analyseur (E15).

## Architecture cible, en une page

Ce que l'ensemble devrait être pour qu'un lecteur neuf le tienne en tête, sans rien casser de ce qui est garanti :

1. **Un plan, un fichier, une classe par rôle.** `.cadence/raf.yaml` reste la source de vérité. Dans le code,
   `Plan` (écriture native) et un `ForeignPlan` (lecture d'un autre format, lecture seule) partagent une interface de
   lecture ; `plan.ts` ne contient plus de branche `if (settings.format)` (E5).
2. **Une configuration, deux niveaux, une page.** `cadence.yaml` du projet (ce que le projet *est* : plan, portes,
   livraison, docs) et `cadence.yaml` du parent (ce que le lead *décide* : priorité, ressources, UX déléguée).
   Chaque clé est lue par le module de la notion qu'elle règle (`perf-config.ts` et `gate-config.ts` le font déjà ;
   `config.ts` garde plan, news, hook, session, orchestrate, verify, docs, references — E17). Une page `docs/config.md`
   liste **toutes** les clés, en un tableau, avec leur défaut et leur page de détail (E6, E14).
3. **Une vague, un état, un chiffre par fait.** Chaque nombre affiché (créneaux libres, lots prêts, budget restant)
   est calculé **une fois**, par le programme, et **publié** (sortie `--json` de `orchestrate --status`, ou fichier du
   registre) ; la bande, `lead tour` et le skill `lead` le **lisent**, ne le recalculent jamais (E1).
4. **Une échelle de taille de lot, nommée.** `express` (≤ 0,1 j), `léger` (≤ `review.threshold`, 0,25 j), `petit`
   (≤ 0,5 j ou `quickwin`), `plein`. Les quatre mots dans `concepts.md`, les quatre seuils dans un seul module (E4).
5. **Un vocabulaire, une langue par face.** La **documentation est en anglais**, la **CLI, les clés et les messages
   sont en français** : c'est un choix, il est écrit dans `stabilite.md` et dans `concepts.md`, et aucun alias
   anglais n'est ajouté (deux noms pour une clé serait un recouvrement de plus) (E9). Un mot, un sens : « hook » est
   toujours qualifié (hook git, hook Claude Code, `plan.onWrite`), « prêt » ne désigne que l'état de vague `ready`,
   le lot du plan sans dépendance ouverte est « tirable » (E7, E8).
6. **Une aide, une source.** `bin/cadence.js` imprime l'aide que `src/cli.ts` tient ; les deux textes ne divergent
   plus (E2, E3).
7. **Une documentation par couche, des pages courtes.** `concepts.md` (les notions, ≤ 15 Ko) → `fonctionnement.md`
   (la mécanique) → une page par couche (`raf`, `orchestrate` découpée en 4 pages, `deliver`, `lead`, `spec`, `ref`,
   `perf`, `config`) → les `docs/mesures/` et `docs/specs/` comme archives datées. `overview.md` ne porte plus de
   chiffres (« four tools ») qui vieillissent (E11, E12, E13).

Rien dans cette cible ne renomme une commande, une option ou une clé garantie : tout se fait en mineur.

## Écarts classés par gain et risque

Classement : gain décroissant, puis risque croissant à gain égal. **Gain** : ce que gagne un lecteur neuf ou le lead
(moins de divergences, moins de pages, moins de mots). **Risque** : ce que la correction peut casser (nul = docs
seules ; faible = code interne couvert par des tests ; moyen = un chemin ou un défaut change).
Chaque écart donne la **preuve** (ce qui a été lu ou mesuré, rejouable dans [Mesures](#mesures-à-rejouer)) et le **lot
proposé** (≤ 0,5 j).

| # | Écart | Gain | Risque | Lot |
|---|---|---|---|---|
| E1 | Créneaux libres : deux formules (registre, bande) et un troisième « free » interne à la vague | fort | faible | 0,5 j code |
| E2 | Deux textes d'aide tenus à la main, qui divergent sur 9 commandes | fort | faible | 0,25 j code |
| E12 | `orchestrate.md` : 308 Ko, 106 lignes > 600 car., pas de sommaire | fort | nul | 0,5 j docs |
| E4 | Trois seuils de « petit lot » sous trois noms (`express`, `light`, `small`) + `quickwin` | fort | nul (docs) / faible (code) | 0,25 j docs + 0,25 j code |
| E5 | Plan natif et plan lu dans la même classe : 13 branches `settings.format` dans `plan.ts` | moyen | faible | 0,5 j code |
| E6 | Quatre dossiers d'état, deux racines utilisateur (`~/.cadence`, `~/.local/share/cadence`) ; aucune page ne les liste | moyen | nul | 0,25 j docs |
| E7 | « hook » désigne quatre choses | moyen | nul | 0,25 j docs |
| E8 | « prêt / ready » et « done » ont deux sens chacun | moyen | nul (docs) / faible (code) | 0,25 j docs |
| E9 | Docs en anglais, CLI/clés/fichiers en français, clés mélangées (`maquette`, `fiche` / `precheck`, `probe`) ; convention jamais écrite | moyen | nul | 0,25 j docs |
| E11 | `overview.md` et `stabilite.md` : « four tools », « four skills », « three reviewer agents » : 15 outils, 5 skills, 11 agents | moyen | nul | 0,25 j docs |
| E14 | Les portes se déclarent à trois endroits (plan, `cadence.yaml`, vague) ; aucun tableau ne les réunit | moyen | nul | avec E6 |
| E3 | `cadence spec green` : documenté, implémenté, absent des deux aides | faible | nul | avec E2 |
| E10 | `docs-ok` / `docs_ok` / `docsOk` : trois graphies d'une même notion | faible | nul | avec E7 |
| E13 | Deux documentations de la bande (README du plugin en FR, `docs/cadence-hud.md` en EN), un test ne compare que « ... » | faible | nul | 0,25 j docs |
| E15 | Trois lecteurs des journaux `.cadence/runs` (`perf`, `corrections`, `--waits`) | faible | moyen | à surveiller, pas de lot |
| E17 | `config.ts` (584 l.) lit 8 familles de clés, deux autres ont leur module | faible | faible | 0,5 j code, après E6 |

### E1. Créneaux libres : deux formules et un troisième « free »

**Preuve.** La note du lead disait trois endroits ; c'est vérifié, avec une nuance.

- `src/orchestrate/registry.ts:83` — `freeSlots(waves, total, leadSessions)` : plafond commun à toutes les vagues
  (`commonCap`, L395), puis pour chaque vague `min(plafond, w.lanes ?? w.repos.length)` : en mode worktree une vague
  compte **un créneau par lot actif** (`lanes`).
- `plugins/cadence-hud/hooks/format.ts:464` — `freeSlots(waves, cap, leadSessions)` : `min(w.cap ?? cap, w.repos ?? 0)`
  par vague vivante, **sans** `commonCap` ni `lanes` : en mode worktree la bande compte un créneau par **dépôt**.
  C'est exactement le constat de L589 (ouvert, même vague).
- `src/orchestrate/pool.ts:45` — `take(canRun, free)` : `free` est le nombre de créneaux **dans la vague** qu'aucune file
  ne tient (L527). Ce n'est pas la même grandeur (créneaux de la vague, pas de la machine) ; le mot est le même.

`lead tour` et `orchestrate --status` passent tous deux par `slotsLine` (`src/orchestrate/status.ts:42`) : là, une
seule formule. Le doublon est **registre ↔ bande**. L591 (un lot en attente d'intégration rend son créneau) change
encore la définition côté registre : la bande divergera de nouveau tant qu'elle recalcule.

**Lot proposé (0,5 j, code, risque faible).** La bande **lit** le nombre, elle ne le calcule plus : `orchestrate
--status --json` (ou un fichier `~/.cadence/orchestrate/slots.json` écrit par le registre à chaque changement) publie
`{ cap, free, held: [...], lanes: [...] }` ; `format.ts` supprime `freeSlots` et affiche ce qu'il lit ; un test de
contrat compare la sortie de `slotsLine` et le segment de la bande sur le même registre. `pool.ts` renomme son `free`
en `vacantLanes` (créneaux de la vague) pour que le mot cesse de faire croire au même nombre. À faire **après** L589 et
L591, qui changent la formule : sinon le même chiffre est corrigé deux fois.

### E2. Deux textes d'aide tenus à la main

**Preuve.** `bin/cadence.js` imprime son propre texte quand `cadence` est appelé sans outil ; `src/cli.ts` tient
`HELP` (`raf --help`, qui liste aussi les commandes `cadence`). Comparés sous-commande par sous-commande :

| Dans `cli.ts` HELP, absent de `bin/cadence.js` | Dans `bin/cadence.js`, faux ou vieilli |
|---|---|
| `cadence lead priority` (L449) | `cadence local start\|done` : `abort` manque |
| `cadence verify --gate` (L348) | `cadence claude-hook retour\|attente` : `pipe` manque (`hooks/hooks.json` l'appelle) |
| `cadence ref check`, `eval`, `diff`, `analyse`, `coverage`, `corpus` | `cadence skills install` : « session-start, session-close, deliver et l'agent ux-reviewer » — le code copie **tous** les dossiers `skills/` (5) et `agents/` (11) |
| `cadence orchestrate … --goal`, `--no-fill` (L587, 04-11) | `cadence orchestrate` : `--waits` est là, `--no-fill` non |

Et dans les deux à la fois : `cadence spec green` (E3) manque ; `cadence session`, `deliver`, `spec check|qa|reseal`,
`skills`, `claude-hook` ne sont que dans `bin`. Deux sources, aucun test ne les compare.

**Lot proposé (0,25 j, code, risque faible).** `bin/cadence.js` délègue : `run(['help'], io)` (ou `--help`), et
`cli.ts` tient une seule aide, structurée par outil (`raf`, `cadence <outil>`), avec `cadence <outil> --help` qui
n'imprime que la section de l'outil. Un test lit l'aide et vérifie que chaque sous-commande de la table de dispatch
(`BEFORE_PLAN`, les tables suivantes) y figure une fois. `docs/stabilite.md` ne garantit pas le texte des sorties :
pas de rupture.

### E3. `cadence spec green` : documenté, implémenté, invisible

**Preuve.** `docs/spec.md` et `docs/fonctionnement.md` (« Permanent rules ») le décrivent ; `src/cli/spec-commands.ts:24`
l'implémente (`openWavesRefusal(…, 'spec green')`) ; `grep -c "spec green"` dans `src/cli.ts` et `bin/cadence.js`
rend 0. **Lot :** avec E2.

### E4. Trois seuils de « petit lot », trois noms, plus `quickwin`

**Preuve.** Le code porte trois drapeaux calculés sur l'`estimate` :

| Drapeau | Seuil | Où | Effet |
|---|---|---|---|
| `express` | ≤ 0,1 j (`EXPRESS_MAX_ESTIMATE`, `src/orchestrate/express.ts`) | `preflight.ts` | une seule session, pas de précheck, sonde ni revue séparée (L519) |
| `light` | ≤ `orchestrate.review.threshold` (0,25 j par défaut, `config.ts:334`) | `preflight.ts`, `cycle/session.ts:33`, `review.ts:223` | modèle léger (Sonnet) à la revue, mineurs en notes (L108) |
| `small` | ≤ 0,5 j **ou** `quickwin` | `preflight.ts:167`, `review.ts:53` | une seule passe `review-small` code + ergonomie, pas d'UX séparée |

À quoi s'ajoute `quickwin` (drapeau du plan, `⚡`, `raf quickwins` liste « estimate ≤ 0,25 j ou ⚡ ») : un quatrième
critère de « petit », saisi à la main, qui recoupe `estimate`. Les docs disent chacune une partie : `concepts.md:51`
(« half a day or less get a single review pass » = `small`), `fonctionnement.md:46` (« Sonnet for a lot of 0.25 day or
less » = `light`), `orchestrate.md` « Express lane » (= `express`). Toutes vraies, aucune ne donne l'échelle.

**Lots proposés.** (a) 0,25 j docs, risque nul : un paragraphe « La taille d'un lot » dans `concepts.md` avec le tableau
ci-dessus et les quatre mots (`express`, `léger`, `petit`, `plein`), repris dans le glossaire ; `quickwin` y est
présenté comme « petit, dit à la main ». (b) 0,25 j code, risque faible : les trois seuils dans un seul module
(`src/orchestrate/lot-size.ts` : `sizeOf(lot, config) → 'express' | 'light' | 'small' | 'full'`), `preflight.ts` et
`review.ts` le lisent ; les trois booléens de `LotState` restent (journaux des vagues, pas garantis mais lus par la
bande) et sont dérivés de la taille. Un test par borne (0,1 ; 0,25 ; 0,5 ; `quickwin` à 2 j).

### E5. Plan natif et plan lu dans la même classe

**Preuve.** `src/plan.ts` (1 141 lignes) contient 13 occurrences de `settings.format` / `this.foreign` / `readOnly()` :
la classe `Plan` lit un plan d'un autre outil (`read()`, `lotsRaw()`, `refs()`, `hasPublic`, `hasVisible`) et refuse
d'écrire quand `format` est posé, tout en portant l'écriture native (une vingtaine de mutateurs). `plan-foreign.ts` (93 lignes) ne
porte que la traduction d'une entrée. Le plan lu a par ailleurs ses propres interdits (`states`, `extras`,
`requirePlanned` « jamais avec `format` »), vérifiés clé par clé dans `config.ts`.

La note du lead posait la question ; la réponse est oui, et c'est le point que la série « Plans riches » (L465–L473,
ressource `plan-coeur`) a rendu sensible : chaque lot de la série touche `plan.ts` et `config.ts`, d'où la règle « une
seule à la fois » du `cadence.yaml` parent.

**Lot proposé (0,5 j, code, risque faible).** Une interface `PlanReader` (lots, `lot(id)`, `refs(text)`, `isReadOnly`,
`lotsRaw`) ; `ForeignPlan` dans `plan-foreign.ts` l'implémente avec le cache `foreign` et les trois getters ; `Plan`
garde l'écriture et délègue sa lecture. `planLoader` (`config.ts:87`) rend l'un ou l'autre. Les tests existants
(`import-l472`, `orchestrate-command` « taches.yaml ») couvrent le chemin lu ; la façade `plan.ts` ré-exporte pour ne
toucher aucun import de test (méthode de L461 C). Mesure : `plan.ts` sous 1 000 lignes, base `max-lines` en baisse.

### E6. Quatre dossiers d'état, deux racines utilisateur, aucune page

**Preuve.** cadence écrit dans : le dépôt (`.cadence/`, versionné sauf `runs/` et `corrections.json`) ; le dossier de
lancement (`.cadence/runs/<vague>/`, `state.ts:279`) ; `~/.cadence/orchestrate/` (`CADENCE_HOME`, `registry.ts:18` :
vagues, créneaux, holds, `hud-context/`, `worktrees/`) ; `~/.local/share/cadence/` (copies en service,
`fonctionnement.md` §4) et `$XDG_DATA_HOME/cadence/references/` (`ref/store.ts:45`). Deux racines utilisateur
(`~/.cadence` et `~/.local/share/cadence`) pour un même outil ; `CADENCE_HOME` ne couvre que la première. L'information
est juste mais éparpillée sur cinq pages ; aucune ne la réunit, et `concepts.md` ne nomme ni `CADENCE_HOME` ni le
dossier de lancement.

**Lot proposé (0,25 j, docs, risque nul).** Une section « Où cadence écrit » dans `fonctionnement.md` (ou une page
`docs/config.md` qui porte aussi E14) : le tableau des couches ci-dessus, avec ce qui est versionné, ce qui se nettoie
(`session.clean`), et la variable qui déplace chaque racine. **Ne pas** déplacer `~/.cadence/orchestrate` sous XDG
aujourd'hui : c'est un changement de défaut (risque moyen, registre partagé par toutes les vagues vivantes) sans gain
pour le lecteur une fois la page écrite.

### E7. « hook » : quatre choses

**Preuve.** Dix-sept pages emploient le mot pour : les hooks **git** (`raf hook install`, `hook.autostart`,
`pre-commit`/`post-commit`/`pre-push`) ; les hooks **Claude Code** du plugin (`hooks/hooks.json` → `cadence
claude-hook retour|attente|pipe`, « The retour → geste hook » de `lead.md`) ; le **hook d'écriture du plan**
(`plan.onWrite`, `plan-onwrite.ts`) ; les **function hooks** du mod `cadence-hud` (`plugins/cadence-hud/hooks/`,
vocabulaire de Claude Code). Un lecteur de `concepts.md` n'y trouve aucun des quatre.

**Lot proposé (0,25 j, docs, risque nul).** Glossaire de `concepts.md` : quatre entrées (« hook git », « hook Claude
Code », « `plan.onWrite` », « hooks du mod ») ; relecture des 17 pages pour qualifier chaque emploi nu. Rien ne change
dans le code (`raf hook`, `hook.autostart` et `claude-hook` sont garantis ou publics).

### E8. « prêt » et « done » à deux sens

**Preuve.** `ready` est l'état de vague d'un lot dont le cycle est fini et intégré (`LotStatus`, `state.ts:13`) ; « lots
prêts » (`ready-free.ts`, `nextUp`, `lead tour`, `--continue`) désigne un lot `todo` du plan sans dépendance ouverte
ni ressource prise, **avant** tout travail. Le tableau final d'une vague et la ligne « prêts, ressources libres » du
tour emploient le même mot pour l'avant et l'après. De même `done` est un statut du plan et un `WaveStatus`.

**Lot proposé (0,25 j, docs, risque nul).** `concepts.md` et le glossaire : « prêt (vague) » et « tirable (plan) » ;
`lead tour` et `--continue` disent « tirables » (texte de sortie, non garanti). Le renommage de `FreeLot`/`readyFree`
en `drawable*` est interne et peut suivre dans le même lot si le temps reste ; sinon il n'est pas nécessaire.

### E9. Deux langues, une convention jamais écrite

**Preuve.** La documentation (`README`, `docs/*.md`) est en anglais ; la CLI (`raf add "titre" --estimate`), ses
messages, les commentaires du code, le `CHANGELOG` des 0.x, les noms de fichiers (`acceptation.json`,
`docs/nouveautes/`, `qualite-baseline.json`, `deliveries.log`, `holds/`), les agents et les skills sont en français.
Les clés de `cadence.yaml` mélangent : `orchestrate.maquette`, `fiche`, `maquetteReviews` à côté de `precheck`,
`probe`, `worktrees`, `budgetTopUp`, `testReplay`. Le plugin `cadence-hud` a un README en français et une page `docs/`
en anglais (E13). Pour le compte pro, c'est la première chose vue, et aucune page ne dit que c'est voulu.

**Lot proposé (0,25 j, docs, risque nul).** Une phrase dans `README.md` et une section dans `stabilite.md` : « la
documentation est en anglais, la CLI, ses clés et ses messages sont en français, et le resteront ; aucun alias n'est
ajouté ». C'est le choix recommandé : un alias anglais (`orchestrate.mockup` = `maquette`) serait un recouvrement de
plus et la garantie de stabilité interdit le renommage avant 2.0. Les nouvelles clés suivent la langue de leur
famille (français pour `orchestrate`, où la majorité des mots métier le sont déjà).

### E10. `docs-ok`, `docs_ok`, `docsOk`

**Preuve.** La commande est `raf docs-ok`, le fichier `.cadence/docs-ok.yaml`, la clé du lot `docs_ok` (seule clé du
plan en snake_case : les autres sont `camelCase` ou un mot), le champ TypeScript `docsOk` (14 / 2 / 6 occurrences dans
`plan.ts`, `docs-ok-file.ts`, `cli.ts`). La clé du plan est de fait garantie (« `lots` with their fields »).
**Lot :** avec E7, une ligne de glossaire ; pas de renommage.

### E11. Des chiffres qui ont vieilli

**Preuve.** `docs/overview.md:11,18,20,35,80` : « Four tools », « four skills », « three reviewer agents » ; la CLI
`cadence` connaît **15** outils (`bin/cadence.js`), le dépôt porte **5** skills (`orchestrate` compris) et **11**
agents (les « three reviewer agents » sont justes : `ux-`, `code-` et `qa-reviewer` ; les 8 autres ne sont comptés nulle part). `stabilite.md` garantit « the names
of the skills (`session-start`, `session-close`, `deliver`, `lead`) » : `orchestrate` n'y est pas, alors que le
README l'installe avec les autres. `docs/cadence-hud.md:8` dit « 2 agents ».

**Lot proposé (0,25 j, docs, risque nul).** `overview.md` cesse de compter : « the tools » et un tableau généré à la
main depuis l'aide (E2 le rendra vérifiable) ; `stabilite.md` ajoute `orchestrate` aux skills garantis (ajout, donc
mineur) ou dit pourquoi il ne l'est pas.

### E12. `orchestrate.md`, la page qu'on ne peut pas lire

**Preuve.** 308 380 octets, 1 222 lignes, **106 lignes de plus de 600 caractères**, la plus longue 10 325 ; 17 titres
`##`, pas de sommaire ; le premier bloc de code (lignes 11–36) fait 25 commandes dont plusieurs de plus de 300
caractères. Chaque lot y a ajouté son paragraphe « (Lnnn) » là où il tombait : la page est un journal, pas un manuel.
`docs/raf.md` (86 Ko) et `deliver.md` (51 Ko) suivent le même chemin. C'est la page vers laquelle `concepts.md`
renvoie le plus souvent (12 liens).

**Lot proposé (0,5 j, docs, risque nul — `scripts/check-links.mjs` vérifie les ancres).** Découper **sans réécrire** :
`orchestrate.md` garde l'ouverture, les commandes et un sommaire ; quatre pages reçoivent les sections telles qu'elles
sont : `orchestrate-cycle.md` (étapes, budget, revue, correction, escalade, voie express), `orchestrate-gate.md`
(porte, rouges de départ, rejeu seul, `readsPlan`, sonde), `orchestrate-spec.md` (spec, maquette, fiche, accept,
briefs aval), `orchestrate-worktrees.md` (worktrees, intégration, voisins, dépôt tiers). Chaque ancre déplacée reçoit
une ligne de renvoi dans l'ancienne page le temps d'une version. La réécriture des paragraphes-journaux en manuel est
un **autre** lot, par page, après : il demande une relecture de fond, pas un déplacement.

### E13. Deux documentations de la bande

**Preuve.** `plugins/cadence-hud/README.md` (42 Ko, français) et `docs/cadence-hud.md` (30 Ko, anglais) décrivent le
même plugin ; `test/hud-readme.test.ts` ne vérifie sur les deux que la coupe des titres (« ... »). Les deux pages ont
divergé par taille (12 Ko) ; aucune ne dit laquelle fait foi. **Lot (0,25 j, docs, risque nul) :** l'une est déclarée
traduction de l'autre en tête des deux fichiers, avec le `L` du dernier lot reporté ; ou le README du plugin devient la
fiche courte (installation, segments, `/hud lots`) et renvoie à `docs/` pour le détail.

### E14. Les portes se déclarent à trois endroits

**Preuve.** La porte de revue et la porte UX s'activent **dans le plan** (`raf review enable` → `reviewSince`, `raf ux
enable` → `uxSince`) ; les portes de tests, build, code-sans-test, docs, sonde, précheck, maquette, fiche s'activent
**dans `cadence.yaml`** (`orchestrate.*`, `docs.sync`) ; la porte déportée dans `orchestrate.gate.host` ; `verify.inPlace`
règle où la porte rejoue. Chacune est documentée dans sa page ; aucun tableau ne dit « voici les portes, où chacune
se déclare, ce qu'elle refuse ». `concepts.md` « The test gate » n'en couvre qu'une. **Lot :** avec E6 (page
`config.md` ou section de `fonctionnement.md`), un tableau de 10 lignes.

### E15. Trois lecteurs des mêmes journaux

**Preuve.** `perf.ts` (950 l.), `corrections.ts` (584 l.) et `orchestrate/waits.ts` lisent `.cadence/runs/` chacun
avec son analyseur de journal ; `perf-read.ts` (2,6 Ko) est le début d'un lecteur commun. Les journaux ne sont pas
garantis (`stabilite.md`), donc chaque changement de ligne de journal est à vérifier trois fois. **Pas de lot** : le
gain est faible tant que les trois ne divergent pas (aucun symptôme relevé), et une fusion forcée est un risque moyen
pour rien. À surveiller au prochain rituel : si `perf` et `corrections` donnent deux comptes de passes différents,
c'est ce point.

### E17. `config.ts` lit huit familles de clés

**Preuve.** `config.ts` (584 lignes, base `max-lines` 469) porte `readPlanConfig`, `readNewsConfig`, `readHookConfig`,
`readSessionConfig`, `readOrchestrateConfig`, `readVerifyConfig`, les lecteurs `docs` et `references` ; `perf-config.ts`
et `gate-config.ts` ont déjà leur module. **Lot (0,5 j, code, risque faible, après E6) :** un lecteur par notion dans
son module (`news.ts` lit `news:`, `session.ts` lit `session:`…), `config.ts` garde `readYamlKey`, `isObject` et la
liste des clés racine connues (une seule liste, qui sert aussi la page `config.md`). La base ESLint de `config.ts`
baisse de quatre règles.

## Ce qui tient, et qu'il ne faut pas toucher

Relevé pour que la prochaine étude ne le rouvre pas :

- **Le plan comme seule vérité, écrit par le programme.** Vérifié dans `cycle/plan-writes.ts`, `worktree.ts`, et par la
  règle « un sha de plan ne compte pas pour un lot » (`raf check`). Cohérent de bout en bout, docs et code.
- **La porte avant chaque passage d'état.** `raf done` refuse sans verdict (`reviewSince`), `deliver --sha` refuse un
  lot non prêt, `npm run service` refuse un lot non `done`, `pre-push` refuse sans `verify --gate` vert. Quatre portes,
  une logique, chacune documentée là où on la rencontre.
- **La séparation lead / vague / session.** Le lead ne code pas, la session ne pose pas de question, le programme
  enchaîne : `fonctionnement.md` §3, le skill `lead`, le hook `claude-hook retour` et `lead hold` racontent la même
  histoire.
- **Livré ≠ terminé** (L469) : deux faits, deux clés, une page. Un modèle de ce que E4 devrait devenir.
- **La garantie de stabilité** est courte, lisible, et aucun écart ci-dessus ne demande de la rompre.
- **L461 a porté** : `cycle.ts` est découpé (dossier `cycle/`, 19 modules), `command.ts` passe de 1 768 à 270 lignes,
  `cli.ts` de 1 619 à 219 ; la base knip tombe de 153 à 2.

## Chemins morts et liens

- **Liens relatifs des pages `docs/*.md` et du README** : 1 cible absente sur l'ensemble, `docs/news.md:55` → `../url`,
  qui est un exemple de syntaxe dans une phrase, pas un lien mort.
- **Chemins de code cités entre accents graves** : 14 absents, tous des exemples (`src/a.ts`, `src/api/x.ts`,
  `test/x.ts`…) ; les trois `test/hud-*` cités dans `docs/cadence-hud.md` existent sous ce nom.
- **`migrate.keep` de `cadence.yaml`** : les 12 chemins existent.
- **Aucun chemin mort trouvé dans les deux aides** ; leurs écarts sont des oublis (E2), pas des commandes disparues.

## Ordre proposé

1. **E2 + E3** (0,25 j) : une aide, une source. Rend E11 vérifiable.
2. **E1** (0,5 j), **après L589 et L591** : le chiffre lu, pas recalculé.
3. **E12** (0,5 j) : `orchestrate.md` en cinq pages.
4. **E4a + E7 + E8 + E10** (0,5 j en tout, un seul lot docs « vocabulaire ») : `concepts.md` gagne la taille des lots,
   les quatre hooks, prêt/tirable, `docs-ok`.
5. **E6 + E14** (0,25 j) : « où cadence écrit » et « les portes et où elles se déclarent ».
6. **E9 + E11 + E13** (0,5 j en tout, un lot docs « surface pour le compte pro ») : la convention des langues, les
   comptes retirés, la bande documentée une fois.
7. **E5** (0,5 j) puis **E4b** (0,25 j) puis **E17** (0,5 j) : les trois lots de code, chacun avec sa mesure du cliquet.

Total : 3,75 j, dont 1,75 j de documentation seule. Le rituel L595 rejoue les mesures ci-dessous dans 14 jours.

## Mesures à rejouer

Depuis la racine du dépôt (`rg` ou `grep -r`) :

```sh
# E1 — les formules de créneaux libres
grep -n "export function freeSlots\|export const freeSlots" src/orchestrate/registry.ts plugins/cadence-hud/hooks/format.ts
grep -n "free: number" src/orchestrate/pool.ts

# E2 — sous-commandes « cadence » de chaque aide (à comparer)
sed -n '/console.log(`cadence/,/`);/p' bin/cadence.js | grep -oE "^  cadence [a-z-]+( [a-z|-]+)?" | sort -u
awk '/^const HELP/,/^`;/' src/cli.ts | grep -oE "^  cadence [a-z-]+( [a-z|-]+)?" | sort -u

# E3 — spec green dans les aides
grep -c "spec green" src/cli.ts bin/cadence.js docs/spec.md

# E4 — les trois seuils
grep -n "EXPRESS_MAX_ESTIMATE" src/orchestrate/express.ts
grep -n "small = \|\.light = " src/orchestrate/preflight.ts

# E5 — branches plan lu dans plan.ts
grep -c "settings.format\|this.foreign\|readOnly()" src/plan.ts ; wc -l src/plan.ts src/plan-foreign.ts

# E6 — les racines d'état
grep -rn "'.cadence', 'runs'\|CADENCE_HOME ||\|XDG_DATA_HOME ||" src | cut -c1-140

# E11 — skills, agents, outils
ls skills | wc -l ; ls agents | wc -l ; grep -cE "^  cadence [a-z]" bin/cadence.js

# E12 — taille des pages
wc -c docs/orchestrate.md docs/raf.md docs/deliver.md
awk 'length($0) > 600 { n++ } END { print n }' docs/orchestrate.md

# Liens et chemins morts (le script du dépôt)
node scripts/check-links.mjs
```

Les chiffres de cette étude : `freeSlots` à 2 endroits + 1 `free` ; 9 commandes absentes de `bin/cadence.js` ;
`spec green` 0/0/1 ; seuils 0,1 / 0,25 / 0,5 ; 13 branches, 1 141 et 93 lignes ; 4 racines ; 5 skills, 11 agents, 15
outils ; 308 380 / 86 424 / 50 946 octets, 106 lignes longues.
