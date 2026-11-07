# Cadence 2 — design de la refonte

Date : 2026-11-07. Statut : **à relire par Sylvain**. Décision d'origine : essai A/B du 07-11
(`~/projects/developpeur/tmp/essai/VERDICT.md`), perdu par cadence 1.62.

## 0. Pourquoi cette refonte : l'échec à ne jamais reproduire

Essai sur 8 vraies demandes, même commit de départ, juges à l'aveugle :

| | A — Opus seul | B — cadence 1.62 |
|---|---|---|
| Temps | 52 min | 199 min (×3,8) |
| Tokens | 1,27 M | 5,7 M (×4,5) |
| Relecture aveugle | préféré 8/8 | 0/8 |
| Tests cachés d'origine verts | 301 | 304 |
| Mutations tuées par les tests laissés | 79 % | 71 % |
| Interventions du lead | 0 | 12 |

Cinq causes établies. **Chacune a une contre-mesure dans ce design, et le banc la vérifie.**

| # | Cause dans v1 | Mesure | Contre-mesure v2 | Où |
|---|---|---|---|---|
| C1 | Contrôles de conformité à une fiche figée (fiche, maquette, tests d'acceptation scellés), pas à la demande | 101 rescellements et 13 lots rendus pour verrou en 30 j | La **demande brute**, gardée mot pour mot, est la seule référence du relecteur. Aucun test scellé. Maquette seulement sur demande explicite | §2, §3 |
| C2 | Contexte découpé entre sessions Sonnet successives | B écrit en Sonnet, plusieurs sessions par lot | **Un seul responsable Opus** par demande, une session reprise (`--resume`) du début à la fin | §2 |
| C3 | Portes empilées | Retouche : 4 portes, 24 min de porte pour 4 min de travail ; porte « fin de lot » : 0 rouge propre | **Deux portes au plus** : ciblée par le responsable, complète une fois à l'intégration | §2 |
| C4 | Mécanismes ajoutés sans mesure | src : 6 400 → 39 300 lignes en un mois, 27 options d'orchestrate | **Budget de lignes** contrôlé en CI ; un mécanisme n'entre qu'avec un rapport de banc où il gagne | §5 |
| C5 | Lead qui rattrape la machine | 12 interventions sur 8 demandes | Interventions **comptées par le banc** ; seuil : 0 hors vraie question à Sylvain | §4 |

## 1. Objectif (inchangé) et barre de qualité

Une équipe d'agents prend une demande vague, la retient au plan, livre un code testé, conforme aux
bonnes pratiques du projet, avec une UI cohérente avec le reste de l'application.

**Barre de publication** (sur l'ensemble des bancs, cf §4). v2 n'est publiée que si **chaque**
critère tient :

| Critère | Barre |
|---|---|
| Relecture aveugle contre A | égalité ou mieux sur la majorité des bancs |
| Tests cachés d'origine verts | ≥ 304 sur les 8 bancs fixes |
| Mutations tuées par les tests laissés | ≥ 79 % |
| Défauts bloquants + majeurs (juge) | ≤ A |
| Cohérence UI (captures à l'aveugle) | ≥ A |
| Temps | ≤ 1,5 × A au total ; ≤ 1,2 × A sur les retouches |
| Interventions humaines | uniquement de vraies décisions (question à Sylvain), 0 rattrapage |

Ce que v1 apportait réellement et que v2 garde : le plan (`raf.yaml`, la mémoire des demandes),
la porte, `deliver` (CI, gitops, vérification de l'effet), la revue courte du diff
(3 majeurs sur 14), la QA navigateur après livraison, la revue UX des changements visibles.

## 2. Flux d'une demande

```
phrase de Sylvain
  └─ 1. ACCUEIL      gardien du projet : place la demande, classe sa taille, écrit le lot
  └─ 2. RÉALISATION  responsable Opus, une session, worktree dédié : code + tests + porte ciblée
  └─ 3. RELECTURE    relecteur (demande brute + diff) ‖ gardien (cohérence)   [fonction, grosse]
  └─ 4. CORRECTION   même session du responsable reprise ; ≤ 2 tours, puis Fable reprend
  └─ 5. INTÉGRATION  rebase + porte complète UNE fois, merge
  └─ 6. LIVRAISON    deliver (CI → gitops → vérif effet) + QA navigateur si visible
  └─ 7. CARTE        le gardien met la carte du projet à jour (quelques lignes)
```

**1. Accueil.** Le gardien lit la carte du projet (§3) et la demande. Il écrit le lot au plan avec :
- `demande:` le texte brut de Sylvain, **jamais reformulé** (c'est la référence de jugement) ;
- `taille:` `retouche` | `fonction` | `grosse`, avec la raison (fichiers et écrans touchés) ;
- `note:` la place de la demande dans le projet : écrans et workflows touchés, décisions passées
  concernées, conflits éventuels.

Il ne pose une question à Sylvain que si un choix est coûteux à défaire ou contredit une décision
passée. Sinon il avance et note l'hypothèse dans le lot.

**2. Réalisation.** Un responsable (Opus par défaut) dans un worktree dédié reçoit : la demande
brute, la note du gardien, le CLAUDE.md du projet. Il écrit le code et les tests (TDD quand le
comportement est testable), lance lui-même la porte ciblée. Pour une `grosse` demande, il écrit
d'abord un plan court dans le lot, puis enchaîne les commits **dans la même session**.
Les demandes tournent en parallèle, chacune dans son worktree : une retouche n'attend jamais
qu'un dépôt se libère.

**3. Relecture** (`fonction` et `grosse` seulement ; une `retouche` passe directement à 5).
- Le **relecteur** reçoit la demande brute et le diff, rien d'autre. Question unique : le diff
  fait-il ce qui est demandé, sans défaut ? Constats classés, chacun avec fichier:ligne et
  scénario d'échec.
- Le **gardien** vérifie la cohérence avec le reste du projet : workflows, conventions, charte UI
  (sur captures si le changement est visible). Il **conseille**, il ne bloque jamais sur une règle
  figée ; un conflit de fond devient une question à Sylvain.

**4. Correction.** Les constats reviennent au responsable, dans **sa** session (contexte gardé).
Deux tours au plus ; au-delà, Fable reprend le lot. Si Fable échoue aussi, question à Sylvain avec
les constats.

**5. Intégration.** Rebase, porte complète **une seule fois**, merge. Un test instable est rejoué
seul une fois ; s'il passe, il est signalé dans le rapport du lot, pas relancé en boucle.

**6. Livraison.** `deliver` inchangé dans le principe (attendre la CI, bumper le tag du seul chart
concerné, vérifier l'effet). QA navigateur si le lot touche un écran.

**7. Carte.** Le gardien ajoute à la carte ce qui a changé (écran, workflow, décision).

Modèles : responsable Opus, relecteur Opus, gardien Opus, Fable pour la reprise et l'arbitrage.
**Le modèle de chaque rôle est une variable du banc** (§4) : on garde le moins cher qui tient la
barre.

## 3. Le gardien de projet

Un agent par projet, défini une fois (`agents/gardien.md`, générique), qui travaille sur un
fichier par projet : `.cadence/carte.md`, versionné dans le dépôt.

Contenu de la carte, en tout ≤ 300 lignes (au-delà, le gardien la compacte) :
- **Écrans et parcours** : route, rôle, composants partagés, workflows qui les traversent.
- **Où est la doc** : README, docs/, CHANGELOG, Nouveautés, spécificités.
- **Conventions et charte** : stack, règles de code citées du CLAUDE.md, jetons UI, composants
  de référence pour la cohérence visuelle.
- **Décisions** : ce qui a été tranché, quand, pourquoi (une ligne chacune).
- **Livré récemment** : les 20 derniers lots, une ligne chacun.

Rôles : accueil (§2.1), cohérence (§2.3), mise à jour (§2.7), audit hebdomadaire (§4.3).
Première carte : générée par le gardien à partir du dépôt, puis relue par Sylvain.

Garde-fou C1 : la carte décrit, elle ne verrouille rien. Aucun test, aucune porte ne lit la carte.

## 4. Fiabilité de l'outil : le banc

### 4.1 Banc court — avant TOUTE publication

- Bancs 1, 3, 6 de l'essai (retouche, fonction, page entière), ~1 h.
- `cadence release` **refuse** de publier sans rapport de banc court vert sur le sha publié.
- Le rapport est versionné : `bench/rapports/<date>-<sha>.md`.

### 4.2 Banc complet — chaque weekend

- **8 bancs fixes** (ceux de l'essai, clones et tests cachés déjà prêts dans `tmp/essai/`, à
  déplacer dans un emplacement stable `~/bench-cadence/`).
- **2 ou 3 bancs frais** tirés des vraies demandes livrées dans la semaine (commit de départ =
  parent du premier commit du lot ; tests cachés = tests du lot d'origine). Empêche de
  s'ajuster aux bancs fixes.
- Bras : A (Opus seul) contre cadence 2 ; au premier passage, aussi cadence 2 avec Fable en
  responsable, et cadence 2 sans gardien (le gardien doit gagner sa place).
- Mesures (outils existants de l'essai, transformés en commande `cadence bench`) : temps, tokens,
  interventions, tests cachés, mutations sur le code changé, relecture aveugle, captures aveugles,
  contrôle des fuites.
- Juges à l'aveugle, ordre alterné, un bras à la fois (incident du 07-11 : navigateur partagé).
- Rapport : tableau comme `VERDICT.md` + **courbe semaine après semaine**. Si un critère de la
  barre (§1) rate, la publication est bloquée jusqu'au passage suivant.

### 4.3 Audit de durée

Le banc ne voit pas la dette qui s'accumule. Chaque weekend, chaque gardien fait un audit de
cohérence de son projet (doc en retard, workflows divergents, doublons) et le rapport suit le
nombre de constats d'une semaine à l'autre.

### 4.4 Tests de l'outil lui-même

- Tests unitaires du noyau + tests de bout en bout sur un dépôt témoin, avec un faux `claude`
  (sorties enregistrées) : chaque étape du flux §2, rejouable en CI sans dépense.
- Chaque demande réelle journalise : temps demande → prod, tokens, interventions. Le rapport
  hebdomadaire les montre à côté du banc.

### 4.5 Lancement

Le banc complet tourne sur Big-Blue. WSL ne démarre pas avec Windows (choix de Sylvain) :
- le banc se lance automatiquement à la première ouverture de WSL du samedi ou du dimanche ;
- s'il n'a pas tourné le dimanche à minuit, `cadence` l'affiche à chaque début de session et
  `cadence release` refuse de publier.

## 5. Le noyau v2 et ses limites de taille

Nouveau code, dans le même dépôt (`src/v2/`), publié en `2.0.0`. Réutilise, en les recopiant et
en les élaguant, uniquement : lecture/écriture du plan, `deliver`, la porte.

| Module | Rôle | Budget |
|---|---|---|
| `plan` | `raf.yaml` (format compatible v1 en lecture), champs `demande`, `taille`, `note` | 500 |
| `accueil` | appel du gardien, écriture du lot | 200 |
| `run` | worktree, session responsable, reprise, relecture, correction, intégration | 800 |
| `porte` | ciblée + complète, rejeu unique des instables | 300 |
| `deliver` | CI, gitops, vérification | 600 |
| `bench` | bancs, bras, mesures, rapport, garde de publication | 600 |
| **Total** | | **≤ 3 000 lignes** |

Agents : `gardien`, `responsable`, `relecteur`, plus `qa-reviewer` et `ux-reviewer` repris.
Skills : `lead`, `deliver`, `bench`. Rien d'autre au départ.

Règles :
- La CI compte les lignes de `src/v2/` et échoue au-dessus du budget.
- Un module, une option ou un agent neuf n'entre qu'avec un rapport de banc où il gagne.
- Une option n'existe que si un vrai usage la réclame.

## 6. Migration

1. v1 gelée en 1.62.x : correctifs seulement. Le compte pro reste dessus en mode léger (plan du
   07-11, étape 1) jusqu'à la bascule.
2. Construire v2 (plan d'implémentation à part), en commençant par `bench` : on mesure avant de
   construire le reste.
3. Premier passage du banc court sur v2 (il remplace le contre-essai « équipe légère » prévu).
4. Bascule : v2 publiée en 2.0.0 après **deux bancs complets verts consécutifs**. Les plans existants
   restent lisibles ; les champs v1 sans usage en v2 (screen, spec, scellés) sont ignorés.
5. Lots v1 en suspens (L477 `doing`, L678 à L684) : réévalués un par un contre ce design, abandonnés
   avec raison s'ils ne servent plus.

## 7. Hors périmètre

- Réécrire les projets utilisateurs (ol, finance, warhammer, maritime).
- Le HUD, Gantt, perf, études de cas, articles : non repris en v2 tant qu'aucun usage ne les
  réclame.

## 8. Questions ouvertes

- Q1. Bancs frais : qui choisit les 2 ou 3 demandes de la semaine ? Proposition : tirage automatique
  parmi les lots livrés, stratifié par taille.
- Q2. Coût du banc complet : ~4 h et ~7 M tokens par weekend avec 2 bras (mesure du 07-11), environ le double au premier passage avec 4 bras. Acceptable ?
