# Documents de référence (`cadence ref`) — design

Date : 2026-10-23. Statut : conception validée en séance (brainstorming), prête à découper (voir
« Plan de lots »). Aucun code livré par ce document.

## But

Les specs livrées sous forme de PDF portent une partie de leur information dans des images :
maquettes d'écran, tables rendues en image, gabarits de messages, schémas, figures d'une norme. Les
développements qui en sortent perdent régulièrement deux choses : **l'apparence** (proportions,
densité, taille des contrôles, couleurs, surfaces, typographie) et **le contenu fonctionnel** visible
seulement dans les images (composants, états vide / chargement / erreur / sans accès, règles,
comportements). Sur des specs de normes (WMO, ICAO…), où le texte domine, des erreurs ont déjà été
commises parce que le texte était ambigu et que la figure, non analysée, en donnait l'explication.

Constat de départ (un document de maquettes réel, privé, 26 pages d'images sans texte extractible) :
une lecture page par page par le modèle a produit un inventaire du contenu (« un panneau Layers, une
frise temporelle ») et rien de l'apparence ; la spec du projet ne citait pas le document ; l'écran
codé avait des contrôles surdimensionnés et des boutons translucides illisibles sur la carte.

Aujourd'hui, `spec-writer` dessine d'après la **charte du projet** (CSS, composants, `expectations.md`)
et rien dans son entrée ne prévoit un document de référence venu de l'extérieur. `cadence ref` comble
ce manque : il transforme un document en un **inventaire mesuré, identifié et vérifié**, que la fiche
du lot doit couvrir, et contre lequel l'écran livré est comparé.

## Décisions

| Sujet | Choix |
|---|---|
| Entrées | PDF de maquettes (pages-images), specs mixtes texte + images, images seules (PNG, JPG), schémas. |
| Déclenchement | Les deux : `cadence ref analyse <document>` à la main, et une étape `ref` de la vague quand un lot porte `refs:`. |
| Partage du travail | Le **programme** mesure, découpe, indexe, valide, compare ; le **modèle** interprète. Rien de mesurable n'est estimé à l'œil. |
| Robustesse | **Deux lectures indépendantes** par page (sessions séparées, modèles différents possibles), réconciliées par programme ; ce qui diverge devient `incertain`, jamais deviné. |
| Texte ↔ figure | Chaque figure est reliée aux passages qui la citent ; constat `confirme`, `precise` (la figure lève une ambiguïté du texte) ou `contredit` (question, pas de choix). |
| Traçabilité | **Couverture vérifiée** : chaque élément du périmètre du lot est repris par une règle de la fiche (`ref:`) ou écarté avec une raison (`ecartes:`). |
| Stockage | **Hors du dépôt** : `references.dir` de `cadence.yaml` (défaut : `references/` dans le dossier de données de cadence de l'utilisateur, `$XDG_DATA_HOME/cadence/`), un dossier par document. Le dépôt ne garde que le slug et l'empreinte. Un `references.dir` dans un dépôt Git est refusé. |
| Confidentialité | Rien ne sort de la machine hors des sessions du modèle déjà utilisées par la vague : aucun service d'OCR ou de vision en ligne. |
| Agents existants | `spec-writer`, `acceptance-writer`, `ux-reviewer` inchangés dans leur rôle ; ils reçoivent l'inventaire dans leur consigne. |

## Chaîne

```
                         ┌─ lecture A ─┐
ref add (programme) ─────┤             ├─ ref diff ─ troisième regard ─ inventaire.json
                         └─ lecture B ─┘                                   │
                                                                           ▼
                 lot avec écran :  spec → ref cover → revue UX maquette → accept → implement
                                   → ref compare + UX de conformité → revue de code
                 lot sans écran :  fiche → ref cover → accept → implement → revue de code
```

Chaque flèche entre étapes de session est une session neuve, comme le reste d'orchestrate.

### 1. Le programme `cadence ref`

Code dans `src/ref/`. Il appelle les outils du système — poppler (`pdftoppm`, `pdftotext -bbox`,
`pdfimages`), ImageMagick, tesseract — vérifiés au premier appel : un outil absent est nommé avec sa
commande d'installation, sortie 2, rien n'est installé d'office.

- `cadence ref add <document> [--sections …] [--slug …]` : enregistre le document (chemin, sha256,
  pages), rend les pages visées (200 dpi), extrait le texte positionné et les images incluses, et
  construit l'**index des figures** : légendes (« Figure n », « Table n »…), régions d'image, et leurs
  citations dans le texte (« see Figure 3.2 », « as shown below »). Sans `--sections`, sur un grand
  document, seul l'index (texte et figures) est construit, aucune page n'est rendue.
- `cadence ref measure <slug> <page> <zone> [--quoi couleurs|contraste|boites|texte]` : mesures d'une
  zone ramenées à la largeur de référence de l'écran (1440 px par défaut) ; couleurs échantillonnées
  (point ou moyenne d'un carré), rapports de contraste WCAG 2.2 (luminance relative), boîtes, OCR
  tesseract avec boîtes de mots et taille de police estimée (hauteur de capitale, marge déclarée).
- `cadence ref check <inventaire|lecture>` : validation du schéma (section 2), une ligne `✗` par
  violation, sorties 0 / 1 / 2 comme `cadence spec check`.
- `cadence ref diff <a> <b>` : réconciliation de deux lectures (section 3), ou de deux versions d'un
  document (deux empreintes).
- `cadence ref cover <fiche>` : couverture de la fiche (section 4).
- `cadence ref compare <slug> <écran> <captures…>` : écarts mesurés entre l'écran livré et
  l'inventaire (section 4).
- `cadence ref analyse <document> [--sections …]` : la chaîne complète hors vague (add, deux lectures,
  diff, troisième regard), pour un usage à la main.

Dossier d'un document, `<references.dir>/<slug>/` : `document.json` (source, empreinte, index des
figures et du texte), `pages/`, `crops/`, `lectures/a.json`, `lectures/b.json`, `inventaire.json`,
`rapport.md`.

### 2. L'inventaire (format)

Chaque élément a un id stable `<slug>#<type>-<n>`, une `source` et un `type`.

- `source` : page, zone en pixels de la page rendue (`x, y, l, h` à 200 dpi), et le cas échéant les
  passages du texte qui la citent (page, ligne, extrait exact).
- Types :
  - `ecran` : écran entier, largeur de référence, mise en page mesurée (zones en px à 1440 et en %) ;
  - `composant` : rôle, position, taille, contenu, écran parent ;
  - `etat` : vide, chargement, erreur, sans accès, sélectionné… et le composant ou l'écran concerné ;
  - `texte` : libellé, message ou unité **verbatim**, avec son rôle (titre, bouton, message d'erreur) ;
  - `jeton` : couleur, taille de police, espacement, rayon, opacité ; valeur mesurée, point
    d'échantillonnage, contraste calculé pour un couple texte / fond ;
  - `table` : table rendue en image, en lignes et colonnes, chaque cellule vérifiable ;
  - `gabarit` : gabarit de message (BUFR, TAC…), champs ordonnés avec bornes, obligatoire ou
    facultatif, format ;
  - `schema` : nœuds, flux, transitions, chacun avec libellé et direction ;
  - `lien` : figure ↔ passage, constat `confirme` | `precise` | `contredit` ; pour `precise`, la
    lecture ambiguë du texte, l'interprétation retenue et la raison tirée de la figure ; pour
    `contredit`, les deux énoncés, sans trancher ;
  - `statut` : badge de phase ou de périmètre recopié tel quel (« Proposal », « Phase 2 », « Fixture
    data ») et les éléments qu'il couvre ;
  - `silence` : ce que le document ne montre pas et qu'un développeur devra décider, rédigé en
    question.
- Confiance de chaque élément : `mesure` (calculé par `cadence ref measure`), `lu` (lu par le modèle,
  concordant entre les deux lectures), `incertain` (lectures divergentes ou image illisible, avec la
  cause), et la marque `ocr` pour un texte issu d'un OCR de page entière.

Côté fiche (`cadence spec check` étendu) : une règle gagne `ref: [<id>, …]` ; la fiche gagne
`references: [{slug, sha256}]` et `ecartes: [{ref, raison}]`.

### 3. Lectures et réconciliation

1. **Préparation (programme)** : `ref add` sur les sections visées par le lot, plus toute figure citée
   depuis ces sections, même ailleurs dans le document.
2. **Deux lectures indépendantes** (agent `reference-analyst`, deux sessions qui ne voient pas le
   travail l'une de l'autre, même consigne, mêmes pages) : chaque page regardée entière, puis chaque
   zone à pleine résolution (découpes produites par le programme) ; tout le mesurable par `ref
   measure` ; chaque figure reliée à ses citations avec son constat ; sortie validée par `ref check`
   avant de rendre la main. La seconde lecture peut tourner sur un autre modèle
   (`orchestrate.ref.lectures` dans `cadence.yaml`), pour le coût et pour décorréler les erreurs.
3. **Réconciliation (programme, puis une session courte)** : `ref diff` apparie par type, source et
   recouvrement de zone. Concordant → `lu` (ou `mesure`). Présent dans une seule lecture → **troisième
   regard** (session qui ne voit que ces éléments et leurs découpes : confirme ou écarte avec raison).
   Divergent → `incertain` avec les deux versions. Plus de 30 % d'éléments non appariés (seuil
   réglable) : pas de réconciliation, question au lead (document mal compris).
4. **Dans la vague** : l'étape `ref` s'arrête sur question seulement pour un `contredit` ou un
   `incertain` du périmètre du lot ; sinon elle passe à `spec` (lot avec écran) ou à `fiche` / `implement`
   (lot sans écran), l'inventaire dans la consigne.
5. **Réutilisation** : l'inventaire est rangé sous l'empreinte ; un autre lot qui cite le même document
   et les mêmes sections le reprend sans relire ; une nouvelle empreinte relance l'analyse, et
   `ref diff` entre versions donne ce qui a changé.

Champ du lot (posé à la planification, jamais déduit) : `refs: [{doc: <chemin>, sections: […]}]`
(`raf add … --ref <chemin>[#sections]`).

### 4. Couverture et conformité

**Couverture (`ref cover`, programme)**, sur le périmètre du lot (éléments des sections visées) :

- chaque écran, composant, état, texte, ligne de table, champ de gabarit, lien `precise` / `contredit`
  et silence est **repris** (cité par au moins une règle) ou **écarté** (`ecartes`, avec raison) ;
- les `jeton` sont couverts par écran : la fiche dit quel jeton du projet réalise chacun, ou l'écart ;
- une règle qui cite un `incertain` ou un `contredit` ne peut pas être `sourcee` : `hypothese` avec
  `si_faux`, ou question ;
- un `silence` repris devient une `hypothese` ou une question, jamais une règle sourcée.

Dans la vague, `ref cover` passe après `spec` (ou la fiche d'un lot sans écran) : une fiche incomplète
repart une fois à son auteur avec la liste, puis au lead. Les tests d'acceptation étant nommés d'après
les règles, chaque élément repris finit par un test.

**Conformité d'un lot avec écran (`ref compare`, programme, puis `ux-reviewer`)** : sur les captures de
l'application à la largeur de référence, les mêmes mesures que sur la maquette — boîtes des zones (en %
de l'écran), couleurs aux points équivalents, contrastes, textes par OCR. Sortie : tableau des écarts,
seuils réglables (défaut : ±10 % sur une proportion, ΔE > 5, texte différent, contraste sous le seuil
WCAG). `ux-reviewer` reçoit le tableau en plus de ses règles ; le programme mesure, l'agent dit ce qui
compte, le verdict reste au lead ou à l'humain selon `lead.ux`.

**Lot sans écran** : pas de comparaison d'images ; les lignes de table et champs de gabarit repris sont
vérifiés par les tests d'acceptation, et la revue de code contrôle que chaque règle `ref` a son test.

### 5. Erreurs et cas limites

- Dépendance absente : nommée avec sa commande d'installation, sortie 2.
- PDF chiffré, abîmé, sans page : refus avec la raison. PDF scanné sans couche texte : OCR de page
  entière, éléments marqués `ocr`, jamais `lu` sans la double lecture.
- Texte trop petit pour mesurer (< ~8 px au rendu) : nouveau rendu jusqu'à 400 dpi, puis `incertain`
  avec la cause.
- Figure sans légende, citation sans figure trouvée : listée « lien non résolu » dans `rapport.md` ;
  chaque lecture la résout ou la déclare introuvable.
- Session tombée, quota, lecture refusée par `ref check` : une reprise, puis rendu au lead ; quota :
  code 3 et `--resume`, comme les autres étapes.
- Document modifié en cours de route : empreinte vérifiée à chaque étape ; arrêt, jamais d'analyse
  sur deux versions mêlées.
- Taille : une lecture porte sur 20 pages au plus ; au-delà, plusieurs paires de lectures.

## Hypothèses

- H1 — Deux lectures indépendantes, dont une sur un autre modèle, décorrèlent assez les erreurs pour
  que le taux de faux `lu` baisse nettement par rapport à une lecture unique. *Si faux* : passer à
  trois lectures avec vote, ou à une API de vision appelée page par page (approche écartée « C »).
- H2 — tesseract (local) suffit pour les textes des maquettes et figures de normes à 200–400 dpi.
  *Si faux* : texte lu par le modèle seul, toujours en double lecture, marqué `lu` et non `mesure`.
- H3 — Le seuil de 30 % d'éléments non appariés sépare « document mal compris » de « détails ».
  *Si faux* : un réglage à changer, mesuré sur le corpus.
- H4 — Les seuils de conformité (±10 %, ΔE 5) ne noient pas `ux-reviewer` sous les écarts. *Si faux* :
  seuils par type de zone.

## Mesure : critère de réussite

Corpus (voir « Évaluation »), métriques par version : rappel et précision par type d'élément ; justesse
des constats `confirme` / `precise` / `contredit` ; erreur moyenne des mesures ; **taux de faux `lu`**
(élément marqué sûr et faux — la métrique la plus grave) ; tokens par page. Une version qui fait monter
le taux de faux `lu` ou baisser le rappel des liens `precise` ne sort pas.

Critère du chantier : sur le corpus synthétique, rappel ≥ 95 % des composants et états, 100 % des
pièges `precise` et `contredit` trouvés, faux `lu` ≤ 1 % ; sur l'essai réel, aucun élément du
périmètre du lot oublié en silence (`ref cover` vert), et un écran livré dont `ref compare` ne montre
plus d'écart de proportion ni de contraste au-delà des seuils.

## Évaluation

- **Tests du programme** (vitest), fixtures petites et commitées : `measure` (images générées, couleurs,
  boîtes et textes connus, tolérance déclarée), `check` (un cas par règle du schéma), `diff`
  (concordant, unique, divergent, divergence massive), `cover` (couvre, oublie, écarte, cite un
  `incertain` en `sourcee`), `compare` (captures décalées ou recolorées d'un écart connu).
- **Corpus synthétique à vérité connue**, `evals/ref/` : un générateur écrit des pages HTML, les rend en
  PDF et PNG (Playwright) et écrit l'inventaire attendu. Pièges, chacun tiré d'un défaut réel : texte
  ambigu que seule une figure lève ; figure qui contredit le texte ; table en image ; gabarit de type
  BUFR ; contrôle translucide sur fond chargé ; page « Proposal » parmi des pages exigées ; version
  scannée (rastérisée, bruitée).
- **Corpus public WMO** : documents cités par URL et sha256, téléchargés à l'évaluation, jamais
  commités ; passages choisis où la figure précise le texte, attendu écrit à la main pour ces passages.
- **Contrôle local privé** : documents non diffusables (maquettes de projets, normes ICAO), attendu hors
  du dépôt ; la commande d'évaluation prend un chemin local.

## Essai prévu

Un lot réel de revue UX avant code d'un écran carte, sur les pages carte d'un document de maquettes
privé de 26 pages-images : analyse, fiche, `ref cover`, puis `ref compare` avec les captures de l'écran
actuel comme point de départ (« avant ») et celles de l'écran repris (« après »).

## Plan de lots

1. `cadence ref add` : rendu, texte positionné, images incluses, index des figures et citations ;
   vérification des dépendances. Tests sur fixtures.
2. `cadence ref measure` : couleurs, contrastes WCAG, boîtes, OCR et taille de police estimée.
3. Schéma de l'inventaire et `cadence ref check` ; modèle `templates/inventaire.json`.
4. Générateur du corpus synthétique et commande d'évaluation (métriques ci-dessus), avant tout agent,
   pour mesurer dès la première lecture.
5. Agent `reference-analyst` et `cadence ref analyse` en lecture unique (mesure de référence sur le
   corpus).
6. Double lecture, `cadence ref diff`, troisième regard ; mesure comparée à la lecture unique (H1).
7. Fiche : `ref`, `references`, `ecartes` dans `cadence spec check` ; `cadence ref cover`.
8. Étape `ref` dans orchestrate : champ `refs` du lot (`raf add --ref`), questions, réutilisation par
   empreinte, couverture après `spec` / fiche.
9. `cadence ref compare` et son tableau dans la consigne de `ux-reviewer` (conformité).
10. Corpus public WMO (passages et attendus) ; contrôle local privé.

## Risques et ce qu'on ne fait pas

- **Coût** : deux lectures plus un troisième regard par page. Limité par le périmètre du lot (sections
  visées seulement), la réutilisation par empreinte et le second modèle moins cher ; mesuré en tokens
  par page à chaque version.
- **Dépendances système** (poppler, ImageMagick, tesseract) : requises seulement pour `cadence ref` ;
  le reste de cadence n'en dépend pas.
- On ne dessine pas : la maquette reste celle de `spec-writer`, l'inventaire en est l'entrée.
- On ne tranche pas : `contredit` et `incertain` sont des questions, jamais des choix silencieux.
- Pas d'API de vision hors des sessions, pas de service en ligne (approche « C », gardée pour le cas où
  H1 serait fausse).
- Pas de lecture de Figma ni d'outils de design : le document exporté (PDF, PNG) est l'entrée.


## Lot 1 : ce que `cadence ref add` livre (précisions de réalisation)

Code dans `src/ref/` (`tools.ts`, `store.ts`, `pdf.ts`, `figures.ts`, `add.ts`), documentation dans `docs/ref.md`.

- **Outils** : `pdftoppm`, `pdftotext`, `pdfimages`, `pdfinfo` (poppler, `sudo apt install poppler-utils`), `magick` ou `convert` (ImageMagick, `sudo apt install imagemagick`), `tesseract` (`sudo apt install tesseract-ocr`). Recherche dans le `PATH` de l'environnement de la commande, avant toute lecture du document. Un outil absent : une ligne par outil, avec sa commande d'installation, sortie 2, rien n'est installé ni écrit. ImageMagick n'est pas appelé par `ref add` (il sert à `ref measure`, lot 2) mais est vérifié dès le premier appel, comme le design le demande.
- **Entrée** : un PDF (images seules : lots suivants). Refus avec la raison pour un PDF chiffré, abîmé ou sans page.
- **Pages** : `--sections 3-5,9` (pages du PDF, 1 = première). Sans `--sections`, un document de 30 pages ou moins est rendu en entier ; au-delà, seul l'index (texte et figures) est construit. Les pages des figures citées depuis les pages visées sont rendues aussi, même ailleurs dans le document.
- **Rendu** : `pages/page-<n>.png` à 200 dpi (`pdftoppm -r 200`).
- **Texte positionné** : `pdftotext -bbox-layout` (mots avec boîtes, regroupés en lignes) pour toutes les pages ; coordonnées converties en pixels de la page rendue à 200 dpi (`x, y, l, h`).
- **Images incluses** : `pdfimages -list` pour toutes les pages, `pdfimages -png -p` pour les pages rendues (`images/`). Position de chaque image (région en pixels à 200 dpi) lue par `pdftohtml -xml`.
- **Index des figures** : une entrée par légende (`Figure n`, `Fig. n`, `Table n`, `Tableau n`, `Planche n`, en début de ligne), avec sa page, sa ligne, sa boîte, la ou les images de la page les plus proches, et ses **citations** (page, ligne, extrait exact : toute autre ligne qui nomme la figure, ou « as shown below / above », « ci-dessous / ci-dessus »). Une citation d'une figure sans légende, ou une figure sans citation, est listée « lien non résolu ». Une image sur une page sans légende l'est aussi (`image sans légende`). Le pluriel (`Figures 2 and 3`, `Tables 4 to 6`) cite chaque figure nommée.
- **Recettes de maritime-atlas reprises** (skill `norme-etude`, `refdoc.py index`) : vignettes de toutes les pages à 40 dpi (`thumbs/page-<n>.png`, pour repérer les planches hors du texte qui les cite) et détection des pages scannées (moins de 20 caractères de texte), signalée par `pages sans texte : n (plages)` dans la sortie. L'OCR de ces pages relève des lots suivants.
- **Stockage** : `<references.dir>/<slug>/document.json` (source, sha256, pages, outils, index), `pages/`, `images/`. `references.dir` de `cadence.yaml`, défaut `$XDG_DATA_HOME/cadence/references` (sinon `~/.local/share/cadence/references`) ; un dossier dans un dépôt Git est refusé (sortie 2). Un slug déjà pris par un autre document (autre empreinte) est refusé ; le même document relancé complète les pages rendues.
- **Sortie** : lignes `slug`, `pages`, `rendues`, `figures`, `liens non résolus`, dossier. Sorties 0 / 2.
