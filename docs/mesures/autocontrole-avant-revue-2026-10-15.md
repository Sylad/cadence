# Mesure avant/après de l'auto-contrôle avant revue (L222)

La liste d'auto-contrôle des briefs `implement` et `fix` est en service à partir du 2026-10-15. Ce document consigne la mesure des passes de correction par lot, avant et après. Aucune option n'est ajoutée à `cadence corrections` : l'avant est la commande bornée par `--until`, l'après est la même commande sans borne.

## Avant (référence)

Relevé de [corrections-2026-10-10.md](corrections-2026-10-10.md) : 253 passes de correction sur 263 lots, 61 % des lots à au moins une correction, 29 % à au moins deux.

```
cadence corrections <dossier-des-projets> --cache docs/mesures/corrections-classement.json --until 2026-10-15T00:00Z
```

## Après

À relever par le lead une fois des vagues terminées avec la liste en service (aucune n'existe au 2026-10-15) :

```
cadence corrections <dossier-des-projets> --cache docs/mesures/corrections-classement.json
```

Comparer, lot par lot, le nombre de passes `fix` (colonne « passes ») et la part de la cause « test manquant » et « doc » avant et après.

| | Lots | Passes de correction | Passes par lot | Lots à ≥ 1 correction |
|---|---|---|---|---|
| Avant (`--until 2026-10-15T00:00Z`) | à relever | à relever | à relever | à relever |
| Après (sans borne) | à relever | à relever | à relever | à relever |

Limite : tant qu'aucune vague n'a tourné avec la liste, la colonne « après » reste vide ; ce document est à compléter, il n'affirme aucun gain.
