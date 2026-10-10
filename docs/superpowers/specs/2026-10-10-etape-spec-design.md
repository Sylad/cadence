# Étape spec dans orchestrate — design (lot L166)

Date : 2026-10-10. Statut : conception, prête à découper (voir « Plan de lots »). Aucun code livré par
ce lot. Exemple de fiche : [`2026-10-10-etape-spec-fiche-exemple.yaml`](2026-10-10-etape-spec-fiche-exemple.yaml),
gardé par `test/etape-spec-fiche.test.ts`.

## But

Mesure de départ ([`docs/mesures/corrections-2026-10-10.md`](../../mesures/corrections-2026-10-10.md),
263 lots) : 61 % des lots ont au moins une passe de correction, 29 % au moins deux ; 55 lots
visibles : 45 % et 25 %. Causes : bug de code 51 %, test manquant 21 %, dérive d'architecture 13 %,
spec floue ou critère absent 10 %, règle de gestion inventée 0 % (relevé à la main, ordre de grandeur).

Sur un lot visible, une partie de ces corrections naît du même défaut : l'écran est découvert
**pendant** le code. L'implémenteur invente les états (vide, erreur), les messages et les règles ; la
passe UX les juge après coup, et la boucle se joue sur le code, le support le plus cher à
changer. L'étape spec déplace cette boucle **avant le code**, sur une maquette, et donne à chaque
étape suivante la même fiche comme référence.

## Décisions

| Sujet | Choix |
|---|---|
| Seuil | Un lot `visible` qui déclare `screen:` — `page` (nouvelle page), `component` (nouveau composant) ou `journey` (parcours modifié). Sans `screen:`, le workflow actuel, inchangé. Le champ est posé à la planification (`raf add … --screen page`), jamais déduit du titre. |
| Sortie sous le seuil | Si l'agent spec constate que le lot ne change aucun écran, il l'écrit (une ligne, raison) et l'étape se termine sans maquette ; le lot reprend le chemin actuel. |
| Où vit la spec | `docs/specs/<écran>/` du projet cible : `maquette.html`, `fiche.yaml`, captures `maquette-<état>-<largeur>.png`. Versionnée, citée par le lot (`feat(Lx): spec …`). |
| Validation humaine | Aucune systématique. Une **question ciblée** au lead seulement si le choix est coûteux à défaire (voir plus bas). |
| Boucle | Entre l'agent spec et l'agent UX, sur la maquette, deux passes au plus ; au-delà le lot est rendu au lead. |
| Tests d'acceptation | Écrits avant le code, depuis la fiche, par une session distincte de l'implémenteur (oracle indépendant). |

## Chaîne d'un lot au-dessus du seuil

```
spec → revue UX de la maquette (≤ 2 passes) → tests d'acceptation (rouges) → implement
     → UX de conformité (légère) → revue de code (règle → test → vert) → (fix) → news avec hypothèses
```

Chaque flèche est une session neuve, comme le reste d'orchestrate. L'étape `implement`, les
corrections et la revue de code existent déjà ; les quatre premières étapes sont les nouveautés.

### 1. `spec` — maquette et fiche

Session d'écriture (Sonnet). Entrée : le lot, ses notes, le CLAUDE.md du projet, sa charte (CSS
existant, composants voisins, `docs/qa/expectations.md`), les routes et les contrats d'API déjà
présents. Sorties :

- **Maquette** `maquette.html` : HTML + CSS statiques, **à la charte du projet** (variables, polices,
  composants existants réutilisés, aucun style inventé quand un équivalent existe), sans JavaScript
  métier. Les états sont des sections adressables (`#etat-vide`, `#etat-chargement`, `#etat-erreur`,
  `#etat-charge`) ; chaque champ de la fiche porte `data-testid="<id du champ>"`.
- **Rendu** : une capture par état et par largeur (**1440** et **390**) par Playwright, dans le dossier
  de sortie de la vague ; les fichiers retenus sont copiés dans `docs/specs/<écran>/`.
- **Fiche d'écran** `fiche.yaml`, lisible par machine (format ci-dessous).

### 2. Fiche d'écran (format)

Voir l'exemple. Clés de premier niveau :

| Clé | Contenu |
|---|---|
| `ecran` | `id`, `titre`, `route`, `lot`, `largeurs` (`[1440, 390]`), `maquette` (chemin) |
| `etats` | au moins `vide`, `chargement`, `erreur` (+ `charge`) |
| `champs[]` | `id` (kebab-case, unique : c'est aussi le `data-testid`), `libelle`, `type`, `source` (appel API et chemin dans la réponse, ou `statique`, ou `action Ax`), `obligatoire` (booléen) |
| `regles[]` | `id` (`R1`, `R2`… dans l'ordre), `etat` (un des `etats` : l'état où la règle s'applique et où son message est visible), `enonce`, `message` (texte exact à l'écran, ou `null`), `champs` (ids concernés), `statut`, `tests[]` |
| `actions[]` | `id` (`A1`…), `declencheur` (id d'un champ, ou `null` pour le chargement), `appel` (`VERBE /chemin`), `regles` (règles qu'elle porte) |

**Statut d'une règle** — c'est ce qui rend l'invention visible :

- `sourcee` : elle dit d'où elle vient (`source:` — une ligne du lot, une note, `expectations.md`,
  une règle déjà codée dans l'app, un contrat d'API). Sans trace écrite, une règle n'est pas sourcée.
- `hypothese` : l'agent l'a posée faute de source. Elle dit ce qui changerait si elle était fausse
  (`si_faux:`) — ce qui permet de juger si la question était à poser.

Invariants (vérifiés par le test de l'exemple, puis par `cadence spec check`, lot S2) : ids de champs
uniques ; règles numérotées sans trou ; chaque règle a un statut et sa justification ; les actions et
les règles ne citent que des ids existants ; chaque règle a au moins un test prévu, nommé `Rn — …` ;
au moins les états vide, chargement, erreur ; chaque règle a un `etat` qui est l'un des `etats`.

### 3. Revue UX de la maquette

L'agent `ux-reviewer` gagne un mode « maquette » : il ouvre `maquette.html` (fichier local, pas
d'application), regarde les captures 1440/390 de chaque état, lit la fiche, et rend des constats classés
bloquant / majeur / mineur, chacun avec la règle (Nielsen, WCAG 2.2 AA) ou la mesure. Il vérifie en
plus la **cohérence maquette ↔ fiche** : chaque champ présent des deux côtés, chaque message de règle
visible dans l'état que porte sa clé `etat`, les `data-testid` posés. Un bloquant ou un majeur renvoie à
l'agent spec (passe 2, session neuve avec les constats) ; après la passe 2, ce qui reste est rendu au
lead avec le lot ; les mineurs vont en notes du lot. Le verdict de cette revue **n'est pas** `raf ux` :
c'est la passe de conformité après code qui garde ce rôle.

### 4. Question ciblée — quand et comment

Une session ne peut rien demander ; elle s'arrête et le lead remonte la question (mécanisme existant,
`--resume --answer`). Elle ne le fait que pour un choix **coûteux à défaire** :

- un modèle ou un stockage de données (clé, migration, donnée utilisateur créée une fois livré) ;
- un contrat d'API public ou partagé, ou une route / URL déjà publiée ;
- une action destructive ou irréversible (suppression, envoi, paiement) ;
- une règle qui contredit une règle sourcée existante.

Tout le reste (libellé, ordre des champs, état d'erreur, espacement) est une **hypothèse écrite** dans la
fiche, qu'on corrigera à bas coût. La fiche dit de chaque hypothèse ce qui la ferait changer ; une règle
`hypothese` dont `si_faux` mentionne une des quatre catégories ci-dessus est une question, pas une
hypothèse (l'étape `spec` échoue en rendant la question).

### 5. Tests d'acceptation avant le code

Session distincte de l'implémenteur, à qui l'on ne donne **que** la fiche, la maquette et la manière de
lancer les tests du projet (pas le code d'implémentation à écrire). Contrat :

- un ou plusieurs cas par règle, **nommés d'après elle** (`R3 — erreur : message et bouton Réessayer`,
  le nom prévu dans `regles[].tests`) ; sélecteurs = `data-testid` = ids de champs de la fiche ; appels
  API simulés d'après `actions[]`.
- **Commités rouges** : l'étape lance les tests ; chacun doit échouer (un test vert avant le code ne
  prouve rien : il est renvoyé à la session). Commit `test(Lx): acceptation R1–Rn (rouge)`.
- **Verrou** : l'étape enregistre l'empreinte des fichiers de tests d'acceptation (liste dans
  `docs/specs/<écran>/acceptation.json`). L'implémentation les rend verts **sans les modifier** ;
  à la fin de chaque `implement` et `fix`, le cycle compare les empreintes (lot S5 : contrôle propre
  à l'étape, la garde actuelle de `guard.ts` ne porte que sur le push) et rend le lot au lead si un de ces
  fichiers a changé. Le verrou vaut pour **toute session du dépôt** (un dépôt n'a qu'une file : le lot
  suivant tourne sur la même branche) : le contrôle porte sur les `acceptation.json` de tous les lots, pas
  seulement du lot courant. Une modification utile est une question au lead
  ou un constat de revue — jamais un geste silencieux.
- **Isolement des autres lots du dépôt** : le cycle relance `config.test` après chaque `implement`/`fix`,
  et des tests rouges commités feraient échouer les autres lots du dépôt (passes `fix` « tests rouges »
  sur un travail qui n'est pas le leur). Les fichiers listés dans `acceptation.json` sont donc
  **exclus de `config.test`** tant que leur lot n'est pas vert (l'étape retire ces fichiers de la commande, S5) ; seul
  le lot propriétaire les lance, par une commande dédiée, et ils rejoignent `config.test` quand il est
  vert. Si le lot est rendu au lead (question, budget, passes épuisées), ses tests restent rouges mais
  exclus : les lots suivants ne les voient pas ; le lot reprend (`--resume`) avec le même verrou.
- Hors champ : ce qui ne s'automatise pas (rendu, ergonomie, lisibilité) reste à la passe UX de
  conformité.
- `docs/qa/expectations.md` est **dérivé de la fiche** (`cadence spec qa`), à partir de la clé `etat` des
  règles. Un champ est **propre à un état** quand une règle d'état `vide` ou `erreur` le cite
  (comme message-vide) ; une règle ne cite donc dans `champs` que les champs qu'elle fait apparaître (ceux
  qu'elle masque restent dans son énoncé). Ensuite : `shows:` = champs obligatoires, **sauf** les champs propres à un état
  (non visibles page chargée) ; la ligne `shows:` d'un champ qu'une règle `sourcee` d'état `vide` fait
  disparaître (R2 de l'exemple : « aucun autre champ ») se termine par `— unless <énoncé>` (condition en
  mots, comme `may be empty when`), sans quoi l'état vide prévu serait un faux constat. `never:` = les messages des règles d'état `erreur`
  (état dégradé) ; le message d'une règle d'état `vide` n'y va jamais, c'est un affichage prévu. `api:` = les seules `actions[]`
  de chargement (`declencheur: null`) en GET, la passe QA n'envoyant jamais de POST ; si une règle
  `sourcee` d'état `vide` porte l'action, la ligne `api:` se termine par `may be empty when <énoncé de la
  règle>` (sans cela, le corps vide d'un état vide prévu serait un faux constat) ; les actions
  déclenchées par un champ restent à l'acceptation. Le lead le commite comme aujourd'hui (fichier de plan).

### 6. Implémentation

Le brief d'implémentation reçoit la fiche (chemin + résumé des règles) et la maquette ; consignes
ajoutées : rendre les tests d'acceptation verts sans les modifier ; **les tests écrits en plus citent la
règle** (`R2 — …`) ; ne pas inventer de règle : un cas non couvert est noté dans le rapport, pas
codé. L'entrée Nouveautés est écrite comme aujourd'hui, avec la section « Hypothèses ».

### 7. Conformité UX (légère) puis revue de code

- **UX de conformité** : remplace la passe UX complète. L'agent compare l'application réelle à la
  maquette (captures 1440/390 des mêmes états), signale les écarts de rendu et d'ergonomie que les
  tests ne couvrent pas, et ne refait pas l'audit complet. Verdict pour `raf ux`, toujours posé par le
  lead sur le regard humain des captures.
- **Revue de code** : le brief ajoute la vérification **règle → test → vert** : pour chaque `Rn` de la
  fiche, le test d'acceptation existe, est vert, n'a pas été modifié depuis le commit rouge (empreinte),
  et le comportement correspondant est dans le diff. Une règle sans test, un test d'acceptation modifié
  ou une règle codée qui n'est pas dans la fiche sont des constats (majeur). Le relecteur ne reconstruit
  plus les cas.

### 8. Hypothèses → Nouveautés

L'entrée Nouveautés d'un lot avec fiche se termine par un bloc :

```markdown
## Hypothèses
- R3 — erreur de chargement : message « Impossible de charger le prochain match. » et bouton
  Réessayer. À confirmer ; sinon seul ce bloc change.
```

Une ligne par règle `hypothese`, avec son `si_faux` en une phrase. C'est ce que le lead montre à
Sylvain pour la décision `raf ux` : les choix que personne n'a validés y sont lisibles sans ouvrir la
fiche. `cadence news check` signale un lot avec fiche dont l'entrée n'a pas la section alors que la
fiche a des hypothèses.

## Mesure : critère de réussite

Contre [`corrections-2026-10-10.md`](../../mesures/corrections-2026-10-10.md), même méthode
(`cadence corrections`, relevé des lots qui ont une fiche, classement par cause + relecture à la main).
La mesure ne conclut qu'à partir de **8 lots** avec fiche (un écran d'essai n'est qu'un test de
fonctionnement, sans valeur statistique) :

| Indicateur | Référence (lots visibles) | Réussite |
|---|---|---|
| lots avec au moins 1 correction | 45 % (25 sur 55) | ≤ 30 % |
| lots avec au moins 2 corrections | 25 % (14 sur 55) | ≤ 12 % |
| passes dues à « spec floue », « règle inventée » ou « test manquant » (part des passes) | 31 % (tous lots) | ≤ 15 % |
| lot qui revient d'une revue UX avec un bloquant | non mesuré | aucun à la conformité |

Le coût s'ajoute : tokens de `spec` + revue de maquette + `accept` par lot, relevés dans les journaux
de vague, présentés à côté des corrections évitées. Si les corrections baissent mais que le coût de
l'étape dépasse celui des passes évitées, la conclusion le dit. Sous la barre de 8 lots, le résultat
est une note, non un verdict. Si le critère n'est pas atteint, le seuil (`screen:`) est resserré avant
d'abandonner l'étape.

Limite connue : la cause « règle de gestion inventée » vaut 0 % dans la référence, faute de constat
classé ainsi ; la fiche la rend mesurable (les hypothèses sont écrites). La comparaison porte donc sur
les trois autres lignes, et le nombre d'hypothèses par fiche est suivi à part.

## Essai prévu

Un écran d'une app loisir, **à choisir par le lead à l'ouverture du lot d'essai** (S7) : un lot visible
neuf d'**ol-companion** de préférence (stack React + TanStack, `docs/qa/expectations.md` présent,
données publiques, rien de coûteux à défaire), pas un lot de revue UX d'écran existant. Critère de choix :
nouvelle page ou nouveau composant avec au moins un appel API et un état d'erreur possible. Sans lot
de ce genre, repli sur finance-tracker (données de démonstration seulement). L'essai est lancé à la
main d'abord (les trois étapes enchaînées par le lead) pour juger la fiche avant d'automatiser.

## Plan de lots

À ajouter au plan par le lead (`raf add`) ; dépendances en chaîne, estimations en jours. Le lot de
conception ne les ajoute pas lui-même : ils deviennent prêts pour `orchestrate --continue` dès leur création.

| Id | Lot | Estimation | Après |
|---|---|---|---|
| S1 | Champ `screen:` des lots (`raf add --screen page\|component\|journey`, `raf show`, `raf check` : `screen` sans `visible` est une erreur), clé `orchestrate.spec` de cadence.yaml (dossier des specs, commande de rendu), README + CHANGELOG | 0.5 | — |
| S2 | Format de la fiche : `cadence spec check <fiche>` (invariants ci-dessus, codes de sortie), `cadence spec qa <fiche>` (dérive `expectations.md`), gabarit `templates/fiche.yaml` | 1 | S1 |
| S3 | Étape `spec` d'orchestrate : agent `spec-writer`, brief, rendu Playwright 1440/390 des états, commit de la spec, règle « hypothèse coûteuse = question », sortie sous le seuil | 1 | S2 |
| S4 | Revue UX de la maquette : mode « maquette » de `ux-reviewer`, cohérence maquette ↔ fiche, boucle ≤ 2 passes, rendu au lead | 0.75 | S3 |
| S5 | Étape `accept` : session distincte, tests rouges vérifiés, empreinte `acceptation.json`, garde de `implement`/`fix` sur ces fichiers pour toutes les sessions du dépôt (tous les lots), exclusion des fichiers listés dans les `acceptation.json` de `config.test` tant que leur lot n'est pas vert, commande dédiée du lot propriétaire | 1 | S3 |
| S6 | Briefs aval : fiche donnée à `implement`, tests citant les règles, `code-reviewer` règle → test → vert, UX de conformité légère (remplace la passe complète des lots avec fiche), section « Hypothèses » de Nouveautés + contrôle de `news check` | 1 | S4, S5 |
| S7 | Essai sur un écran d'une app loisir (à la main puis orchestré), note sur le fonctionnement de la fiche | 0.5 | S6 |
| S8 | Mesure contre le lot de mesure, une fois 8 lots avec fiche livrés (ouvert tant qu'ils ne le sont pas), note de conclusion | 0.5 | S7 |
| S9 | Mettre à jour `docs/lead.md` et ses deux SVG (L167) avec les étapes spec, revue UX de la maquette et tests d'acceptation, README (sections lead et orchestrate) : dès les étapes livrées, sans attendre la mesure | 0.25 | S6 |

Commandes prêtes à lancer (chaque titre cite la spec `etape-spec` et l'id S ; `<Sn>` = l'id donné par `raf add`) :

```sh
raf add "Champ screen des lots + clé orchestrate.spec (spec etape-spec, S1)" --estimate 0.5
raf add "cadence spec check et spec qa, gabarit de fiche (spec etape-spec, S2)" --estimate 1 --after <S1>
raf add "Étape spec d'orchestrate : spec-writer, rendu 1440/390 (spec etape-spec, S3)" --estimate 1 --after <S2>
raf add "Revue UX de la maquette : ux-reviewer mode maquette (spec etape-spec, S4)" --estimate 0.75 --after <S3>
raf add "Étape accept : tests rouges, verrou par empreinte sur toutes les sessions du dépôt, fichiers des acceptation.json exclus de config.test tant que le lot n'est pas vert, commande dédiée (spec etape-spec, S5)" --estimate 1 --after <S3>
raf add "Briefs aval : fiche, tests citant les règles, revue règle→test→vert, UX légère, Hypothèses (spec etape-spec, S6)" --estimate 1 --after <S4>,<S5>
raf add "Essai étape spec sur un écran d'app loisir (spec etape-spec, S7)" --estimate 0.5 --after <S6>
raf add "Mesure de l'étape spec contre le lot de mesure, 8 lots avec fiche (spec etape-spec, S8)" --estimate 0.5 --after <S7>
raf add "docs/lead.md : schéma du workflow avec les étapes spec, L167 (spec etape-spec, S9)" --estimate 0.25 --after <S6>
```

## Risques et ce qu'on ne fait pas

- **Maquette qui ment** : une maquette HTML peut montrer ce que l'application ne sait pas faire
  (composant absent de la bibliothèque). Parade : réutiliser les composants et variables existants ;
  l'écart se paie à la conformité. Non résolu pour un projet sans charte écrite.
- **Oracle trop fidèle à la maquette** : des tests écrits depuis la fiche vérifient la fiche, pas
  l'usage. Le regard humain sur les captures (`raf ux`) reste la seule vérification d'usage.
- **Coût** : trois sessions de plus par lot au-dessus du seuil. D'où le seuil et la mesure du coût.
- Pas de validation humaine de la fiche, pas de maquette interactive, pas de génération de code depuis
  la fiche. Les lots sans `screen:` ne changent pas.
