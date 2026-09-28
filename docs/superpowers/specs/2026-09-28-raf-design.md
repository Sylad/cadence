# raf — design (lot 1 de cadence)

Date : 2026-09-28. Statut : validé (nom, langage, Gantt, périmètre).

## But

Un plan de travail « reste à faire » versionné dans le dépôt du projet, tenu par
un CLI, relié aux commits, et visible sous forme de Gantt sans serveur.
Générique : aucune hypothèse sur la stack de l'application suivie.

## Décisions

| Sujet | Choix |
|---|---|
| Dépôt / paquet | `cadence` / `@sylad/cadence` (le nom `cadence` est pris sur npm) |
| Langage | Node ≥ 20, TypeScript, une seule dépendance d'exécution : `yaml` |
| Commandes | `raf` (alias direct) et `cadence raf …` |
| Gantt | fichier HTML autonome généré (données + JS + CSS en ligne, aucun CDN) |
| Licence | MIT |

## Fichier de plan

Chemin par défaut `docs/plan/raf.yaml` à la racine git ; surcharge `--file` ou
`RAF_FILE`. Édité par le CLI via l'API Document de `yaml`, pour que les
commentaires écrits à la main survivent.

```yaml
version: 1
project: finance-tracker
prefix: L            # identifiants L1, L2… ; sous-tâches L3/t1
lots:
  - id: L1
    title: Dédup mensuelle au merge des crédits
    status: todo     # todo | doing | done | dropped
    estimate: 1      # jours ouvrés, défaut 1
    quickwin: false
    after: [L0]      # dépendances (ids)
    created: 2026-09-28
    started: 2026-09-29   # posé par start
    finished: 2026-09-30  # posé par done / drop
    notes:
      - { date: 2026-09-29, text: "décision : …" }
    tasks:
      - { id: t1, title: …, status: done }
```

## Lien avec les commits : calculé, jamais stocké

Un commit appartient à un lot si son message contient l'identifiant comme mot
entier (`L3`, `L3/t1`, préfixe configurable). Les commits sont lus dans
`git log` à chaque commande. Conséquence : le hook ne modifie jamais le fichier
de plan, donc un commit ne laisse jamais l'arbre sale.

## Commandes

| Commande | Effet |
|---|---|
| `raf init [--project n] [--no-hook]` | crée le fichier et installe le hook |
| `raf add "titre" [--estimate n] [--quickwin] [--after L2,L4] [--parent L3]` | ajoute un lot (ou une sous-tâche), affiche l'id |
| `raf start <id>` / `raf done <id>` / `raf drop <id> [--reason t]` | transitions datées |
| `raf note <id> "texte"` | note datée |
| `raf now` | en cours, prochains à faire (quickwins d'abord, dépendances satisfaites), derniers terminés |
| `raf list [--status s]` | liste plate |
| `raf check [--since réf] [--idle n]` | audit, code de sortie 1 si problème |
| `raf gantt [-o fichier]` | HTML autonome, défaut `docs/plan/gantt.html` |
| `raf hook install` / `raf hook post-commit` | hook git non bloquant |

## `raf check`

- commits sans référence de lot depuis `--since` (défaut : 30 derniers jours),
  hors commits dont le message commence par `Merge` ;
- références à un identifiant inconnu ;
- lot `todo` qui a déjà des commits (oubli de `start`) ;
- lot `doing` sans commit depuis `--idle` jours (défaut 7) ;
- lot `done` avec une sous-tâche ouverte ;
- dépendance vers un identifiant inconnu, ou cycle.

## Hook post-commit

`command -v raf >/dev/null 2>&1 && raf hook post-commit || true`. Affiche une
ligne : lot référencé et son statut, ou un avertissement « commit sans lot ».
Jamais bloquant, jamais d'écriture. N'écrase pas un hook existant : il ajoute
sa ligne entre marqueurs.

## Gantt

Planification simple, une seule file de travail :
- `done` : de `started` (ou premier commit) à `finished` ;
- `doing` : de `started` à aujourd'hui + estimation restante (au moins 1 jour) ;
- `todo` : à la suite, dans l'ordre du fichier, après la fin de ses dépendances,
  en jours ouvrés ;
- `dropped` : masqué (case à cocher pour l'afficher).
Rendu SVG en JS, ligne « aujourd'hui », couleur par statut, marque quickwin,
infobulle avec notes et nombre de commits, tableau sous le diagramme.

## Hors lot 1

Nouveautés, skills /reprise /cloture /livrer, modèles d'agents, publication npm
et création du dépôt GitHub (demandées explicitement à Sylvain le moment venu).

## Tests

Vitest : modèle (transitions, ids, sous-tâches), planification Gantt (dates
figées), `check` sur dépôt git temporaire, préservation des commentaires YAML,
CLI de bout en bout sur dépôt temporaire.
