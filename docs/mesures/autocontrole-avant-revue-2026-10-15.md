# Mesure avant/après de l'auto-contrôle avant revue (L222)

La liste d'auto-contrôle des briefs `implement` et `fix` n'est pas encore en service au 2026-10-15 : la copie en service (release 72c4b49add4d, 1.5.0) ne contient pas la liste (`grep -c 'Self-check' ~/.local/share/cadence/service/templates/orchestrate/implement.md` y donne 0), et le lead ne la met à jour qu'après la revue (`npm run service -- <sha>`). La borne de la mesure est donc l'heure de cette mise en service, `<borne>` ci-dessous, à relever par le lead au `npm run service` du sha qui porte la liste (`date -u -d "$(stat -c %y ~/.local/share/cadence/service)" +%FT%TZ`, en UTC) ; l'heure du commit cf981af (2026-10-15T17:19Z) n'est pas cette borne.

Ce document consigne les passes de correction par lot, avant et après. Les deux commandes sont symétriques et lisent chacune ce qu'elles comptent, sans soustraction :

- l'**avant** (`--until <borne>`) lit les vagues créées jusqu'à la borne et, dans chacune, les étapes terminées jusque-là ;
- l'**après** (`--since <borne>`) ne garde que les lots des vagues **créées** après la borne (`created` de `wave.json`), avec **toutes** leurs passes. Une vague rend tous ses briefs depuis la copie de l'outil figée à sa création (`<vague>/tool/`) : une vague `--continue` créée avant la mise en service ne donne jamais la liste à ses lots, même à ceux qui démarrent après la borne ; c'est donc la date de la vague, non le début de l'`implement`, qui dit si le lot a reçu la liste. Une vague sans date de création lisible n'est dans aucune des deux mesures ; une vague créée pile à la borne est dans l'avant seulement (`--until` inclusif, `--since` strict), les deux mesures ne se recouvrent jamais.

Procédure de la borne : elle se relève hors vague, entre deux sessions (c'est déjà la règle de `npm run service`, jamais pendant une vague), et `cadence orchestrate --status` ne doit montrer aucune vague en cours. Alors aucune vague créée avant la borne n'a de passe terminée après elle, et `--until <borne>` (lots des vagues d'avant, toutes leurs passes) plus `--since <borne>` (vagues créées après) font le total sans borne. La preuve se donne après coup : `cadence corrections <dossier-des-projets> --json` (sans borne) a ses champs `total`, `byProject` et `byVisibility` égaux, champ par champ, à la somme de ceux des deux commandes (hors vagues sans date de création lisible). Un écart a un seul sens : une vague à cheval, créée avant la borne et dont une passe s'est terminée après elle ; `--until` ne lit pas cette passe (c'est ce qui fige un relevé publié, cf. `corrections-2026-10-10.md`), `--since` non plus. La borne est alors invalide : la reposer hors vague et rejouer les deux commandes.

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
