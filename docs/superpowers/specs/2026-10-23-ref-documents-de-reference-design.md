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

- **Outils** : `pdftoppm`, `pdftotext`, `pdfimages`, `pdfinfo` (poppler, `sudo apt install poppler-utils`), `magick` ou `convert` (ImageMagick, `sudo apt install imagemagick`), `tesseract` (`sudo apt install tesseract-ocr`). Recherche dans le `PATH` de l'environnement de la commande, avant toute lecture du document. Un outil absent : une ligne par outil, avec sa commande d'installation, sortie 2, rien n'est installé ni écrit. ImageMagick n'est appelé ni par `ref add` ni par `ref measure` (qui décode les PNG lui-même et ne lance que tesseract) mais est vérifié dès le premier appel, comme le design le demande.
- **Entrée** : un PDF (images seules : lots suivants). Refus avec la raison pour un PDF qui demande un mot de passe ou dont la copie est interdite (un PDF chiffré dont la copie est permise est lu), pour un fichier abîmé ou qui n'est pas un PDF, et pour un PDF sans aucune page.
- **Pages** : `--sections 3-5,9` (pages du PDF, 1 = première). Sans `--sections`, un document de 30 pages ou moins est rendu en entier ; au-delà, seul l'index (texte et figures) est construit. Les pages des figures citées depuis les pages visées sont rendues aussi, même ailleurs dans le document.
- **Rendu** : `pages/page-<n>.png` à 200 dpi (`pdftoppm -r 200`).
- **Texte positionné** : `pdftotext -bbox-layout` (mots avec boîtes, regroupés en lignes) pour toutes les pages ; coordonnées converties en pixels de la page rendue à 200 dpi (`x, y, l, h`).
- **Images incluses** : `pdfimages -list` pour toutes les pages, `pdfimages -png -f n -l n <pdf> <dossier>/p<n>` pour chaque page rendue qui porte des images (`images/p<page>-<nnn>.png`, `-p` n'est pas utilisé : il changerait les noms de fichiers). Position de chaque image (région en pixels à 200 dpi) lue par `pdftohtml -xml`.
- **Index des figures** : une entrée par légende (`Figure n`, `Fig. n`, `Table n`, `Tableau n`, `Planche n`, en début de ligne). **Forme de légende** : après un séparateur (`—`, `–`, `:`, `.`, `-`) c'est une légende, quelle que soit la casse du titre (`Figure 1 — map of stations`) ; sans séparateur, une minuscule (`Figure 3 shows…`), une virgule ou une parenthèse après le numéro (`Figure 5, which…`, `Figure 5 (page 4) and…`) en font une citation, sauf une ligne faite UNIQUEMENT du numéro et d'une parenthèse fermée (`Table IV.3 (in accordance with 4.3.11)`, WMO-No. 49 vol. II), qui est une légende quand aucune autre ligne de forme de légende n'existe pour ce numéro (avec une autre, ou parenthèse ouverte comme `Table 11 (see Example…`, c'est une citation) ; un séparateur suivi d'un titre vide (`figure 24.` en fin de phrase) n'est pas une légende. **Sommaire** : une ligne de sommaire n'est ni une légende ni une citation — points de conduite sur la ligne ou sur la suivante, ou toute ligne d'une page de sommaire (au moins deux lignes, et plus de la moitié, à points de conduite ou de forme de légende finissant par un numéro de page possible, lu dans le titre : le numéro de la figure n'en est pas un). Un numéro final seul ne fait jamais une entrée : `Table 4.1. … presented in Chapter 4` au milieu de la prose est une légende ; ce que les entrées de sommaire nomment sort donc en « figure que rien ne cite » tant que le corps du document ne la cite pas. **Plusieurs lignes de forme de légende** pour une même figure (prose coupée en début de ligne : `Table 3 Identifies the…`) : parmi celles qui ont un titre (`Figure 5 Jet speed` plutôt que `Figure 5` seul), s'il y en a, la première sur une page qui porte une image, à défaut la première qui a un séparateur, à défaut la première du document (la distance à l'image dans la page n'est pas mesurée : les régions ne sont connues que des pages rendues, après l'index). Chaque entrée a sa page, sa ligne, sa boîte, la ou les images de la page les plus proches, et ses **citations** (page, ligne, extrait exact : toute autre ligne qui nomme la figure, ou « as shown below / above », « ci-dessous / ci-dessus »). Une citation d'une figure sans légende, ou une figure sans citation, est listée « lien non résolu ». Une image sur une page sans légende l'est aussi (`image sans légende`). Le pluriel (`Figures 2 and 3`, `Tables 4 to 6`) cite chaque figure nommée.
- **Recettes de maritime-atlas reprises** (skill `norme-etude`, `refdoc.py index`) : vignettes de toutes les pages à 40 dpi (`thumbs/page-<n>.png`, pour repérer les planches hors du texte qui les cite) et détection des pages scannées (moins de 20 caractères de texte), signalée par `pages sans texte : n (plages)` dans la sortie. L'OCR de ces pages relève des lots suivants.
- **Stockage** : `<references.dir>/<slug>/document.json` (source, sha256, pages, outils, index), `pages/`, `images/`. `references.dir` de `cadence.yaml`, défaut `$XDG_DATA_HOME/cadence/references` (sinon `~/.local/share/cadence/references`) ; un dossier dans un dépôt Git est refusé (sortie 2). Un slug déjà pris par un autre document (autre empreinte) est refusé ; le même document relancé complète les pages rendues.
- **Sortie** : lignes `slug`, `pages`, `rendues`, `figures`, `liens non résolus`, dossier. Sorties 0 / 2.

## Lot 5 : ce que `cadence ref analyse` livre (précisions de réalisation)

Code dans `src/ref/analyse.ts`, agent dans `agents/reference-analyst.md`, documentation dans `docs/ref.md`.

- **Chaîne en lecture unique** : `add` (mêmes options), puis UNE session neuve de l'agent `reference-analyst` (`claude -p`, via `runSession` d'orchestrate : sortie JSON, schéma, relance de mise en forme, relance d'une session coupée, bac à sable sans accès à la production), puis la validation par le programme. Modèle `sonnet` par défaut, `--model sonnet|opus|haiku` ; effort de la revue (`orchestrate.effort.review`) et mode de permission de `orchestrate` dans `cadence.yaml`. Le binaire est `claude` du `PATH` ou `CADENCE_CLAUDE_BIN`.
- **Sortie** : `<references.dir>/<slug>/lectures/a.json` (la lecture A du design ; `b.json` est écrit par la double lecture du lot 6, `--unique` garde la lecture unique), `genre: "lecture"`, schéma de `ref check`. Le programme ne se fie pas au rapport de l'agent : le fichier doit exister (celui d'un passage précédent est supprimé avant la session), passer `ref check`, être une `lecture` et porter le `slug` et le `sha256` du document lu ; sinon code 1, écarts sur la sortie standard, rien n'est mesuré.
- **Jetons** : le programme écrit `usage: { tokens, modele, session }` dans la lecture (`tokens` = entrée + écriture de cache + sortie de la session, le compte du budget d'orchestrate ; la lecture de cache n'y est pas), que `ref eval` lit pour les tokens par page. L'agent n'écrit jamais `usage`.
- **Plafond déclaré** : 20 pages rendues par lecture (`LECTURE_PAGES_MAX`, §5 « Taille »). Au-delà, ou sans aucune page rendue : refus avant toute session (sortie 2) avec la commande `--sections` ; le découpage en plusieurs lectures n'est pas fait (lot 6 et suivants). Les pages lues sont les pages rendues du document (`--sections`, figures citées, rendus d'un appel précédent).
- **Pas d'attendu** : la consigne ne nomme ni attendu ni corpus ; l'agent a pour consigne de ne lire que le dossier du document, le modèle d'inventaire et les pages. Limite : `document.json` garde le chemin du PDF d'origine, et rien n'empêche techniquement de lire le dossier voisin, où un corpus rangerait son `attendu.json` : la mesure de référence se fait sur un corpus copié hors de ce dossier voisin (voir `docs/mesures/ref-lecture-unique-2026-10-24.md`).
- **Sorties** : 0 lecture valide, 1 lecture refusée, 2 refus (modèle, plafond, aucune page, session en échec), 3 quota. Pas de reprise sur une lecture refusée par `ref check` : elle revient à l'appelant (la reprise, la réutilisation par empreinte et les questions sont l'étape `ref` d'orchestrate, lot 8).

## Lot 6 : ce que la double lecture livre (précisions de réalisation)

Code dans `src/ref/diff.ts` (réconciliation), `src/ref/regard.ts` (troisième regard), `src/ref/session.ts` (une session de la chaîne), `src/ref/analyse.ts` (la chaîne) ; agents `reference-analyst` (inchangé hors la défense de lire `lectures/`) et `reference-verifier` ; documentation dans `docs/ref.md`.

- **Deux lectures** : `ref analyse` lance ensemble deux sessions neuves de `reference-analyst`, A sur `--model` (`sonnet`), B sur `--model-b` (`opus`, un autre modèle pour décorréler, H1). Même consigne au fichier près (`lectures/a.json`, `lectures/b.json`), qui défend d'ouvrir un autre fichier de `lectures/`. L'indépendance repose sur cette consigne, pas sur un bac à sable : rien n'empêche techniquement une session de lire le fichier de l'autre. `--unique` garde la lecture unique de L265. `orchestrate.ref.lectures` (le modèle de B dans `cadence.yaml`) n'est pas fait : c'est l'étape `ref` d'orchestrate (lot 8) ; les options de la commande en tiennent lieu.
- **`ref diff <a> <b>`** : apparie par type, page, identité (celle de `ref eval`) et recouvrement de zone (intersection sur union ≥ 0,5) ; concordant (même identité, même affirmation → un élément `lu`, `mesure` si l'une des lectures a mesuré, un doute reste un doute), divergent (même identité et autre affirmation, ou même zone et autre identité → `incertain`, les deux versions dans la cause), seul. Les silences sont réunis (une question une fois) hors du troisième regard et du calcul du seuil. Plus de 30 % de seuls (`--seuil`, pour cent) : code 1, question au lead, rien d'écrit. Deux empreintes différentes : refus (code 2) ; la comparaison de deux versions d'un document (design §1) n'est pas faite ici, elle vient avec la réutilisation par empreinte (lot 8).
- **Troisième regard** : une session de `reference-verifier` (lecture seule) qui ne voit que les éléments d'une seule lecture, chacun avec la page rendue et sa découpe (`crops/regard-<n>.png`, zone + 24 px), et dit `confirme` ou `ecarte` avec une raison. Un divergent n'y va pas (il est déjà une question). Confirmé : l'élément garde sa confiance ; écarté : il disparaît avec ce qui n'existe plus sans lui ; sans réponse valable : `incertain`, jamais `lu`.
- **Sortie** : `inventaire.json` (genre `inventaire`, valide pour `ref check`) avec `usage` (total des trois sessions et détail) et `reconciliation` (comptes, part de non appariés, verdicts) ; chaque lecture garde son `usage`. La mesure comparée à la lecture unique est dans `docs/mesures/ref-double-lecture-2026-10-25.md`.
