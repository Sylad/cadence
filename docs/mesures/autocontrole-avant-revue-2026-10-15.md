# Mesure avant/après de l'auto-contrôle avant revue (L222)

La liste d'auto-contrôle des briefs `implement` et `fix` n'est pas encore en service au 2026-10-15 : la copie en service (release 72c4b49add4d, 1.5.0) ne contient pas la liste (`grep -c 'Self-check' ~/.local/share/cadence/service/templates/orchestrate/implement.md` y donne 0), et le lead ne la met à jour qu'après la revue (`npm run service -- <sha>`). La borne de la mesure est donc l'heure de cette mise en service, `<borne>` ci-dessous, à relever par le lead au `npm run service` du sha qui porte la liste (`date -u -d "$(stat -c %y ~/.local/share/cadence/service)" +%FT%TZ`, en UTC) ; l'heure du commit cf981af (2026-10-15T17:19Z) n'est pas cette borne.

Ce document consigne les passes de correction par lot, avant et après. Les deux commandes sont symétriques et lisent chacune ce qu'elles comptent, sans soustraction :

- l'**avant** (`--until <borne>`) lit les vagues créées jusqu'à la borne et, dans chacune, les étapes terminées jusque-là ;
- l'**après** (`--since <borne>`) ne garde que les lots dont la première session `implement` aboutie a **commencé** après la borne, avec **toutes** leurs passes. Une vague à cheval sur la borne (`cadence orchestrate --continue`, le cas courant) y est correctement partagée : un lot est dans l'après s'il a reçu le brief avec la liste, quelle que soit la date de création de sa vague. Un lot dont l'`implement` chevauche la borne n'est dans aucune des deux mesures ; un lot sans début lisible n'est pas dans l'après.

Les deux commandes ont `--classify` : sans lui aucun modèle n'est appelé et toute passe absente du cache compte « non classé », ce qui rend la part des causes illisible. Elles demandent donc Ollama (`mistral-small3.2:24b`, hors quota) ; les passes nouvelles sont ajoutées au cache `docs/mesures/corrections-classement.json`, à commiter avec le relevé.

## Avant

```
cadence corrections <dossier-des-projets> --classify --cache docs/mesures/corrections-classement.json --until <borne> --json
```

Relevé provisoire du 2026-10-15, rejoué avec la commande ci-dessus à une borne provisoire `--until 2026-10-15T19:00:00Z` (la mise en service de la liste n'a pas eu lieu : il n'y a pas encore de vraie borne), passes classées par `mistral-small3.2:24b` : 498 lots, 522 passes de correction, 308 lots à au moins une correction, 176 à au moins deux. Causes (en part des 522 passes) : « test manquant » 75 (14,4 %), « dérive d'architecture » 84 (16,1 %), `bug-code` 276, `spec-floue` 59, `regle-inventee` 2, sans constat 26. Ce relevé est à rejouer avec la vraie borne dès la mise en service.

## Après

```
cadence corrections <dossier-des-projets> --classify --cache docs/mesures/corrections-classement.json --since <borne> --json
```

Rejouée à la même borne provisoire (`--since 2026-10-15T19:00:00Z`), la commande donne 0 lot : aucune vague n'a tourné avec la liste. La ligne « après » du tableau reste à relever par le lead, une fois des vagues terminées avec la liste en service ; comparer alors les passes par lot (`total.passes` / `total.lots`), les lots à ≥ 1 et ≥ 2 corrections, et la part des causes « test manquant » et « dérive d'architecture » parmi les passes, par projet et par visibilité.

| | Lots | Passes de correction | Passes par lot | Lots à ≥ 1 correction | Lots à ≥ 2 corrections |
|---|---|---|---|---|---|
| Avant (`--until <borne>`, borne provisoire 2026-10-15T19:00:00Z) | 498 | 522 | 1,05 | 308 | 176 |
| Après (`--since <borne>`) | à relever (0 à la borne provisoire) | à relever | à relever | à relever | à relever |

Limite : tant qu'aucune vague n'a tourné avec la liste, la ligne « après » reste vide ; ce document est à compléter, il n'affirme aucun gain.
