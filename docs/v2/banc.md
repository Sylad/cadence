# Le banc de cadence 2

## Pourquoi

Cadence 1 a perdu son essai A/B (×3,8 en temps, référence préférée 8 fois sur 8) faute de mesure continue. Le banc rejoue des demandes réelles avec la référence (bras `A`) et le candidat (`equipe-legere` par défaut) et rend un verdict chiffré. Les cinq causes de l'échec sont décrites dans [la spec, §0](2026-11-07-cadence-2-design.md).

## Ce que mesure le banc

Un passage est **vert** si tous les critères bloquants passent (`verdict.ts`).

| Critère | Seuil |
|---|---|
| au moins un banc | ≥ 1 |
| mesures complètes | les deux bras mesurés sur chaque banc |
| tous les bancs jugés | tous |
| aucune fuite | 0 |
| aucun bras en échec | 0 (un bras en échec saute les juges du banc) |
| relecture aveugle | le candidat n'est pas moins bien préféré (> la moitié) |
| tests cachés, mutations tuées | ≥ référence |
| défauts bloquants et majeurs | ≤ référence |
| cohérence UI | ≥ référence |
| temps total | ≤ 1,5 × la référence |
| temps des retouches | ≤ 1,2 × la référence ; bloquant seulement si le passage compte au moins un banc de retouche |
| questions inutiles | 0 sur un banc sans vraie décision |

Les chiffres absolus du 07-11 (304 tests cachés, 79 % de mutations) sont affichés, non bloquants : la barre est relative à la référence du même passage.

## Fonctionnement

- Un seul passage à la fois par racine : verrou `<racine>/passage.lock`, repris si son pid est mort ou s'il date d'un autre démarrage de la machine (identifiant de démarrage écrit dans le verrou ; un pid réutilisé après un redémarrage de WSL ne bloque donc pas). Échappatoire manuelle : `rm ~/bench-cadence/passage.lock`.
- Un seul bras à la fois, dans des clones jetables `c1`/`c2` (ordre alterné d'un banc à l'autre) ; la correspondance bras/clone n'est écrite qu'après les juges (relecture aveugle).
- Un banc est un dossier de `bancs/` (les fichiers y sont ignorés). Un `banc.yaml` invalide n'arrête pas le passage : ses deux bras sont en échec (« banc invalide : … ») et les bancs suivants sont joués.
- Préparation d'un clone : `install` puis la suite `tests` à la base, chacune au plus 30 minutes, dans son propre groupe de processus (tué au retour). Une installation en échec ou un délai dépassé met les deux bras du banc en échec (phase « préparation », journal `<clone>.install.log` ou `<clone>.tests-base.log`) ; le code de la suite à la base est noté dans `resultat.json` (`suite_base`).
- Un bras livre par commit : s'il finit sans commit (« aucun commit ») ou laisse des fichiers modifiés ou non suivis apparus pendant son tour (« travail non commité », hors `.cadence`, `docs/plan` et `cadence.yaml`), il est en échec et les juges du banc sont sautés : ils ne voient que `base..HEAD`.
- Les juges travaillent dans `<racine>/eval/<passage>/<banc>` ; leurs copies `X` et `Y` sont effacées à la sortie du juge, quel que soit le chemin (jugement rendu, JSON invalide, erreur).
- Nettoyage : après `resultat.json`, chaque clone (environ 1 Go) est remplacé par `<clone>.patch` (`git diff base..HEAD`) et `<clone>.commits.txt` (`git log --oneline base..HEAD`) ; captures et journaux restent. `--garder-clones` les garde pour le débogage.
- Un passage s'appelle `<date>-<HHMM>-<empreinte>`, date et heure de Paris (comme `statut`) ; l'empreinte hache `v2/src` et `v2/briefs` à HEAD.
- Refus (code 2) si `v2/src` ou `v2/briefs` a des changements non commités, ou si `v2/dist/cli.js` est absent ou plus ancien que les sources.
- **Publication** : permise seulement si le **dernier** passage de l'empreinte courante qui couvre les bancs 1, 3 et 6 est vert, oppose un candidat à une référence distincte (`--candidat` égal à `--reference` est refusé, code 2), avec le modèle que le `bras.yaml` courant donne au candidat (le modèle est hors de l'empreinte : chaque ligne d'historique porte `reference` et `modele_candidat`), et si aucun passage rouge de cette empreinte, éclair compris, ne le suit.

## Commandes

La racine est `~/bench-cadence` (ou `$BENCH_ROOT`).

| Commande | Effet |
|---|---|
| `cadence2 bench court` | bancs 1, 3 et 6 : le passage minimal avant publication |
| `cadence2 bench hebdo` | tous les bancs ; c'est le passage du samedi |
| `cadence2 bench lancer --bancs 1,4` | les bancs choisis |
| `cadence2 bench statut` | dernier passage, publication permise ou non, alertes (banc du weekend manquant, aucun banc frais) |
| `cadence2 bench verifier-publication` | code 0 si la publication est permise |
| `cadence2 bench ajouter <projet> <lot> <demande.md> --install c --tests c [--taille retouche\|fonction\|grosse] [--visible]` | fabrique un banc frais à partir d'un lot livré |

Options communes : `--candidat <bras>`, `--reference <bras>`, `--juge <modèle>`, `--garder-clones` (ne pas effacer les clones après le passage, pour le débogage), et `--repetitions N` (entier ≥ 1, défaut 1) sur `court`, `hebdo`, `lancer` et `eclair` : chaque bras est joué N fois par banc, dans des clones frais `r1`, `r2`… jugés séparément (ids `<banc>#k` au rapport). Temps, jetons et critères mécaniques sont sommés sur les répétitions ; une préférence (relecture aveugle, UI) ne compte pour un banc que si toutes ses répétitions sont jugées et s'accordent, sinon le banc compte égal. Préférer un N pair, pour que l'ordre des bras soit équilibré.

## Installation du timer

```bash
bash v2/systeme/installer.sh
```

Le service lance `cadence2 bench hebdo` avec un `PATH` explicite (node de nvm, `~/.local/bin` pour `claude`) : pas de shell de connexion. Précondition, vérifiée au démarrage du service (échec net dans le journal sinon) : `cadence2` doit être lié au checkout principal, `~/projects/developpeur/cadence/v2` ; pour le corriger : `cd ~/projects/developpeur/cadence/v2 && npm run build && npm link` (l'installeur avertit si le lien pointe ailleurs). Le service vérifie aussi que `node` est sur son `PATH` : après une montée de version nvm, mettre à jour la ligne `Environment=PATH` du service puis relancer l'installeur. Ce checkout doit être propre (rien de non commité sous `v2/src` et `v2/briefs`) et construit (`npm run build` dans `v2`), sinon le passage est refusé. Journal : `~/bench-cadence/hebdo.log`. `TimeoutStartSec=infinity` : un hebdo (8 bancs et plus, ×N répétitions, juges compris) dure bien plus de 10 h ; chaque session de bras reste bornée à 4 h, install et tests à 30 min.

## Banc éclair

`cadence2 bench eclair` joue le seul banc 1 (une retouche), A contre le candidat, avec les juges : environ 15 minutes, à lancer après tout changement de v2 pour vérifier que le flux n'est pas redevenu lent ni bavard. Même garde (checkout propre et construit) et même verrou qu'un passage ordinaire. Il affiche d'abord « temps candidat ≤ 1,2 × A » et « questions du candidat : 0 », les recopie dans la section « Contrôles éclair » du rapport et note `eclair_ok` dans la ligne d'historique (le HUD affiche ✗ quand il vaut `false`) ; il ne sort en 0 que si le verdict est vert et les deux contrôles tiennent. Il n'autorise jamais la publication : `statut` exige les bancs 1, 3 et 6, donc seul `bench court` compte.

## Rattrapage

`Persistent=true` : un samedi manqué (WSL éteint) est rejoué au premier démarrage de WSL suivant.

## Où lire les rapports

- `~/bench-cadence/rapports/<passage>.md` (et `.json`) : par banc, temps, jetons, préféré, tests cachés, mutations, suite du projet (`ok` ou `ROUGE`) et réponse à la demande (`oui`, `en partie`, `non`) de chaque bras ;
- `~/bench-cadence/historique.jsonl`, une ligne par passage ;
- `~/bench-cadence/runs/<passage>/<banc>/resultat.json` pour le détail.

## Règle

Un mécanisme neuf n'entre dans cadence 2 qu'avec un rapport de banc où il gagne.
