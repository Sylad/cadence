# `cadence ref analyse` en lecture unique — mesure de référence sur le corpus synthétique (L265, issue #14, 5/10)

Date : 24 et 25 octobre 2026. Version mesurée : `a532af3` (`feat(L265): cadence ref analyse …`). Modèle de la lecture : `sonnet` (Claude Code 2.1.293),
une session par document, effort et mode de permission par défaut d'orchestrate. Cette mesure est **la ligne de base** que la double lecture (lot 6, point d'arrêt H1) devra battre :
une version qui fait monter le faux `lu` ou baisser le rappel des liens `precise` ne sort pas (design §« Mesure »).

## Ce qui est mesuré, et comment le refaire

```
cadence ref corpus tmp/mesure/corpus                      # 7 cas, 8 pages, 47 éléments attendus (Playwright)
mkdir tmp/mesure/docs-lus && cp tmp/mesure/corpus/<cas>/document.pdf tmp/mesure/docs-lus/<cas>.pdf
cadence ref analyse tmp/mesure/docs-lus/<cas>.pdf --slug corpus-<cas>     # une lecture par cas
mkdir -p tmp/mesure/lectures/<cas> && cp <references.dir>/corpus-<cas>/lectures/a.json tmp/mesure/lectures/<cas>/lecture.json
cadence ref eval tmp/mesure/corpus tmp/mesure/lectures
```

Les PDF sont **copiés hors du dossier du corpus** avant la lecture : `document.json` garde le chemin du PDF lu, et le dossier voisin d'un corpus porte `attendu.json`. Le journal des sept sessions ne contient
aucune ouverture d'un `attendu.json` ni du dossier du corpus (les occurrences du mot « attendu » sont le message d'erreur de `ref measure`) : aucune lecture n'a eu la réponse sous la main.

Conditions de l'essai, pour être honnête sur ce qui a été fait : ImageMagick n'était pas installé sur la machine ; `ref add` n'en vérifie que la présence (il ne l'appelle pas), un faux `magick` a donc été mis en tête du `PATH` pour cet essai, sans effet sur la lecture.
Le corpus a été rendu avec Playwright 1.61.1 et le Chromium déjà présent. Les commandes `cadence ref measure` de l'agent tournaient sur un paquet construit depuis le commit mesuré (comme `test/global-setup.ts`).
Une seule passe par cas : la variance d'une session à l'autre n'est **pas** mesurée (un seul tirage).

## Résultat

```
7 cas · 47 éléments attendus · 93 lus
rappel : 80.9 % (38/47) · précision : 40.9 % (38/93)
faux lu : 44.1 % (30/68 sûrs)
tokens par page : 26825.8 (214606 sur 8 pages)
par type :
  ecran      rappel 100 % (2/2) · précision 50 % (2/4) · faux lu 2/4
  composant  rappel 60 % (3/5) · précision 60 % (3/5) · faux lu 2/5
  etat       rappel 0 % (0/2) · précision n/a (0/0) · faux lu 0/0
  texte      rappel 93.3 % (28/30) · précision 93.3 % (28/30) · faux lu 2/30
  jeton      rappel 50 % (1/2) · précision 4.5 % (1/22) · faux lu 21/22
  table      rappel 100 % (1/1) · précision 50 % (1/2) · faux lu 1/2
  gabarit    rappel 100 % (1/1) · précision 100 % (1/1) · faux lu 0/1
  lien       rappel 66.7 % (2/3) · précision 66.7 % (2/3) · faux lu 1/3
  statut     rappel 0 % (0/1) · précision 0 % (0/1) · faux lu 1/1
  silence    rappel n/a (0/0) · précision 0 % (0/25) · faux lu 0/0
pièges :
  ✗ controle-translucide : 0/1
  ✓ figure-contredit-texte : 1/1
  ✓ gabarit-type-bufr : 1/1
  ✗ page-proposal : 0/1
  ✓ scan-bruite : 4/4
  ✓ table-en-image : 1/1
  ✓ texte-ambigu-leve-par-figure : 1/1
```

| Cas | Pages | Éléments lus (mesure / lu / incertain) | Tokens | Tokens par page |
|---|---|---|---|---|
| texte-ambigu-leve-par-figure | 1 | 11 (1 / 7 / 3) | 29 577 | 29 577 |
| figure-contredit-texte | 1 | 13 (4 / 6 / 3) | 28 752 | 28 752 |
| table-en-image | 1 | 8 (1 / 5 / 2) | 23 393 | 23 393 |
| gabarit-type-bufr | 1 | 9 (3 / 3 / 3) | 28 250 | 28 250 |
| controle-translucide | 1 | 15 (8 / 2 / 5) | 32 253 | 32 253 |
| page-proposal | 2 | 26 (10 / 10 / 6) | 43 346 | 21 673 |
| scan-bruite | 1 | 11 (4 / 4 / 3) | 29 035 | 29 035 |
| **Total** | **8** | **93** | **214 606** | **26 826** |

Les tokens sont ceux de la session (entrée + écriture de cache + sortie ; la lecture de cache n'est pas comptée, comme dans le budget d'orchestrate). Durée : une page, environ 50 secondes.

## Lecture des chiffres

**Contre le critère du chantier** (design §« Mesure » : rappel ≥ 95 % des composants et états, 100 % des pièges `precise` et `contredit`, faux `lu` ≤ 1 %) :

| Critère | Seuil | Lecture unique | Verdict |
|---|---|---|---|
| Rappel des composants et des états | ≥ 95 % | 42,9 % (3/7 : composants 3/5, états 0/2) | ✗ |
| Pièges `precise` et `contredit` trouvés | 100 % | 2/2 (`texte-ambigu-leve-par-figure`, `figure-contredit-texte`) | ✓ |
| Faux `lu` | ≤ 1 % | 44,1 % (30/68) ; 19,6 % (9/46) sans les jetons | ✗ |

**Le faux `lu` est surtout du jeton.** 21 des 30 faux `lu` sont des jetons `mesure` qui n'ont pas d'équivalent dans l'attendu : l'agent mesure beaucoup de couleurs, le corpus n'attend que les jetons des pièges (une opacité, une couleur de bouton). Ce sont des éléments *en trop* (précision 4,5 %), pas
forcément faux : `ref eval` ne sait pas dire « mesuré et juste, mais non attendu » et le compte comme faux `lu`. Hors jetons, le faux `lu` est de 9/46 (19,6 %) : deux écrans en trop, deux composants, deux textes, une table en trop, un lien en trop (celui de `table-en-image`), le statut. À lui seul il dépasse déjà de loin le seuil de 1 %.
La précision de 40,9 % vient pour le reste des 25 `silence` écrits, dont aucun n'est attendu (ils sont `incertain`, donc jamais faux `lu`).

**Ce qui manque, nommément** (les trois `✗` sont des cas où l'agent a lu autre chose que ce qui est dessiné) :

- `controle-translucide` : aucun jeton `opacite` (0.25) — l'agent a mesuré des couleurs (`#1e3a8a`, `#ffffff`…) et pas la translucidité du bouton blanc sur le fond rayé ;
- `page-proposal` : **aucun `etat`** (`selectionne`, `desactive`) alors que les deux lignes sont dessinées sélectionnée et grisée ; le `statut` « Proposal » est lu (trouvé par son libellé), mais ne couvre pas les mêmes éléments que l'attendu ; deux composants de l'ensemble du corpus sur cinq ne sont pas retrouvés (la mesure ne dit pas lesquels) ;
- les liens : `precise` et `contredit` sont trouvés, mais `page-proposal` ne porte aucun lien, alors que sa légende confirme une exigence (lien : 2/3).

**Tokens par page : 26 826** en moyenne (21 673 à 32 253 selon la page). Une page de ce corpus est une page HTML simple ; une page de norme dense en figures coûtera plus : à lire comme un plancher.

## Plafond déclaré

Une lecture porte sur **20 pages rendues au plus** (`LECTURE_PAGES_MAX`, design §5). Ce plafond est une règle du programme (refus avant toute session, exit 2), pas un résultat de cette mesure : le corpus ne contient
aucun cas de plus de 2 pages, **le comportement à 20 pages n'a donc pas été mesuré** (ni le rappel, ni le temps, ni la fenêtre de contexte). À 27 000 tokens par page, une lecture pleine se chiffrerait autour de 540 000 tokens : une
extrapolation linéaire sans mesure à l'appui, et sans doute basse (le contexte s'accumule d'une page à l'autre). La question à mesurer au lot 10 (documents réels) : le rappel d'une lecture de 20 pages contre celui de la même lecture en deux fois 10 pages.

## Ce que la mesure a aussi montré

- Trois appels sur une centaine de `cadence ref measure` ont été refusés (« zone invalide : « 1 » ») : la consigne écrit `<page> <page | x,y | x,y,l,h>` et l'agent a pris la page pour la zone avant de se corriger. Un exemple par forme de zone dans la consigne le lèverait ; non fait ici pour que la consigne mesurée soit celle du commit.
- Les `silence` sont abondants (25 sur 7 cas) et tous hors attendu : `ref eval` ne les note pas. À décider (lot 6 ou 7) : les attendre dans le corpus, ou ne pas les compter dans la précision.
- La lecture n'est pas lue deux fois : les `incertain` (25 sur 93, tous des `silence`) sont la seule trace de doute ; aucun élément `lu` ou `mesure` n'est marqué incertain. La double lecture du lot 6 se mesure d'abord sur le faux `lu` des jetons et sur les états de `page-proposal`.
