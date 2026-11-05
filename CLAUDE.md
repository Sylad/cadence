# cadence — bornes des fichiers

Chaque fichier ci-dessous a une borne qu’une porte vérifie ; la dépasser coûte une porte entière. Les mêmes chiffres sont dans la clé `bounds` de `cadence.yaml` : le brief d'écriture les donne pour les fichiers que le lot cite, et le hook `cadence claude-hook bornes` répond la ligne et la limite après chaque écriture.

- `README.md` : 64 lignes et 160 colonnes au plus (hors lignes de balise `<…>`) ; le détail d'un changement va dans une page de `docs/`, le README ne reçoit qu'un lien. Test : `test/readme-accueil.test.ts`.
- `docs/concepts.md` : 15 Ko au plus (15 360 caractères). Un renvoi vers une autre page sans ancre, plutôt qu'un paragraphe recopié.
- `CHANGELOG.md` : chaque entrée s'écrit sous `[Unreleased]`, jamais sous une version publiée, sans titre dupliqué dans la section. Tests : `test/changelog.test.ts`, `test/changelog-unreleased-titres-l568.test.ts`.
- toute nouvelle page de docs ajoutée à `docs/` figure dans `files` de `package.json` (elle est publiée avec le paquet). Test : `test/avec-vos-outils.test.ts`.

Les tests qui lisent ces fichiers sont déclarés dans `bounds[].tests` : la porte ciblée les joue avec les fichiers du lot, avant la suite complète d'intégration.
