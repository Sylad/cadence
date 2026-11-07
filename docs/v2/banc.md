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
- Les juges travaillent dans `<racine>/eval/<passage>/<banc>`.
- Un passage s'appelle `<date>-<HHMM>-<empreinte>` ; l'empreinte hache `v2/src` et `v2/briefs` à HEAD.
- Refus (code 2) si `v2/src` ou `v2/briefs` a des changements non commités, ou si `v2/dist/cli.js` est absent ou plus ancien que les sources.
- **Publication** : permise seulement si un passage vert couvre les bancs 1, 3 et 6 sur l'empreinte courante.

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

Options communes : `--candidat <bras>`, `--reference <bras>`, `--juge <modèle>`.

## Installation du timer

```bash
bash v2/systeme/installer.sh
```

Le service lance `cadence2 bench hebdo` avec un `PATH` explicite (node de nvm, `~/.local/bin` pour `claude`) : pas de shell de connexion. Précondition, vérifiée au démarrage du service (échec net dans le journal sinon) : `cadence2` doit être lié au checkout principal, `~/projects/developpeur/cadence/v2` ; pour le corriger : `cd ~/projects/developpeur/cadence/v2 && npm run build && npm link` (l'installeur avertit si le lien pointe ailleurs). Le service vérifie aussi que `node` est sur son `PATH` : après une montée de version nvm, mettre à jour la ligne `Environment=PATH` du service puis relancer l'installeur. Ce checkout doit être propre (rien de non commité sous `v2/src` et `v2/briefs`) et construit (`npm run build` dans `v2`), sinon le passage est refusé. Journal : `~/bench-cadence/hebdo.log`.

## Rattrapage

`Persistent=true` : un samedi manqué (WSL éteint) est rejoué au premier démarrage de WSL suivant.

## Où lire les rapports

- `~/bench-cadence/rapports/<passage>.md` (et `.json`) ;
- `~/bench-cadence/historique.jsonl`, une ligne par passage ;
- `~/bench-cadence/runs/<passage>/<banc>/resultat.json` pour le détail.

## Règle

Un mécanisme neuf n'entre dans cadence 2 qu'avec un rapport de banc où il gagne.
