# Mesure avant/après de l'auto-contrôle avant revue (L222)

La liste d'auto-contrôle des briefs `implement` et `fix` n'est pas encore en service au 2026-10-15 : la copie en service (release 72c4b49add4d, 1.5.0) ne contient pas la liste (`grep -c 'Self-check' templates/orchestrate/implement.md` y donne 0), et le lead ne la met à jour qu'après la revue (`npm run service -- <sha>`). La borne de l'avant est donc l'heure de cette mise en service, `<borne>` ci-dessous, à relever par le lead au `npm run service` du sha qui porte la liste (`stat -c %y ~/.local/share/cadence/service`, en UTC) ; l'heure du commit cf981af (2026-10-15T17:19Z) n'est pas cette borne. Ce document consigne la mesure des passes de correction par lot, avant et après. Aucune option n'est ajoutée à `cadence corrections` : l'avant est la commande bornée par `--until` à l'heure de mise en service ; sans borne, la commande lit tous les journaux, donc son résultat contient l'avant. L'après se calcule par différence des deux sorties.

## Avant

```
cadence corrections <dossier-des-projets> --cache docs/mesures/corrections-classement.json --until <borne> --json
```

Relevé provisoire du 2026-10-15, avant toute mise en service, donc sans borne ; à rejouer avec `--until <borne>` : 492 lots, 514 passes de correction, 303 lots à au moins une correction, 174 à au moins deux.

## Tout, sans borne

```
cadence corrections <dossier-des-projets> --cache docs/mesures/corrections-classement.json --json
```

À relever par le lead une fois des vagues terminées avec la liste en service (aucune au 2026-10-15 : sans borne, 493 lots et 514 passes, soit le même résultat que l'avant à un lot près).

## Après (par différence)

Après = sortie sans borne − sortie `--until <borne>`, champ par champ (`total.lots`, `total.passes`, `total.atLeast1`, `total.atLeast2`). Les tables n'ont pas de détail par lot : la comparaison porte sur ces agrégats, par projet, par cause et par visibilité. Comparer aussi la part des causes « test manquant » et « dérive d'architecture » dans les passes avant et après.

| | Lots | Passes de correction | Passes par lot | Lots à ≥ 1 correction | Lots à ≥ 2 corrections |
|---|---|---|---|---|---|
| Avant (`--until <borne>`) | 492 | 514 | 1,04 | 303 | 174 |
| Sans borne | à relever | à relever | à relever | à relever | à relever |
| Après (sans borne − avant) | à relever | à relever | à relever | à relever | à relever |

Limite : tant qu'aucune vague n'a tourné avec la liste, la ligne « après » reste vide ; ce document est à compléter, il n'affirme aucun gain.
