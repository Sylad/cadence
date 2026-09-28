# news — design (lot 2 de cadence : Nouveautés)

Date : 2026-09-28. Statut : validé (approche « liée à raf », captures fournies à la main).

## But

Tenir, dans le dépôt, le journal des changements **visibles par l'utilisateur**,
une entrée par lot livré, avec au moins une capture d'écran. Le plan raf dit
quels lots sont visibles ; `raf check` refuse qu'un lot visible soit terminé
sans son entrée. Un build produit un JSON que l'application affiche elle-même
et une page HTML autonome.

## Décisions

| Sujet | Choix |
|---|---|
| Lien avec raf | champ `visible: true` sur un lot (`raf add --visible`, ou à la main) |
| Stockage | un fichier Markdown par entrée, `docs/nouveautes/<date>-<slug>.md`, en-tête YAML |
| Captures | PNG/JPEG/WebP fournis à la main, dans `docs/nouveautes/captures/` ; aucune dépendance navigateur |
| Rendu | Markdown minimal maison (paragraphes, listes `-`, `**gras**`, `` `code` ``, liens), HTML échappé |
| Build | `cadence news build --out <dossier>` → `nouveautes.json`, `index.html`, `captures/` copiées |
| Dépendances | aucune nouvelle (toujours `yaml` seule) |

## Entrée

```markdown
---
title: Les montants « 3.000 » sont lus comme trois mille
date: 2026-09-29
lots: [L8]
captures: [captures/L8-montants.png]
# ou, quand une capture n'a pas de sens :
# nocapture: correction de calcul sans écran dédié
---
Texte destiné à l'utilisateur, pas au développeur.
```

Chemins des captures relatifs au dossier des Nouveautés. `date` au format
AAAA-MM-JJ. Une entrée peut couvrir plusieurs lots.

## Contrôles (`cadence news check`, repris par `raf check`)

- lot `visible` à l'état `done` sans entrée qui le cite ;
- entrée qui cite un lot absent du plan ;
- entrée sans capture et sans `nocapture` ;
- capture déclarée mais absente du disque ;
- en-tête illisible, `title` vide, `date` mal formée.

`raf check` ajoute ces écarts aux siens et sort en code 1. Les lots terminés avant
l'adoption ne sont pas concernés : `visible` est opt-in, l'historique n'en a pas.

## Rappels (jamais bloquants)

- `raf done <lot visible>` sans entrée : « écrire l'entrée : cadence news new L8 ».
- hook post-commit sur un commit qui cite un lot visible sans entrée : même rappel.

## Commandes

| Commande | Effet |
|---|---|
| `cadence news new <lot…> [--title t]` | crée le squelette d'entrée daté (titre du lot par défaut), affiche le chemin |
| `cadence news list` | entrées, plus récentes d'abord |
| `cadence news check` | écarts ci-dessus, code 1 s'il y en a |
| `cadence news build [--out docs/nouveautes/site]` | JSON + page autonome + captures copiées |

Options communes : `--dir` (défaut `docs/nouveautes` à la racine git),
`--file` / `RAF_FILE` pour le plan, `RAF_TODAY`.

## JSON produit

```json
{ "project": "finance-tracker", "generated": "2026-09-29 10:12",
  "entries": [ { "slug": "2026-09-29-l8-montants", "title": "…", "date": "2026-09-29",
                 "lots": ["L8"], "captures": ["captures/L8-montants.png"], "html": "<p>…</p>" } ] }
```

Chemins de captures relatifs au JSON : l'application les résout contre l'URL
du fichier. Entrées triées de la plus récente à la plus ancienne.

## Hors périmètre

Capture automatique (Playwright), numéros de version, flux RSS.
