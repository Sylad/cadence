# Mesure avant/après du brief d'implémentation enrichi (L523)

Le brief `implement` porte désormais la grille du code-reviewer, l'ordre « tests des cas limites d'abord, relecture contre la grille avant le dernier commit », et, après un précheck, la lecture qu'il a faite (fichiers concernés, code voisin à imiter, tests existants). Ce document est le protocole qui mesure l'effet, et la ligne « avant » relevée par l'étude L517 (`docs/mesures/temps-d-un-lot.md`). Au moment de l'implémentation de L523 la copie en service de l'outil ne contient pas encore le brief enrichi (le lead ne la met à jour qu'après la revue, `npm run service -- <sha>`) : il n'existe donc aucune vague créée avec lui, et la ligne « après » est un emplacement à renseigner. Aucun chiffre « après » n'est écrit ici.

## Les trois mesures

Elles se relèvent avec `scripts/temps-d-un-lot.mjs` (livré par L517 ; il peut manquer d'une branche qui n'a pas encore reçu L517, ce document ne fait que le nommer) :

- les **passes par lot** : passes de correction divisées par les lots de la fenêtre ;
- la **cause des passes** : la part de `bug-code` (dont les cas limites) et de `derive-architecture` parmi les passes classées ;
- les **allers-retours de lecture** par lot : appels de lecture (Read, Grep, Glob, `grep`, `cat`, `git show`…) des sessions du lot.

## Borne

La borne est `<borne>` à relever : l'heure de la mise en service du brief enrichi, relevée par le lead hors vague, entre deux sessions (`date -u -d "$(stat -c %y ~/.local/share/cadence/service)" +%FT%TZ`, en UTC, après le `npm run service` du sha qui porte L523). Même règle que L222 ([autocontrole-avant-revue-2026-10-15.md](autocontrole-avant-revue-2026-10-15.md)) : c'est la date de création de la vague, `created` de son `wave.json`, qui dit si un lot a reçu le brief, non le début de l'`implement` : une vague rend tous ses briefs depuis la copie de l'outil figée à sa création.

- l'**avant** rejoue le script sur les lots des vagues créées jusqu'à la borne (`--until <borne>`) ;
- l'**après** le rejoue sur les lots des vagues créées après elle (`--since <borne>`).

```
node scripts/temps-d-un-lot.mjs --runs <dossier-des-projets>/.cadence/runs --until <borne> --corrections corrections.json
node scripts/temps-d-un-lot.mjs --runs <dossier-des-projets>/.cadence/runs --since <borne> --corrections corrections.json
```

où `corrections.json` est la sortie de `cadence corrections <dossier-des-projets> --classify --cache docs/mesures/corrections-classement.json --json` (même fenêtre).

La borne est **invalide quand une vague à cheval est encore reprenable** : une vague créée avant la borne, interrompue ou suspendue, qui serait reprise (`--resume`) après elle voit des passes se terminer après la borne, que ni `--until` ni `--since` ne lisent. Avant de relever la borne, terminer ces vagues ou ne plus les reprendre (liste : `jq -r 'select(.status != "done") | "\(.id) \(.status) \(.created)"' <dossier-des-projets>/.cadence/runs/*/wave.json`) ; sinon la reposer hors vague et rejouer les deux commandes.

## Résultats

| | Passes par lot | Part de bug-code (dont cas limites) | Part de dérive d'architecture | Allers-retours de lecture par lot |
|---|---|---|---|---|
| Avant (étude L517, 17-10 → 01-11) | 0,85 (620 passes, 730 lots) | 52 % (301 passes, dont 223 cas limites) | 10 % (58 passes) | 13,4 |
| Après (`--since <borne>`) | à renseigner | à renseigner | à renseigner | à renseigner |

Limite : tant qu'aucune vague n'a tourné avec le brief enrichi, la ligne « après » reste à renseigner par le lead ; ce document n'affirme aucun gain. Le sens attendu : moins de passes par lot, une part de `bug-code` et de dérive d'architecture en baisse, moins d'allers-retours de lecture quand le précheck a rendu sa lecture. Les lots sans précheck ne reçoivent pas la lecture : seule la grille et l'ordre « cas limites d'abord » les concernent.
