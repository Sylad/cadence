# Qui porte la hausse des tokens par lot, 18–24-10 contre 11–17-10 (L312)

`cadence perf` du 2026-10-24 (tour du lead du soir) lève deux `⚠` : tokens par lot à l'estimate 0,25 (150,0 k contre 116,6 k, +29 %) et 0,5 (442,4 k contre 318,7 k, +39 % ; 440,6 k à l'instant du tour), pendant que la part conforme du premier coup passe de 39 à 60 %.
Rejeu : `docs/perf/ventilation.py` avec `WIN = {'prev': ('2026-10-11', '2026-10-17'), 'cur': ('2026-10-18', '2026-10-24')}` et `FREEZE = '2026-10-24T22:00:00Z'` (copie du script), `python3 -I <copie> <dossier des projets>`, §Q. 324 lots rendus contre 322.

## 1. Par étape : `implement` porte la hausse, la revue ne bouge presque pas

Somme des jetons de chaque sorte d'étape par lot, en moyenne sur les lots de la classe (les sommes s'additionnent au total).

| Classe | Étape | Précédente | Courante | Écart |
|---|---|---|---|---|
| 0,25 (74 → 158 lots) | precheck | 20 k | 24 k | +3 k |
| | **implement** | 56 k | 76 k | **+20 k** (médiane par étape 54 k → 80 k, +48 %) |
| | review + review-small | 56 k | 63 k | +7 k (`review` −12 k, `review-small` +19 k : le passage de l'une à l'autre suit la taille du lot) |
| | fix | 15 k | 14 k | 0 |
| 0,5 (57 → 39 lots) | precheck | 15 k | 16 k | +1 k |
| | **implement** | 68 k | 102 k | **+34 k** (médiane par étape 72 k → 105 k, +46 %) |
| | review + review-small | 173 k | 200 k | +28 k (1,4 étape de revue par lot contre 1,3 : `review` +48 k, `review-small` −20 k) |
| | fix | 70 k | 80 k | +10 k |

- **L'étape porteuse est `implement`** aux deux classes (65 % de la hausse brute à 0,25 ; 47 % à 0,5, la revue et le fix se partageant le reste). Le nombre de passes `fix` par lot ne bouge pas (0,28 → 0,29 à 0,25 ; 1,53 → 1,54 à 0,5) : la hausse n'est pas une reprise de plus.
- **Le modèle** : à 0,25, Sonnet porte 126 k → 155 k (+29 k) et Opus 21 k → 22 k ; à 0,5, Sonnet 153 k → 199 k (+46 k) et Opus 172 k → 200 k (+28 k, la revue). La revue Opus n'est pas la cause à 0,25.
- **Le projet** : à 0,25, la médiane par lot monte dans les quatre projets (cadence 93 k → 122 k, ol-companion 114 k → 163 k, warhammer40k 123 k → 157 k, finance-tracker 145 k → 153 k) et `implement` passe de 51–58 k à 75–84 k dans chacun (avant et après le 17-10 12:08 UTC). Le mélange de projets bouge (finance-tracker 11 → 48 lots de cette classe) mais ne l'explique pas. À 0,5, `implement` monte surtout dans cadence (70 k → 121 k, 23 → 19 lots) ; ol-companion reste à 86 k : la lecture à 0,5 repose sur 39 lots dont 19 de cadence.
- **La date** : la rupture de `implement` coïncide avec la mise en service de l'auto-vérification en fin d'écriture (L236, commit 1985595, 17-10 12:08 UTC) : médiane 53 k puis 78 k à 0,25 (63 puis 169 étapes), 71 k puis 101 k à 0,5. C'est une coïncidence de date lue sur les journaux, pas une expérience : la cause n'est pas isolée.

## 2. Lecture : de la qualité payée, pas une estimate fausse

La part conforme du premier coup passe de 39 à 60 % sur l'ensemble des lots rendus, les lots à au moins 2 passes de 39 à 23 %. Le surcoût est à l'écriture (auto-vérification de L236 incluse), pas à la revue ni au fix. Ce n'est donc pas l'estimate qui est fausse : un lot de 0,25 jour coûte 150 k et un lot de 0,5 jour 440 k, et les budgets les contiennent (§3).
Réserve : à la classe 0,25 seule, la part sans passe `fix` ne monte pas (84 % → 80 %), à 0,5 elle monte (11 % → 23 %) ; le jumeau de `cadence perf` est la part de l'ensemble des lots, pas celle de la classe, donc « qualité payée » est la lecture de l'ensemble, pas une preuve à 0,25.

## 3. Ce qui est recalé, et ce qui ne l'est pas

- **Budgets : inchangés.** 0 lot sur 322 au-dessus de son budget (32 sur 324 la fenêtre précédente) ; p90 460 k sous 600 k, 408 k sous 540 k, 557 k sous 750 k, 744 k sous 1,3 M. Relever sans dépassement ne servirait à rien (même lecture que `recalage-2026-10-24.md` §2).
- **Grille d'estimate de `raf add` et du brief du lead** : ni l'une ni l'autre ne porte de jetons (`raf add --estimate` prend des jours, le brief du lead ne cite aucun coût par classe) ; rien à y recaler. Les 150 k et 440 k restent dans ce document et dans `docs/perf.md`.
- **Le conseil de `cadence perf`** change (la seule modification de code) : le `⚠ tokens par lot` cite l'étape qui porte la hausse, et quand la part conforme du premier coup monte il ne dit plus « l'estimate est mal calibrée » mais « de la qualité payée, pas une estimate fausse ; juger cette étape (modèle, effort, passes) avant de recaler l'estimate ».

## 4. Avant / après sur le même jeu de journaux

Avant : `⚠ tokens par lot (estimate 0.25) : 150,0 k (précédente 116,6 k, +29 %) · part conforme du premier coup : 60 % (précédente 39 %, +54 %) · → l'estimate est mal calibrée : redécouper le lot ou recaler l'estimate et les budgets` (même ligne à 0,5, 442,4 k contre 318,7 k).
Après : la même ligne finit par `→ la hausse est portée par l'étape implement (+20,1 k par lot) alors que la part conforme du premier coup monte : de la qualité payée, pas une estimate fausse ; juger cette étape (modèle, effort, passes) avant de recaler l'estimate` à 0,25 et `(+34,5 k par lot)` à 0,5. `review` et `review-small` comptent pour une seule étape : sans cela, `review` (+48 k) aurait désigné la revue à 0,5, alors que `review-small` baisse de 20 k pour la même raison.

## 5. Limites

- Moyennes de sommes par étape (elles s'additionnent) là où `perf` affiche des médianes de total : à 0,25 la moyenne monte de 147 k à 177 k (+20 %), la médiane de 117 k à 150 k (+29 %).
- La classe 0,5 compte 39 lots courants (19 de cadence) ; sa lecture par projet est fragile.
- Le conseil se fonde sur la hausse brute par étape de la classe, pas sur une cause établie ; la date de L236 est une coïncidence.
