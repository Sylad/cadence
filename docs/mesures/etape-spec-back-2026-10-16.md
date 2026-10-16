# Mesure de l'étape spec back contre les lots non visibles (L190, B5)

Relevé du 2026-10-16, journaux `.cadence/runs` de `~/projects/developpeur`, vagues du 2026-10-15-1120 au 2026-10-16-1800. Critère : [`2026-10-11-etape-spec-back-design.md`](../superpowers/specs/2026-10-11-etape-spec-back-design.md), section « Mesure : critère de réussite », contre la référence des **lots non visibles** de [`corrections-2026-10-10.md`](corrections-2026-10-10.md) (208 lots, 135 avec au moins une correction soit 65 %, 61 avec au moins deux soit 29 %, 208 passes).

**Conclusion : avec 10 lots (le seuil de 8 est passé, c'est un verdict, non une note), le critère n'est atteint sur aucune des deux lignes, et l'étape coûte environ 2,5 fois plus de tokens que les passes de correction de ces lots. Ces chiffres ne justifient pas de généraliser l'étape back ; la spec veut que le seuil (« tout lot qui change un comportement ») soit resserré avant d'abandonner l'étape : c'est la décision du lead.**

## Échantillon

10 lots back avec fiche (`spec: true`, fiche avec bloc `sujet`, sans `ecran`), tous de cadence, tous `done` : L217, L218, L219, L220, L221, L222, L223, L229, L230, L231. Les deux autres fiches à bloc `sujet` du parc (finance-tracker L75, warhammer40k L120) sont des lots à écran (`screen: component`) : elles relèvent de la mesure des écrans, non de celle-ci. Aucun lot back d'ol-companion, de finance-tracker ou de warhammer40k n'a de fiche au 2026-10-16.

Un lot compte comme dans la référence : un journal où une session `implement` a abouti ; chaque lot n'a qu'un journal de ce type (L230 et L231 en ont deux, mais l'écriture n'a abouti que dans la seconde vague). Une passe de correction est une session `fix` aboutie.

| Lot | Passes de correction | Lot | Passes de correction |
|---|---|---|---|
| L217 | 2 | L222 | 2 |
| L218 | 3 | L223 | 1 |
| L219 | 1 | L229 | 2 |
| L220 | 0 | L230 | 2 |
| L221 | 3 | L231 | 1 |

## Résultats par ligne du tableau

| Indicateur | Référence (lots non visibles) | Réussite | Mesuré | Verdict |
|---|---|---|---|---|
| lots avec au moins 1 correction | 65 % (135 sur 208) | ≤ 40 % | 90 % (9 sur 10) | **non atteint** |
| lots avec au moins 2 corrections | 29 % (61 sur 208) | ≤ 15 % | 60 % (6 sur 10) | **non atteint** |
| passes par lot | 1,0 (208 sur 208) | — | 1,7 (17 sur 10) | plus, non moins |

### Passes par cause (17 passes)

Une cause par passe, celle du premier constat de la revue qui la précède (même règle que [`etape-spec-2026-10-12.md`](etape-spec-2026-10-12.md)) ; « bug de code » par défaut, « spec floue » si le constat dit que la fiche ne couvre pas le cas, « règle inventée » s'il dit que le code applique une règle absente de la fiche, « test manquant » pour un test absent, mal nommé ou qui ne peut pas échouer, « dérive d'architecture » pour une documentation ou un commentaire que le changement n'a pas suivi. Classement fait à la main, par une seule lecture (voir Limites).

| Cause | Passes | Part | Lots et passes |
|---|---|---|---|
| spec floue ou critère absent | 0 | 0 % | — |
| règle de gestion inventée | 0 | 0 % | — |
| dérive d'architecture (documentation ou commentaire non suivi) | 6 | 35 % | L217 ×2, L219, L221 (docstring, documentation d'usage), L229 (CHANGELOG) |
| test manquant | 5 | 29 % | L218 ×3 (R3, R4, R5/R6), L230 (R5), L231 (R4) |
| bug de code | 6 | 35 % | L221 (conclusion sans UX), L222 ×2 (méthode de la mesure), L223 (option sur les vagues déjà lancées), L230 (R9 d'un lot mixte), L229 (message de refus) |

Lecture : la part « spec floue + règle inventée + test manquant » vaut 29 % (5 sur 17), contre 34 % (71 sur 208) pour les lots non visibles de la référence. La fiche supprime bien les deux causes qu'elle vise (zéro passe pour une spec floue ou une règle inventée), mais le « test manquant » reste, et la documentation non suivie (35 %) est la première cause, que la fiche ne prévient pas. Cinq des six passes de documentation viennent des lots L217 à L221, avant la liste d'auto-contrôle de L222 ; la dernière est de L229. Après L222, les trois lots L229, L230 et L231 font 5 passes (1,7 par lot), comme avant (12 passes sur 7 lots, 1,7).

## Coût

Tokens comptés des journaux (entrée, écriture de cache, sortie ; hors lecture de cache), sur toutes les vagues des 10 lots.

| Poste | Sessions | Tokens | Par lot |
|---|---|---|---|
| spec | 23 | 1 043 310 | 104 331 |
| revue de fiche | 21 | 727 452 | 72 745 |
| **Étape spec (spec + revue de fiche)** | 44 | **1 770 762** | **177 076** |
| accept | 0 | 0 | 0 |
| passes de correction | 17 | 717 497 | 71 750 (42 206 par passe) |

Le précontrôle (10 sessions, 167 559 tokens) n'est pas compté : il tourne pour tout lot sans commit, avec ou sans fiche. L'étape accept n'a joué sur aucun de ces lots (`orchestrate.accept` absent de la configuration de cadence : le journal note « étape accept ignorée », le lot passe de la spec à l'implémentation sans tests rouges scellés) ; le coût d'accept d'un lot back n'est donc pas mesuré ici, et la fiche de ces lots n'a pas été confrontée à des tests rouges avant le code.

Passes évitées : **aucune**. Les 10 lots font 1,7 passe en moyenne contre 1,0 pour les lots non visibles de la référence. Même si l'étape avait supprimé toutes les passes attendues à ce taux (10 passes ≈ 422 000 tokens au coût de 42 206 par passe), elle coûterait plus de 4 fois ce qu'elle ferait économiser (1 770 762 contre 422 062).

## Verdict

- Sur 10 lots d'un seul projet, **le critère de réussite n'est atteint sur aucune ligne** (90 % contre ≤ 40 %, 60 % contre ≤ 15 %) ; avec 8 lots ou plus le résultat est un verdict (seuil de la spec).
- Aucune baisse des corrections ne compense le coût : ni la part de lots corrigés ni le nombre de passes n'ont diminué, et la spec et la revue de fiche ajoutent environ 177 000 tokens par lot.
- Ce que la fiche apporte reste vrai pour les deux causes qu'elle vise (aucune passe pour une spec floue ou une règle inventée) ; elle ne prévient ni la documentation non suivie ni le test manquant, qui font 65 % des passes.
- Conformément à la spec, **le seuil (tout lot qui change un comportement) est à resserrer avant d'abandonner l'étape** : décision du lead. Piste lue dans les chiffres, non démontrée : les passes se concentrent sur la documentation non suivie et le test manquant, que le contrôle de la fiche ne vise pas ; resserrer le seuil sans traiter ces deux causes ne les ferait pas baisser.

## Limites

- **10 lots, un seul projet (cadence), deux jours** : pas de significativité statistique ; les lots sont des lots d'outillage de cadence, dont la règle de documentation (`docs.sync`) et les fiches tournent sur l'outil lui-même.
- **Pas un essai contrôlé** : les lots avec fiche sont choisis par le lead, donc pas tirés au hasard ; la référence mélange des lots mécaniques (la fiche ne leur sera jamais demandée) et des lots qui changent un comportement.
- **La chaîne mesurée n'est pas celle de la spec** : l'étape accept n'a pas joué (voir Coût). L'effet des tests rouges avant le code sur les passes de « test manquant » n'est donc pas mesuré.
- **Un classement par une seule lecture** (la session qui a écrit cette note, sur le premier constat de chaque passe, sans le modèle local ni relecture croisée) : la frontière bug de code / test manquant / dérive d'architecture est la plus fragile. L'indicateur des deux lignes du tableau de réussite (lots avec une correction, avec deux) ne dépend pas de ce classement.
- **Le relevé n'est pas reproductible par `cadence corrections`** : la commande ne sait pas isoler « les lots qui ont une fiche ». Le décompte des passes et des tokens est fait par lecture directe des journaux (`kind: fix` et `status: ok` pour les passes ; `tokens.input + cacheWrite + output` des étapes abouties pour le coût).
