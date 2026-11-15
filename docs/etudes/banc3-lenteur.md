# Banc 3 : pourquoi cadence-run paraît plus lent que A (L735)

Étude en lecture seule, le 15-11-2026, au sha `ab8518a3`. Aucun code, brief, réglage ni banc n'a changé : ce
document est le seul livrable.

**Constat de départ.** Au banc 3 (`3-ol-companion-L241`), le bras `cadence-run` est plus lent que A dans 5 passages
sur 6 depuis le 14-11 (× 2,0, 1,5, 1,5, 1,3, 2,1). Le 15-11 à 17 h 49, il met 599 s et 7,6 M jetons, contre 286 s
et 2,5 M pour A. Ce passage met le critère « temps total ≤ 1,5 × A » au rouge.

## Verdict

1. **Au banc court, le bras `cadence-run` exécute exactement le bras A.** Dans les 21 sessions du banc 3 (13–15-11),
   le prompt reçu par les deux bras d'un même passage est identique, octet pour octet aux chemins `c1`/`c2` près. Ce
   prompt est le brief `bras-A.md`, sans « Taille : », sans registre ni `carte.md`, sans le hook « lecture
   obligatoire » ni aucun `--settings`. Toutes les sessions tournent en `claude-opus-5-5`.
   Cause : `v2/src/bench/cli.ts:125` appelle `lancerBras(…, { pieces: [], … })`. L'aiguillage
   (`v2/src/run/aiguillage.ts:42`) ne voit donc aucune pièce, alors que la demande du banc 3 en cite une (la capture),
   et il choisit le mode léger, c'est-à-dire `BRAS_LEGER`, le bras A. Le banc de séquence, lui, transmet les pièces
   (`v2/src/sequence/passage.ts:181`).
2. **L'écart vient donc du tirage, pas de cadence.** La tâche du banc 3 admet deux solutions, et chaque session en
   tire une au hasard :
   - **minimale** : on corrige le moment où le classement est photographié. Seuls les points à venir sont justes.
   - **large** : on recalcule l'historique à partir des résultats de Ligue 1 lus chez 365scores, et les anciens points
     sont réparés.
   Une session large coûte en moyenne **601 s contre 300 s**, et **6,9 M jetons contre 2,5 M**. **À approche égale,
   les deux bras ont la même durée** : 600 s contre 602 s en large, 304 s contre 297 s en minimale.
   Sur la fenêtre citée, `cadence-run` a tiré l'approche large 6 fois sur 6, et A 3 fois sur 6. Sur tout l'historique,
   la proportion est de 8 sur 12 pour l'un et de 5 sur 9 pour l'autre.
3. **Le critère de temps ne sait pas départager deux bras identiques sur ce banc.** Sur les 10 passages où les deux
   bras étaient identiques, le second bras listé dépasse 1,5 × le premier dans 4 cas, et l'écart dépasse 1,5 dans un
   sens ou dans l'autre dans 6 cas.

En conséquence, **ni la porte, ni le hook, ni le brief v2d, ni la suite complète ne sont en cause.** Aucun de ces
éléments n'a tourné dans ces passages. Le banc court n'a encore jamais mesuré `cadence run` sur une demande qui
contient une pièce.

## 1. Méthode

Les sources sont les fichiers `resultat.json` (durée, jetons, ids des sessions, correspondance `c1`/`c2` → bras), les
`c<n>.patch` et `c<n>.captures/` de `~/bench-cadence/runs/<passage>/3-ol-companion-L241/`, et les transcripts
`~/.claude/projects/*/<session>.jsonl`.

Pour chaque session, on mesure les éléments suivants :

- **Temps outil** : de chaque `tool_use` à son `tool_result`.
- **Temps modèle** : le temps total moins le temps outil, soit la génération plus la latence de l'API.
- **Appels** : les messages assistant distincts (`message.id`). Leurs `usage` donnent les jetons.
- **Commandes Bash**, classées en lectures, écritures, tests ciblés, suite complète (backend ou frontend sans chemin),
  app et captures (build, serveur, `curl localhost`, Playwright), amont (`webws.365scores.com`) et lint/build.
- **Refus de hook** et **appels Agent**.

L'approche est dite « large » quand le patch ajoute une fixture de données amont réelles. Le classement est confirmé
par les appels amont et par les fichiers touchés.

Pour vérifier que les bras sont identiques, on prend le hash du premier message utilisateur, avec `c1`/`c2`
normalisés, ainsi que le champ `model` de chaque message assistant.

Ce que le banc ne contient pas : **aucune porte** (le banc court ne lance pas `cadence verify`), **aucun sous-agent**
(0 appel Agent dans les 21 sessions), **aucune question** et **aucune reprise** (une session par bras).

## 2. Passage par passage (fenêtre du 14-11 au 15-11, A contre cadence-run)

`pos` indique l'ordre de passage (`c1` joue en premier). Les temps sont donnés en secondes, et « suites » vaut
nombre / secondes.

| Passage | Bras | pos | Durée | Jetons | Appels | Modèle | Outils | s/appel | Approche | Fichiers code (fe) | Lignes + | Amont | Suites | App+captures | Lectures | Écritures |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| 14-11 00:02 | cadence-run | c1 | 668 | 8,2 M | 63 | 482 | 177 | 7,6 | large | 11 (3) | 2 187 | 3 | 4 / 113 | 12 / 17 | 24 | 14 |
| | A | c2 | 335 | 2,4 M | 24 | 228 | 95 | 9,5 | minimale | 3 (1) | 280 | 0 | 5 / 78 | 0 | 11 | 5 |
| 14-11 10:00 | cadence-run | c1 | 467 | 4,2 M | 39 | 387 | 74 | 9,9 | large | 5 (0) | 456 | 4 | 1 / 23 | 9 / 18 | 20 | 6 |
| | A | c2 | 312 | 2,8 M | 31 | 231 | 77 | 7,5 | minimale | 3 (0) | 325 | 0 | 3 / 40 | 1 / 9 | 15 | 2 |
| 14-11 17:21 | cadence-run | c1 | 498 | 4,9 M | 42 | 375 | 116 | 8,9 | large | 5 (0) | 2 714 | 1 | 4 / 40 | 5 / 36 | 19 | 9 |
| | A | c2 | 749 | 9,1 M | 66 | 558 | 184 | 8,5 | large | 10 (3) | 662 | 5 | 2 / 80 | 5 / 43 | 25 | 16 |
| 15-11 15:40 | cadence-run | c1 | 730 | 9,9 M | 72 | 496 | 227 | 6,9 | large | 12 (4) | 2 152 | 4 | 3 / 108 | 4 / 40 | 31 | 12 |
| | A | c2 | 481 | 4,3 M | 38 | 361 | 114 | 9,5 | large | 6 (2) | 402 | 1 | 2 / 45 | 4 / 37 | 16 | 7 |
| 15-11 16:04 | cadence-run | c1 | 655 | 8,6 M | 63 | 487 | 162 | 7,7 | large | 11 (2) | 2 441 | 4 | 1 / 67 | 6 / 42 | 24 | 16 |
| | A | c2 | 489 | 5,7 M | 48 | 350 | 126 | 7,3 | large | 5 (0) | 2 183 | 3 | 3 / 38 | 6 / 39 | 18 | 10 |
| 15-11 17:49 | cadence-run | c1 | 599 | 7,6 M | 59 | 429 | 162 | 7,3 | large | 12 (3) | 2 245 | 2 | 3 / 79 | 14 / 40 | 26 | 9 |
| | A | c2 | 286 | 2,5 M | 25 | 230 | 50 | 9,2 | minimale | 2 (0) | 273 | 0 | 4 / 28 | 0 | 10 | 2 |

Durée et jetons proviennent de `resultat.json`. Les autres colonnes sont mesurées dans les transcripts : la durée
mesurée y est plus courte de 5 à 10 s, car elle ne compte ni le démarrage ni l'arrêt de `claude -p`.

Les refus de hook (1 à 3 par session) apparaissent dans les deux bras. Ce sont les hooks globaux de la machine, et non
ceux du banc : `| tail` sans `pipefail` et `pkill`. Ils coûtent chacun un appel.

## 3. Où partent le temps et les jetons

**Le temps est surtout du temps modèle (74 %), et il croît avec le nombre d'appels.** Sur les 21 sessions, la
corrélation entre la durée et le nombre d'appels vaut r = 0,98, et celle entre les jetons et le nombre d'appels vaut
r = 0,99. La latence par appel est stable : 8,1 s en approche large et 9,0 s en minimale. `cadence-run` n'est pas plus
lent par appel (8,1 s contre 8,6 s pour A sur la fenêtre). Chaque appel relit tout le contexte, soit environ 120 000
jetons, dont 97 % en lecture de cache. Les jetons suivent donc le nombre d'appels, multiplié par un contexte qui grossit.

Moyennes par approche, sur toutes les sessions du banc 3 du 13 au 15-11 (13 larges, 8 minimales). Chaque case donne le
nombre d'appels d'outil et le temps des outils :

| Poste | Large | Minimale | Écart |
|---|---|---|---|
| Lectures (Bash et Read) | 21,7 / 9 s | 11,2 / 4 s | +10,5 appels |
| Écritures | 11,0 / 7 s | 4,1 / 1 s | +6,9 |
| Tests ciblés | 6,8 / 15 s | 3,9 / 7 s | +2,9 |
| **Suites complètes** | **3,0 / 67 s** | **3,2 / 38 s** | **≈ 0 lancement** |
| App et captures | 6,8 / 47 s | 1,1 / 11 s | +5,7 |
| Appels amont 365scores | 3,5 / 7 s | 0 | +3,5 |
| Lint et build | 2,6 / 10 s | 2,1 / 7 s | +0,5 |
| Appels modèle | 54 | 26 | **+28** |
| Temps modèle / outils | 433 s / 161 s | 225 s / 68 s | +208 s / +93 s |
| Fichiers de code touchés (dont frontend) | 8,5 (2,2) | 2,9 (0,1) | |
| Lignes ajoutées / captures | 1 816 / 3,8 | 276 / 0,2 | |

L'approche large ajoute à peu près 28 appels :

- explorer l'API des résultats et écrire des scripts d'analyse ;
- figer une fixture de résultats réels (de 1 500 à 2 000 lignes) ;
- extraire le départage LFP et le recalcul ;
- toucher le composant du tracker et ses tests ;
- lancer l'app, prendre les captures à 1 440 et 390 px et les regarder.

Le nombre de lancements de la suite complète ne change pas (environ 3). La suite est seulement plus longue quand le
frontend est touché.

Le passage du 15-11 à 17 h 49 illustre bien l'écart. Les deux sessions lisent la capture, puis le service, et
arrivent au même diagnostic dans la première minute. `cadence-run` écrit ensuite : « je vérifie si on peut plutôt le
recalculer à partir des résultats de Ligue 1 ». Il conclut sur « après la J7, l'OL était 1er, le tracker le mettait
4e », ce qui correspond à la demande « il y a 2 semaines on était premier ». A ajoute une règle d'enregistrement et
conclut : « les points déjà faux en prod ne sont pas réparés ».
Les 313 s d'écart se répartissent ainsi : 34 appels de plus (199 s de modèle) et 112 s d'outils, dont 40 s d'app et de
captures et 51 s de suites de plus (frontend compris).

## 4. La cause principale, prouvée

**a. Les bras sont identiques.** Pour chacun des 6 passages, le hash du prompt de `c1` est égal à celui de `c2` :
`144289`, `dd355b`, `7c0f03`, `e9eefe`, `5d0496` et `c8bf8c`. Le prompt contient `Tu travailles dans le dépôt…`, qui
est `bras-A.md`, et ne contient pas `Taille :`, qui serait `bras-sequence-v2d.md`. Aucun refus du hook « lecture
obligatoire » n'apparaît. Toutes les sessions sont en `claude-opus-5-5`. Le chemin de code est le suivant :
`cli.ts:125` passe `pieces: []`, puis `bras.ts:82` appelle `aiguiller(…, [])`, `aiguillage.ts:42` évalue `complet`
à faux (`ol-companion` n'a pas de `cadence.yaml`, donc pas de `references`), et le bras retenu est `BRAS_LEGER`.

**b. À approche égale, aucune différence.** En approche large, A met 600 s pour 53 appels (5 sessions) et
`cadence-run` 602 s pour 55 appels (8 sessions). En minimale, A met 304 s pour 27 appels (4 sessions) et `cadence-run`
297 s pour 24 appels (4 sessions). Le ratio par passage dépend seulement de l'approche que chaque bras a tirée.

**c. Le « 5 sur 6 » reste dans le hasard.** Avec deux bras identiques, la probabilité d'obtenir au moins 5 défaites
sur 6 vaut 7/64, soit 11 %. Le 13-11, avec le même brief, `cadence-run` avait gagné deux fois : 214 s contre 597 s, et
204 s contre 283 s. En tirant au hasard dans les 21 durées mesurées (deux bras identiques), on obtient « candidat
> 1,5 × référence » dans 24 % des cas avec une répétition, 17 % avec trois répétitions (médianes) et 12 % avec cinq.
La distribution est bimodale, et la médiane ne suffit pas à la lisser.

**Causes secondaires constatées :**

- **L'ordre ne change pas au banc 3.** `cli.ts:111` donne l'ordre `(t.i + t.k − 1) % 2`. Avec une seule répétition,
  le banc 3 fait donc toujours jouer `cadence-run` en premier, et la position est confondue avec le bras. Une session
  en `c1` a tiré l'approche large 9 fois sur 11, contre 4 fois sur 10 en `c2` (Fisher unilatéral p = 0,063). Ce n'est
  pas prouvé, mais assez proche du seuil pour ne pas l'ignorer. Je n'ai pas trouvé de mécanisme qui l'explique : la
  latence par appel et la durée des suites ne sont pas plus élevées en `c1`.
- **Le bras `cadence-run-sonnet` a tourné en Opus.** `bras.ts:82` remplace la définition du bras par `a.bras` et ne
  garde que `nom`, si bien que `modele: sonnet` est perdu. Les 4 sessions « sonnet » du 14-11 à 10 h 18 sont en
  `claude-opus-5-5`. La comparaison Opus/Sonnet de ce passage n'a donc rien mesuré.

## 5. Mécanismes proposés

### M1. Le banc joue le vrai `cadence run` (test)

- **Changement.**
  - `cli.ts:125` passe les pièces du banc (`bancs/<id>/pieces/*`) à `lancerBras`, comme le fait déjà `passage.ts:181`.
  - `bras.ts:82` garde le `modele` déclaré par le bras quand l'aiguillage choisit le brief.
- **Tests.**
  - Un banc avec pièce donne au bras `aiguillage` un prompt qui contient `Taille :`, ainsi que le `--settings` du hook.
  - Un banc sans pièce garde le brief A.
  - `cadence-run-sonnet` lance `--model sonnet`.
- **Coût.** Un lot de 0,5 j au plus : environ 5 lignes et 3 tests. Il faut ensuite rejouer au moins un passage pour
  rétablir la référence.
- **Mesure de réussite.**
  - Au prochain passage, le hash du prompt de `cadence-run` au banc 3 diffère de celui de A, et contient `Taille :`.
  - Les sessions du bras sonnet portent `model: claude-sonnet-*`.
  - Aux bancs 1 et 6 (sans pièce), les prompts restent identiques, ce qui est le bon comportement.
- **Ce que M1 ne promet pas.** Il ne rendra pas `cadence-run` plus rapide. En mode complet, le brief v2d demande en
  plus le registre, `carte.md`, la suite complète et la lecture obligatoire. M1 donne le **premier vrai chiffre**, qui
  peut s'avérer pire.

### M2. Un plancher de bruit pour le critère de temps (test)

- **Changement.**
  - Le verdict ne compte le temps d'un banc que si l'écart dépasse le bruit mesuré **sur ce banc** entre deux bras
    identiques.
  - L'ordre des bras alterne aussi d'un passage à l'autre (parité du passage ajoutée à `t.i + t.k`).
- **Données disponibles.** Le banc 3 dispose déjà de 10 paires identiques (§ 4c, sans coût supplémentaire), qui
  donnent 4 faux rouges sur 10 avec le seuil de 1,5. Pour les autres bancs, on calcule le même taux à partir des
  passages où l'aiguillage a choisi le mode léger : aux bancs 1 et 6 (sans pièce), les paires `cadence-run` / A sont des
  paires A/A (prompts identiques, vérifié sur les passages du 14-11 à 10 h et du 15-11 à 17 h 49).
- **Règle proposée.**
  - Un banc dont le taux de faux rouge entre bras identiques dépasse 10 % est marqué « temps bruité ».
  - Son temps est rapporté sans entrer dans le critère bloquant, tant qu'il n'a pas assez de répétitions.
  - Comme la distribution est bimodale, la médiane sur 5 répétitions donne encore 12 % : il faut l'exclusion ou un
    banc moins ambigu, pas seulement des répétitions.
- **Coût.**
  - Un lot de 0,5 j : un calcul sur `historique.jsonl` et les `resultat.json`, plus des tests de verdict.
  - Aucun passage supplémentaire au début.
  - L'alternance de l'ordre ne coûte rien.
- **Mesure de réussite.**
  - Rejouer la nouvelle règle sur les 10 paires identiques du banc 3 donne 0 rouge de temps.
  - Sur les 4 prochains passages, aucun ROUGE de temps n'est dû à un banc marqué bruité.
  - Une fois M1 en place, `cadence-run` (mode complet) passe en `c1` et en `c2` à parts égales au banc 3, ce qui
    permet de vérifier ou d'écarter l'effet de position (p = 0,063 aujourd'hui).

Je ne propose pas de rendre `cadence-run` plus rapide sur ce banc. Il n'y a rien à accélérer qui soit propre à cadence,
et la lenteur constatée correspond au choix de la réparation complète, que le banc sans juge ne note pas. La question
de l'approche à préférer revient à Sylvain, ou au juge.

## 6. Limites

- Le classement « large / minimale » repose sur la présence d'une fixture amont dans le patch. Une session (14-11
  10 h 18, r2, `c2`, 568 s) est classée minimale mais touche 6 fichiers et lance l'app. C'est le seul cas ambigu.
- Le classement des commandes Bash se fait par expressions régulières sur la ligne de commande. Une commande qui
  enchaîne test et build est comptée dans une seule catégorie.
- Les corrections (tests rouges puis réparés) n'ont pas été comptées une par une. Elles sont comprises dans les tests
  ciblés.
- La qualité des deux approches n'est pas jugée : tous ces passages sont « sans juge ».
