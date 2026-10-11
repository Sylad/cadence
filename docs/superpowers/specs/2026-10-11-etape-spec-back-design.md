# Étape spec pour les lots sans écran (back) — design

Date : 2026-10-11. Statut : conception, prête à découper (voir « Plan de lots »). Aucun code livré par
ce document. Exemple de fiche : [`2026-10-11-etape-spec-back-fiche-exemple.yaml`](2026-10-11-etape-spec-back-fiche-exemple.yaml),
gardé par `test/etape-spec-back-fiche.test.ts`. Ce design **complète**
[celui de l'étape spec d'un écran](2026-10-10-etape-spec-design.md) (1.1.0) sans le remplacer : tout ce qu'il
ne dit pas ici est inchangé (statuts `sourcee` / `hypothese`, question ciblée, tests rouges et verrou,
revue règle → test → vert).

## But

Consigne de Sylvain, le 11-10 : « même pour la partie back il faut spécifier d'abord ; juste il n'y a pas
la partie visuelle, mais reste la spec, les cas d'utilisation, les règles de gestion à respecter ».

L'étape spec de 1.1.0 ne s'ouvre que pour un lot qui déclare `screen:`. Or les lots qui se corrigent le plus
sont ailleurs : dans la mesure de départ ([`docs/mesures/corrections-2026-10-10.md`](../../mesures/corrections-2026-10-10.md)),
les **208 lots non visibles** ont **65 %** (135) d'au moins une passe de correction et **29 %** (61) d'au
moins deux, pour 208 passes, contre 45 % et 25 % pour les 55 lots visibles. Même mécanisme que sur un écran :
les cas d'usage, les cas d'erreur et les règles sont découverts **pendant** le code ; l'implémenteur les
invente, la revue de code les juge après coup, et la boucle se joue sur le support le plus cher à changer.
L'étape spec déplace cette boucle avant le code, sur une fiche, et donne à chaque étape suivante la même
référence.

## Décisions

Prises avec Sylvain le 11-10 ; elles ne sont pas rediscutées ici.

| Sujet | Choix |
|---|---|
| Seuil | Tout lot qui **change un comportement**. Champ `spec: true` posé à la planification (`raf add … --spec`), jamais déduit du titre. Un lot avec `screen:` implique la spec. Lots mécaniques (lint, refactor sans changement de comportement, docs, plan, cache, CI) : pas de champ. Lot déjà écrit : `raf spec <lot> on\|off`, sœur de `raf screen` (L185). `raf check` : un `spec` qui n'est pas un booléen est une erreur. |
| Format | **Une seule fiche** `docs/specs/<sujet>/fiche.yaml`, avec des parties selon le lot. La partie écran (`ecran`, `etats`, `champs`, maquette) n'est exigée que pour un lot `screen:`. Un lot mixte a une fiche avec les deux. Écartés : deux formats (règles, tests et verrou en double), Markdown libre (la machine ne peut pas le contrôler). |
| Revue de la fiche | Session neuve, `code-reviewer` en mode « fiche » (Sonnet), **deux passes au plus** avec l'agent spec, puis rendu au lead. |
| Validation humaine | Aucune systématique : Sylvain est le MOA et valide par l'usage. Question ciblée dans les mêmes quatre catégories coûteuses que la spec écran. |
| Tests d'acceptation | Même étape `accept` qu'un écran, avec une liste de lanceurs (front, back) dans `orchestrate.accept`. |
| Hypothèses | Pas d'entrée Nouveautés pour un lot back : en note du lot et dans le tableau final de la vague, que le lead relaie sur Discord. |
| Mesure | L176 (lots à écran) inchangé. Mesure séparée après 8 lots back avec fiche, contre les lots non visibles. |

## Ce qui est repris, ce qui change

| Pièce | Spec écran (1.1.0) | Spec back |
|---|---|---|
| Déclencheur | `screen:` (exige `visible`) | `spec: true` (ou `screen:`, qui l'implique) |
| Dossier | `docs/specs/<écran>/` | `docs/specs/<sujet>/` |
| Fiche | `ecran`, `etats`, `champs`, `regles`, `actions` | `sujet`, `cas`, `regles`, `contrats`, `donnees` ; `ecran` et son contenu si le lot a un écran |
| Rattachement d'une règle | un `etat`, des `champs` | un ou plusieurs `cas` |
| Maquette, captures, revue UX | oui | non (lot mixte : oui, pour la partie écran) |
| Revue avant le code | `ux-reviewer` mode maquette | `code-reviewer` mode fiche |
| Tests d'acceptation | `data-testid` des champs, API simulée d'après `actions[]` | appels de contrat d'après `contrats[]`, sources externes simulées |
| Après le code | UX de conformité légère, revue règle → test → vert | revue règle → test → vert, pas de passe UX |
| Hypothèses | section « Hypothèses » de la Nouveauté | note du lot, tableau final de la vague |

## Chaîne d'un lot back

```
precheck → spec (fiche) → revue de fiche (≤ 2 passes) → accept (tests rouges, verrou existant inchangé)
         → implement → review (règle → test → vert) → (fix)
```

Chaque flèche est une session neuve, comme le reste d'orchestrate. `accept`, `implement`, `fix`, `review`, le
verrou d'acceptation (`acceptation-<lot>.json`, `vert: true` posé par le cycle) et l'exclusion des tests rouges
de la suite et de la CI existent déjà et ne changent pas. Les nouveautés sont : le déclencheur `spec:`, la fiche
back, la revue de fiche, et la liste de lanceurs. Aujourd'hui le cycle ouvre l'étape spec sur `l.screen` ;
B3 la rend conditionnelle à `l.screen || l.spec`. Un lot mixte (`screen:`) joue en plus la revue de maquette
de 1.1.0, avant ou avec la revue de fiche (voir 4).

### 1. Seuil et champ `spec:`

- `raf add "titre" --spec` pose `spec: true` ; `raf spec <lot> on|off` le pose ou le retire sur un lot
  existant, comme `raf screen` (message d'erreur et refus dans le même style). `raf show` l'affiche ; le champ
  entre dans `FIELDS`.
- **Précisions du design** (choix de B1, à relire en revue) : `raf spec <lot> off` sur un lot qui a `screen:`
  est refusé (« retirer d'abord screen: ») puisque l'écran implique la spec ; `raf spec <lot> on` sur un lot à
  écran dit que c'est déjà le cas et ne change rien ; `spec: true` à côté de `screen:` est accepté (redondant)
  pour ne pas casser un plan écrit à la main.
- `raf check` : `spec` qui n'est ni `true` ni `false` est une erreur (« spec : true ou false attendu »).
- **Jamais déduit du titre.** Le lead décide à la planification : « ce lot change-t-il un comportement ? ».
  Test pratique : si un utilisateur, un client de l'API ou un autre service peut observer une différence,
  c'est un comportement. Un lint, un renommage, un déplacement de fichiers, une doc, une mise à jour du plan,
  un réglage de CI ou de cache sans effet observable n'en sont pas.
- **Sortie sous le seuil** : si l'agent spec constate que le lot ne change aucun comportement, il l'écrit
  (`sousSeuil`, une ligne, raison), ne crée pas de fiche, et le lot reprend le chemin actuel — comme un lot à
  écran qui ne change aucun écran.

### 2. La fiche back

Même fichier, mêmes statuts, mêmes principes que la fiche d'écran. Voir l'exemple (un vrai lot d'ol-companion,
L34). Clés de premier niveau :

| Clé | Contenu |
|---|---|
| `sujet` | `id` (kebab-case, nom du dossier), `titre`, `lot`, `perimetre` : `modules`, `endpoints`, `jobs` touchés (et `hors_perimetre`, facultatif : ce que le lot ne fait pas) |
| `cas[]` | `id` (`C1`…`Cn`, sans trou), `titre`, `acteur`, `declencheur` (un appel de contrat, un job, une commande), `preconditions`, `nominal` (les étapes), `alternatives[]`, `resultat`. Une alternative est `{ si, alors, regles }` : elle renvoie à des règles. |
| `regles[]` | `id` (`R1`…`Rn`, sans trou), `cas` (ids de cas ; pour une règle d'écran, `etat`), `enonce`, `statut` (`sourcee` + `source`, ou `hypothese` + `si_faux`), `tests[]` nommés `Rn — …` |
| `contrats[]` | `id` (`A1`…`An`), `appel` (`VERBE /chemin`, `job <nom>` ou `commande <nom>`), `entree`, `sortie`, `erreurs[]` (`{ code, message }` : le code est `HTTP <n>` ou `log <niveau>`, le message est le texte exact), `regles` |
| `donnees[]` | `id` (`D1`…), `objet` (modèle, table, fichier), `existant` (booléen), `modification` (`aucune`, `ajout`, `changement`), `note` ; si `existant: true` et `modification` n'est pas `aucune` : `decision` (la réponse du lead à la question ciblée) |

Une **source** de règle back est une ligne du lot, une note, une règle déjà codée (**fichier:ligne** : c'est ce
que la revue ouvre), un contrat d'API existant, un test existant, une exigence d'un document de référence. Sans
trace écrite, une règle n'est pas sourcée. Une règle d'écran garde ses clés (`etat`, `message`, `champs`,
`masque`) ; `message` et `champs` n'ont de sens que pour une règle rattachée à un état.

**Lot mixte.** Une fiche avec `sujet` **et** `ecran` : `sujet.id` et `ecran.id` sont le nom du dossier, `sujet.lot`
et `ecran.lot` sont le lot. Les ids `A` sont communs aux `actions[]` de l'écran et aux `contrats[]` : numérotés
`A1…An` sans trou sur l'ensemble, un appel d'API de l'écran est un contrat listé **une fois** dans `contrats[]` et
l'action de l'écran y renvoie par `contrat: Ax` au lieu de répéter son `appel`. **Fiches d'écran existantes** : une
fiche qui n'a que `ecran` reste valide telle quelle (aucune migration) ; `sujet` est exigé dès que le lot est
back ou mixte.

**Invariants** de `cadence spec check` (B2) pour la partie back : ids de cas, de règles, de contrats et de données
uniques ; cas et règles numérotés sans trou ; toute référence cite un id qui existe (`regles` d'une alternative ou
d'un contrat, `cas` d'une règle) ; chaque règle a un statut et sa justification ; chaque règle a **au moins un test
prévu**, nommé `Rn — …`, et est **rattachée à au moins un cas** (à un état, pour une règle d'écran) ; chaque cas est cité
par au moins une règle ; chaque alternative cite au moins une règle ; chaque cas a **au moins une alternative ou un
cas d'erreur**, ou dit explicitement `alternatives: []` avec sa raison dans `sans_alternative:` ; chaque contrat a au
moins une erreur, ou dit `sans_erreur:` avec sa raison ; un contrat dont l'`appel` n'a pas la forme attendue est un
écart ; une donnée existante modifiée sans `decision` est un écart. Le code de sortie ne change pas (0 valide, 1
écarts, 2 usage). `cadence spec qa` ne dérive `expectations.md` que de la partie écran et refuse une fiche qui n'en
a pas.

### 3. Question ciblée — les quatre catégories, côté back

Même mécanisme que l'écran : une session ne peut rien demander ; elle s'arrête, le lead remonte la question
(`--resume --answer`), la règle confirmée devient `sourcee` avec « réponse du lead ». Mêmes quatre catégories,
instanciées pour du back :

| Catégorie | Côté back |
|---|---|
| Modèle ou stockage | une entrée de `donnees[]` avec `existant: true` et `modification` ≠ `aucune` : clé, colonne, table, format d'un fichier ou d'un cache, migration |
| Contrat d'API public ou route publiée | renommer, retirer ou changer le type ou le sens d'un champ, d'un code d'erreur, d'une route ou d'un nom de job déjà publiés |
| Action irréversible | suppression, purge, envoi (mail, notification), paiement, migration à sens unique |
| Contradiction avec une règle sourcée | une règle `sourcee` d'un lot précédent, ou une règle déjà codée, que la nouvelle fait mentir |

**Un champ optionnel ajouté à une réponse existante n'est pas une rupture** : l'ancien client lit toujours la
réponse, et la fiche le prouve par une règle (R3 + R4 de l'exemple : le champ est absent d'une réponse fraîche, qui
reste identique à celle d'aujourd'hui). C'est une hypothèse écrite avec son `si_faux`, pas une question. Le
garde-fou du programme (`costlyHypotheses`) lit déjà le `si_faux` de toute règle `hypothese` ; il s'applique tel
quel à une fiche back, et `cadence spec check` y ajoute la clé `decision` des données.

### 4. Revue de la fiche

Après la spec, une session neuve : l'agent `code-reviewer` en mode « fiche » (Sonnet). Il lit la fiche, le code
et les tests du `perimetre`, les sources citées, et rend des constats classés bloquant / majeur / mineur, chacun
avec sa mesure (le fichier:ligne ouvert, la commande lancée) et jamais un goût. Il vérifie :

1. **Sourcée ou hypothèse.** Chaque règle `sourcee` cite une source qui existe (il ouvre le fichier:ligne et lit ce
   qu'il dit) ; chaque `hypothese` porte un `si_faux` et n'en cache pas une des quatre catégories coûteuses.
2. **Aucune contradiction.** Avec une règle déjà codée (il cherche dans les modules du `perimetre`, ouvre les tests
   existants qui affirment le contraire) et avec un contrat d'API existant (champ, code d'erreur, route).
3. **Erreurs et limites.** Pour chaque contrat, les entrées vides, absentes, expirées, trop grandes, en double, et
   chaque échec de la source externe ont une règle ou un `sans_alternative` / `sans_erreur` motivé.
4. **Un test par règle.** Chaque règle a au moins un test prévu, dont le nom dit ce qui est vérifié et pourrait
   échouer (le programme vérifie déjà la présence).

Un bloquant ou un majeur renvoie à l'agent spec (**passe 2**, session neuve avec les constats) ; après la passe 2,
ce qui reste est rendu au lead avec le lot ; les mineurs vont en notes du lot. Le verdict de cette revue **n'est
pas** `raf review` : la revue de code après l'implémentation garde ce rôle. **Lot mixte** : `ux-reviewer` revoit la
maquette (1.1.0) ; `code-reviewer` revoit aussi la fiche dès qu'elle a des `contrats` ; les constats des deux
revues partent ensemble à une seule passe 2. Un projet qui veut la sauter déclare `orchestrate.fiche: false` (défaut
`true`), comme `maquette: false` saute la revue de maquette (nom de la clé à confirmer en B3).

### 5. Tests d'acceptation back et liste de lanceurs

La session `accept` est celle de 1.1.0 : session distincte de l'implémenteur, qui ne reçoit que la fiche et la manière
de lancer les tests. Pour une fiche back :

- un ou plusieurs cas par règle, **nommés d'après elle** (`R5 — une entrée de 14 jours est refusée : null`, le nom
  prévu dans `regles[].tests`) ; ils appellent les contrats de `contrats[]` au plus près (le contrôleur ou le
  service pour un `GET`, la méthode du job pour un `job`) et simulent les sources externes d'après `entree` ;
- **commités rouges**, un test vert avant le code ne prouvant rien ; verrou, `acceptation-<lot>.json`, `vert: false`
  puis `vert: true` posé par le cycle, exclusion de la suite ordinaire et de la CI tant que le lot n'est pas vert :
  tout cela est celui de 1.1.0, sans changement.

**`orchestrate.accept` accepte une chaîne ou une liste de commandes.** Un projet à front et back a deux lanceurs
(ol-companion : Vitest dans `frontend/`, Jest dans `backend/`) :

```yaml
orchestrate:
  accept:
    - cd frontend && npx vitest run -c vitest.acceptation.config.ts
    - cd backend && npx jest -c jest.acceptation.config.js
```

- Le programme passe `CADENCE_ACCEPTATION` à **chaque** commande (et substitue `{acceptation}`), comme aujourd'hui
  pour l'unique commande. Une chaîne reste valable et se comporte comme avant.
- **Chaque lanceur ne prend que les fichiers sous sa racine.** La racine d'une commande est le dossier de son
  `cd <dossier> &&` initial (la forme déjà employée par ol-companion), sinon la racine du dépôt. Le gabarit
  `templates/acceptation-runner.mjs` gagne ce filtre : `acceptationOnly()` ne rend que les fichiers listés qui sont
  sous la racine du lanceur, `acceptationIgnored()` reste par config de lanceur (`exclude` de Vitest,
  `testPathIgnorePatterns` de Jest).
- Une commande dont la racine ne contient aucun fichier listé **n'est pas lancée** ; un fichier listé sous aucune
  racine est un écart de l'étape (« accept non conforme »). Contrôle du rouge : toutes les commandes lancées doivent
  échouer ; `vert: true` n'est posé que quand toutes passent.
- **Un lot par app** branche son lanceur back (configuration dédiée, `exclude` de la config ordinaire, ligne de
  `cadence.yaml`). Vérifié dans les dépôts le 11-10 : backends **Jest** pour ol-companion et finance-tracker,
  **Vitest 4** pour warhammer40k (`backend/package.json`) ; le frontend d'ol-companion est déjà branché (Vitest). Ces
  lots vivent dans le plan de chaque app, posés par le lead quand le premier lot back de l'app reçoit `spec: true` ;
  ils ne sont pas dans le plan de cadence.

### 6. Implémentation et revue de code

Le brief d'implémentation reçoit la fiche (chemin et résumé des cas, règles et contrats) : rendre les tests
d'acceptation verts **sans les modifier** ; les tests écrits en plus citent la règle (`R7 — …`) ; ne pas inventer de
règle, un cas non couvert est noté dans le rapport, pas codé. La revue de code vérifie **règle → test → vert** :
pour chaque `Rn`, le test d'acceptation existe, est vert, n'a pas été modifié depuis le commit rouge, et le
comportement est dans le diff ; en plus pour le back, chaque `contrat` est tenu par le code (sortie, codes et
messages d'erreur exacts) et chaque `donnees` annoncée sans modification est intacte. Une règle sans test, un test
d'acceptation modifié, un contrat qui s'écarte de la fiche ou une règle codée qui n'est pas dans la fiche sont des
constats (majeur).

### 7. Hypothèses visibles

Un lot back n'a pas d'entrée Nouveautés (il n'est pas `visible`). Ses hypothèses vont :

- **en note du lot** (`raf note`), une ligne par règle `hypothese` avec son `si_faux` en une phrase :
  `Hypothèses (fiche cache-de-secours-365scores) — R3 : champ cacheAgeSeconds ; sinon seul son nom change.` La note est
  posée par le programme à la fin de l'étape spec, dans le commit de plan du cycle ; **B3 vérifie** que le cycle peut
  écrire une note (la classe du plan a une méthode `note`, le cycle ne l'appelle pas encore) ;
- **dans le tableau final de la vague**, où le programme lit la fiche et liste les hypothèses de chaque lot back ;
- **sur Discord**, relayées par le lead, avec la règle et ce qui la ferait changer.

## Mesure : critère de réussite

L176 (étape spec d'un écran) reste ce qu'il est : lots à écran, référence les lots visibles. La mesure du back
est **séparée** et ne conclut qu'à partir de **8 lots** back avec fiche.

**Référence : les lots non visibles** de [`corrections-2026-10-10.md`](../../mesures/corrections-2026-10-10.md),
tableau « Lots visibles et non visibles ». Recalculée à partir du document : 263 lots − 55 visibles = **208** ;
160 − 25 = **135** avec au moins une correction (135 / 208 = 64,9 %, soit 65 %) ; 75 − 14 = **61** avec au moins
deux (61 / 208 = 29,3 %, soit 29 %) ; 253 − 45 = 208 passes, une par lot en moyenne. Rejouée sur les journaux
le 11-10 (`cadence corrections ~/projects/developpeur --cache docs/mesures/corrections-classement.json --until
2026-10-10T18:31Z`) : mêmes chiffres, 208 / 135 (65 %) / 61 (29 %) / 208. (Le « environ 30 % » du brief est 29 %.)

| Indicateur | Référence (lots non visibles) | Réussite |
|---|---|---|
| lots avec au moins 1 correction | 65 % (135 sur 208) | ≤ 40 % |
| lots avec au moins 2 corrections | 29 % (61 sur 208) | ≤ 15 % |

Le **coût** s'ajoute : tokens de `spec`, de revue de fiche et d'`accept` (2 à 3 sessions de plus par lot), relevés
dans les journaux de vague, présentés **à côté** des corrections évitées. Si les corrections baissent mais que le
coût dépasse celui des passes évitées, la conclusion le dit. Sous 8 lots, le résultat est une note, non un verdict.
Si le critère n'est pas atteint, le seuil (tout lot qui change un comportement) est resserré avant d'abandonner
l'étape. Le nombre d'hypothèses par fiche est suivi à part.

Limites connues : la référence mélange des lots mécaniques (la fiche ne leur sera jamais demandée) et des lots qui
changent un comportement, et les données d'alors ne permettent pas de les séparer ; cadence pèse 123 lots sur 263.
Les lots avec fiche sont choisis par le lead, donc pas tirés au hasard. Le relevé des lots à fiche back lit
`sujet.lot` dans les fiches ; B5 ajoute à `cadence corrections` ce qu'il faut pour les isoler si besoin.

## Mise en service

Lot d'essai naturel : **L34 d'ol-companion** (cache de secours quand 365scores est en panne, un lot sans écran, en
`todo`), dont l'exemple est tiré. Une fois B1 livré, `raf spec L34 on` l'adopte sans le réécrire. Chaque fiche
back livrée compte pour les 8 de la mesure. Pas de lot d'essai à part : les premiers lots de la mesure en font
office, et l'exemple est relu à la main avant d'automatiser.

## Plan de lots

Ajoutés au plan avec ce design (`raf add`) ; dépendances en chaîne, estimations en jours. Ils deviennent prêts pour
`orchestrate --continue` dans cet ordre.

| Id | Lot | Estimation | Après |
|---|---|---|---|
| L186 (B1) | Champ `spec:` des lots : `raf add --spec`, `raf spec <lot> on\|off`, `raf show`, `raf check` (spec hors booléen = erreur), README + CHANGELOG | 0.5 | — |
| L187 (B2) | Format de la fiche back : `cadence spec check` (sujet, cas, règles, contrats, données ; fiche mixte, ids `A` communs), gabarit, exemple testé `2026-10-11-etape-spec-back-fiche-exemple.yaml` | 1 | L186 |
| L188 (B3) | Gabarit spec back (`templates/orchestrate/spec.md`), `code-reviewer` en mode fiche, chaîne `precheck → spec → revue de fiche → accept` (`l.screen \|\| l.spec`), hypothèses en note et dans le tableau final | 1 | L187 |
| L189 (B4) | `orchestrate.accept` en liste de lanceurs : racine par commande, filtre du gabarit `acceptation-runner.mjs`, contrôle du rouge et du vert sur la liste | 0.5 | L188 |
| L190 (B5) | Mesure de l'étape spec back après 8 lots avec fiche, contre les lots non visibles (ouvert tant qu'ils ne le sont pas), note de conclusion | 0.5 | L189 |

Commandes lancées (chaque titre cite `spec etape-spec-back` et l'id B ; les ids L sont ceux que `raf add` a rendus) :

```sh
raf add "Champ spec des lots : raf add --spec, raf spec <lot> on|off, raf check, README + CHANGELOG (spec etape-spec-back, B1)" --estimate 0.5
raf add "Format de la fiche back : cadence spec check (sujet, cas, règles, contrats, données), gabarit, exemple testé (spec etape-spec-back, B2)" --estimate 1 --after L186
raf add "Étape spec back d'orchestrate : gabarit spec back, code-reviewer en mode fiche, chaîne precheck→spec→revue de fiche→accept (spec etape-spec-back, B3)" --estimate 1 --after L187
raf add "orchestrate.accept en liste de lanceurs, front et back (spec etape-spec-back, B4)" --estimate 0.5 --after L188
raf add "Mesure de l'étape spec back après 8 lots avec fiche (spec etape-spec-back, B5)" --estimate 0.5 --after L189
```

Chaque lot qui livre une commande ou une clé met à jour le README et le CHANGELOG dans le même lot (règle du dépôt).

## Risques et ce qu'on ne fait pas

- **Seuil large** : « tout lot qui change un comportement » ouvre l'étape à la plupart des lots non mécaniques,
  donc 2 à 3 sessions de plus presque partout. D'où la mesure du coût à côté des corrections, et le resserrement
  du seuil avant l'abandon.
- **Une fiche qui ment** : une règle présentée `sourcee` dont la source ne dit pas ça. Parade : la revue de fiche ouvre
  chaque fichier:ligne ; non résolu pour une source qui est un document hors dépôt.
- **Oracle trop fidèle à la fiche** : des tests écrits depuis la fiche vérifient la fiche, pas l'usage. La revue de
  fiche (contradiction avec le code et les contrats existants) et la revue de code (règle codée absente de la
  fiche) sont les deux garde-fous ; l'usage reste jugé par Sylvain.
- **Mesure sur peu de lots** : 8 lots choisis par le lead ne sont pas un échantillon ; le résultat est un ordre de
  grandeur, dit comme tel.
- Pas de diagrammes de séquence ni d'UML obligatoires, pas de validation humaine de la fiche, pas de génération de
  code depuis la fiche, pas de spec pour les lots mécaniques. Les lots sans `spec:` ni `screen:` ne changent pas.
