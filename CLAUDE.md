# cadence — bornes des fichiers

Chaque fichier ci-dessous a une borne qu’une porte vérifie ; la dépasser coûte une porte entière. Les mêmes chiffres sont dans la clé `bounds` de `cadence.yaml` : le brief d'écriture les donne toutes, et le hook `cadence claude-hook bornes` (joint au `--settings` des sessions implement et fix d'une vague) répond la ligne et la limite après chaque écriture.

- `README.md` : 64 lignes et 160 colonnes au plus (hors lignes de balise `<…>`) ; le détail d'un changement va dans une page de `docs/`, le README ne reçoit qu'un lien. Test : `test/readme-accueil.test.ts`.
- `docs/concepts.md` : 15 Ko au plus (15 360 caractères). Un renvoi vers une autre page sans ancre, plutôt qu'un paragraphe recopié.
- `CHANGELOG.md` : on n'y écrit plus d'entrée (L679). Chaque lot écrit la sienne dans un fragment `changelog.d/<lot>.md` (`changelog.d/L679.md`) : une ou plusieurs rubriques `### Added`, `### Changed`, `### Deprecated`, `### Removed`, `### Fixed` ou `### Security`, chacune suivie de ses entrées ; une suite de revue modifie le fragment du lot. `[Unreleased]` reste vide, jamais d'entrée sous une version publiée ; `cadence release` assemble les fragments dans la section de la version et les retire (voir `changelog.d/README.md`, `docs/releasing.md#changelog-fragments`). Tests : `test/changelog-fragments-l679.test.ts`, `test/changelog.test.ts`, `test/changelog-unreleased-titres-l568.test.ts`.
- toute nouvelle page de docs ajoutée à `docs/` figure dans `files` de `package.json` (elle est publiée avec le paquet). Tests : `test/docs-publiees-l626.test.ts`, `test/orchestrate-pages-l599.test.ts` (liens, navigation et taille des pages orchestrate).

Les tests qui lisent ces fichiers sont déclarés dans `bounds[].tests` : la porte ciblée les joue avec les fichiers du lot, avant la suite complète d'intégration.
