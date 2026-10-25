# `cadence ref analyse` en double lecture — mesure comparée à la lecture unique (L266, issue #14, 6/10)

Date : 25 octobre 2026. Version mesurée : `b08a6f6` (`feat(L266): cadence ref analyse en double lecture …` ; le commit suivant ne change que le décodage des pages du troisième regard, sans effet sur les sorties). Lecture A : `sonnet`, lecture B : `opus`, troisième regard : `sonnet`
(Claude Code 2.1.293), effort et mode de permission par défaut d'orchestrate. C'est le **point d'arrêt H1** du chantier : les lots 7 à 10 ne partent que si la double lecture baisse nettement le faux `lu` et garde le rappel des liens `precise`.
**Cette page donne les chiffres ; la décision est celle du lead, notée sur l'issue #14.**

## Ce qui est mesuré, et comment le refaire

```
cadence ref corpus tmp/mesure/corpus                      # 7 cas, 8 pages, 47 éléments attendus (Playwright)
mkdir tmp/mesure/docs-lus && cp tmp/mesure/corpus/<cas>/document.pdf tmp/mesure/docs-lus/<cas>.pdf
cadence ref analyse tmp/mesure/docs-lus/<cas>.pdf --slug corpus-<cas> --double     # double lecture (`--double` : au moment de la mesure c'était le défaut) ; --seuil 100 pour les cas refusés à 30 %
# trois jeux, un cas par sous-dossier (<cas>/lecture.json) : lectures/a.json, lectures/b.json, inventaire.json
cadence ref eval tmp/mesure/corpus tmp/mesure/jeu-a        # A seule = une lecture unique en sonnet
cadence ref eval tmp/mesure/corpus tmp/mesure/jeu-b        # B seule = une lecture unique en opus
cadence ref eval tmp/mesure/corpus tmp/mesure/jeu-d        # la double lecture réconciliée
```

**La comparaison est appariée** : A est une lecture unique en sonnet (la même consigne, à une phrase près : la défense d'ouvrir un autre fichier de `lectures/`), B une lecture unique en opus, la double lecture réconcilie les deux **des mêmes sessions**. Les trois lignes
se comparent donc sur les mêmes lectures, sans écart de tirage entre elles. Les PDF sont copiés hors du dossier du corpus (voir la mesure de référence) ; rien dans la consigne ne nomme un attendu.

Conditions, pour être honnête sur ce qui a été fait :

- ImageMagick n'était pas installé : un faux `magick` en tête du `PATH` (comme pour la mesure de référence), sans effet sur la lecture.
- **Une seule passe par cas** : la variance d'une session à l'autre n'est pas mesurée. Elle n'est pas négligeable : la lecture A de cet essai trouve les 3 liens attendus (rappel des liens 100 %), la lecture unique de la mesure de référence (même consigne ou presque, autre tirage) en trouvait 2 sur 3 (66,7 %).
- **Trois cas sur sept ont été refusés au seuil de 30 %** au premier passage (`controle-translucide` 41,7 % de non appariés, `gabarit-type-bufr` 60 %, `scan-bruite` 41,7 %) : code 1, question au lead, pas d'inventaire. Pour avoir une double lecture complète sur les sept cas, ces trois ont été **relancés avec `--seuil 100`** : leurs lectures A et B,
  leurs chiffres et le troisième regard sont ceux de ce **second tirage** (le premier est écarté, ses lectures ne sont pas évaluées). Les quatre autres cas sont du premier passage, au seuil par défaut.
- Le corpus est le même que celui de la mesure de référence (7 cas, 8 pages, 47 éléments attendus) mais **régénéré** : mêmes attendus, autres PDF (autre empreinte), donc un autre tirage de lecture.

## Résultat

| | A seule (sonnet) | B seule (opus) | **Double lecture** | Référence L265 (sonnet, autre tirage) |
|---|---|---|---|---|
| Éléments lus | 86 | 117 | 139 | 93 |
| Rappel | 83,0 % (39/47) | 78,7 % (37/47) | **83,0 % (39/47)** | 80,9 % (38/47) |
| Précision | 45,3 % | 31,6 % | **28,1 %** | 40,9 % |
| **Faux `lu`** | 37,7 % (23/61) | 53,2 % (42/79) | **50,7 % (38/75)** | 44,1 % (30/68) |
| Faux `lu` hors jetons et silences | 22,9 % (11/48) | 23,4 % (11/47) | **21,7 % (10/46)** | n/a |
| Rappel des liens (`precise`, `contredit`, `confirme`) | 3/3 | 2/3 | **3/3** | 2/3 |
| Pièges `precise` et `contredit` | 2/2 | 2/2 | **2/2** | 2/2 |
| Tokens par page | 22 375 | 29 375 | **63 250** (2,8 × A) | 26 826 |

(`ref eval` : « faux lu » = éléments marqués `mesure` ou `lu` qui ne retrouvent pas un attendu à l'identique, sur les sûrs ; la ligne « hors jetons et silences » est calculée sur les comptes par type de `--json`.)

**Contre le critère du chantier** (rappel ≥ 95 % des composants et états, 100 % des pièges `precise` et `contredit`, faux `lu` ≤ 1 %) :

| Critère | Seuil | A seule | Double lecture |
|---|---|---|---|
| Rappel des composants et des états | ≥ 95 % | 42,9 % (3/7) | 42,9 % (3/7) |
| Pièges `precise` et `contredit` | 100 % | 2/2 | 2/2 |
| Faux `lu` | ≤ 1 % | 37,7 % | 50,7 % |

## Lecture des chiffres

**H1 n'est pas démontrée sur ce corpus, et le chiffre principal va dans le mauvais sens.** Le faux `lu` de la double lecture (50,7 %) est **plus haut** que celui de A seule (37,7 %), pas « nettement meilleur » ; le rappel est le même (83 %) ; le rappel des liens `precise` est maintenu (2/2 pièges, 3/3 liens),
mais il l'était déjà en A seule. Le coût est multiplié par 2,8 (63 250 tokens par page contre 22 375).

**Pourquoi le faux `lu` monte.** Deux effets, que la mesure sépare :

- **Les jetons**. 28 des 38 faux `lu` de la double lecture sont des jetons `mesure` (couleurs échantillonnées par `ref measure`) qui n'ont pas d'équivalent dans l'attendu (le corpus n'attend que les jetons des pièges). Les deux lectures mesurent beaucoup de couleurs (A : 13, B : 33) ; quand elles concordent
  l'élément reste `mesure`, quand une seule le porte le troisième regard le **confirme** (il mesure lui aussi, et la couleur est juste). Ce sont des éléments *en trop* et justes, que `ref eval` compte comme faux `lu` (même remarque que la mesure de référence) : la double lecture en réunit davantage
  (29 jetons lus contre 13 pour A) et le taux monte mécaniquement. **La métrique ne dit pas si ces jetons sont faux.**
- **Le troisième regard confirme presque tout** : sur 30 éléments portés par une seule lecture, 24 confirmés et 6 écartés (`controle-translucide` 6/2, `gabarit-type-bufr` 3/1, `page-proposal` 5/3, tous les autres 100 % confirmés). Il écarte ce qui n'est manifestement pas dessiné ; il ne départage pas un composant en trop,
  un écran en trop ou un statut mal couvert. Sur `scan-bruite`, il confirme les 3 éléments d'une seule lecture et le faux `lu` hors jetons du cas passe de 1/5 à 3/7.

**Hors jetons et silences, la double lecture ne change presque rien** : 21,7 % (10/46) contre 22,9 % (11/48) pour A et 23,4 % (11/47) pour B, et le même rappel (38/45). Le cas où elle aide est `page-proposal` (faux `lu` hors jetons 7/16 → 4/13), celui où elle gêne `scan-bruite` (1/5 → 3/7) : un écart de 1 à 3 éléments sur un
seul tirage, dans le bruit de la variance d'une lecture à l'autre.

**Ce que la double lecture ne résout pas** (les trois `✗` de la mesure de référence restent, nommément) : `controle-translucide` (aucun jeton `opacite`, ni en A ni en B), `page-proposal` (aucun `etat` : ni `selectionne` ni `desactive`, ni en A ni en B), le `statut`. Deux modèles qui font la même
erreur ne se corrigent pas : **les erreurs de ce corpus sont corrélées** (même consigne, mêmes outils, mêmes points aveugles), ce qui est précisément ce que H1 supposait faux. Un autre modèle ne suffit pas à les décorréler ici.

**Le seuil de 30 % non apparié (H3)** : 3 cas sur 7 le dépassent au premier passage (41,7 %, 60 %, 41,7 %), les autres sont à 22–29 % (22,2 ; 27,3 ; 27,6 ; 28,6). Sur ce corpus, le seuil de 30 % sépare mal « document mal compris » de « détails » : les trois refus portent sur des pages de 5 à 12 éléments,
où deux ou trois éléments de plus d'un côté suffisent (une page de maquette simple, lue par deux modèles qui ne mesurent pas les mêmes couleurs). Les seuls y sont des jetons mesurés et des composants nommés autrement, pas un document mal compris. À régler avec le lead (un seuil absolu en plus du seuil relatif, ou les jetons
hors du calcul).

## Tokens

| Cas | Pages | A | B | Troisième regard | Total | Par page |
|---|---|---|---|---|---|---|
| texte-ambigu-leve-par-figure | 1 | 26 716 | 27 949 | 8 833 | 63 498 | 63 498 |
| figure-contredit-texte | 1 | 22 664 | 28 111 | 11 996 | 62 771 | 62 771 |
| table-en-image | 1 | 26 091 | 28 669 | 10 827 | 65 587 | 65 587 |
| gabarit-type-bufr | 1 | 19 087 | 25 933 | 10 396 | 55 416 | 55 416 |
| controle-translucide | 1 | 26 889 | 44 459 | 15 012 | 86 360 | 86 360 |
| page-proposal | 2 | 37 219 | 44 828 | 23 904 | 105 951 | 52 976 |
| scan-bruite | 1 | 20 332 | 35 050 | 11 034 | 66 416 | 66 416 |
| **Total** | **8** | **179 000** | **235 000** | **92 000** | **506 000** | **63 250** |

Même compte que la mesure de référence (entrée + écriture de cache + sortie ; la lecture de cache n'y est pas). Le troisième regard coûte environ 18 % du total ; la lecture B en opus 46 %.

## Ce que cette mesure ne dit pas

- **La variance** : un seul tirage par cas, et la mesure de référence montre déjà un écart de 33 points sur le rappel des liens entre deux tirages d'une même lecture. Un écart d'un à trois éléments ne se lit pas ici.
- **La justesse des jetons** : tant que `ref eval` compte comme faux `lu` un jeton mesuré juste mais non attendu, le faux `lu` global dépend du nombre de couleurs mesurées, pas de la justesse des lectures. Une comparaison plus fidèle attend les jetons dans le corpus, ou un compte « mesuré et juste, non attendu » à part.
- **Un autre modèle pour B** (`haiku`, ou `sonnet` avec une consigne différente) et **un autre troisième regard** (opus, ou un verdict qui exige une mesure) ne sont pas essayés. Le premier est une option (`--model-b`) ; le second une modification de l'agent.
- **Le plafond de 20 pages** n'est toujours pas mesuré (le corpus n'a pas de cas de plus de 2 pages).

## Décision (25 octobre 2026, le lead)

**H1 n'est pas tenue** (faux `lu` 50,7 % contre 37,7 % en lecture unique, même rappel, 2,8 fois les tokens, erreurs corrélées) : les lots 7 à 10 (L267 à L270) sont abandonnés. Le design dit qu'une version qui fait monter le taux de faux `lu` ou baisser le rappel des liens `precise` ne sort pas : **le défaut de
`cadence ref analyse` reste la lecture unique** (celui de L265). La double lecture, la réconciliation (`cadence ref diff`) et le troisième regard restent disponibles sur option, `--double`, que `docs/ref.md` documente comme une option dont la mesure n'a pas montré de gain. Ce que cette page ne tranche pas (la variance sur un seul tirage, la justesse des jetons, un autre modèle pour B,
un seuil absolu) reste ouvert.
