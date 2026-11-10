{{DEMANDE}}

---

Tu fais cette demande toi-même, de bout en bout, dans le dépôt {{CLONE}}, et seulement là. Un seul agent fait tout le lot : toi, dans cette session, avec ton contexte du début à la fin. Pas de sous-agent pour écrire du code ni un par étape, pas de relecteur systématique. Un sous-agent reste permis pour une recherche bornée en lecture seule, quand elle évite de remplir ton contexte.

- Pour lire, reste dans ce dossier, sauf pour les pièces jointes citées plus haut. N'utilise ni `raf` ni `cadence`, et ignore les parties du CLAUDE.md qui en parlent.
- Lis d'abord en entier chaque document, image ou référence que cite la demande (outil Read, jusqu'à la dernière ligne ou la dernière page), avant d'écrire la moindre ligne de code.
- Change de casquette en ouvrant au bon moment les skills et les mémoires utiles (spec, tests, UX…). Le contexte reste le même du début à la fin.
- Écris d'abord le test qui échoue quand le comportement est testable, puis le code.
- Avant de dire « fini », vérifie le résultat sur la vraie sortie : lance l'application et regarde l'écran (capture), ou appelle le service et lis sa réponse. Les captures vont dans {{CLONE}}.captures/.
  - Vérifie aussi les autres endroits qui montrent la même chose : légende, panneaux, libellés, exports, autres écrans.
  - Pour les trouver, cherche dans le code les constantes, styles et fonctions que tu as touchés et leurs usages.
  - Corrige tout écart. Ne déclare jamais fait ce que tu n'as pas vu marcher.
- Si la variable d'environnement CADENCE_PORT est définie, d'autres sessions tournent en même temps sur cette machine : lance l'application uniquement sur le port qu'elle indique, et arrête-la en tuant le numéro de processus que tu as lancé, jamais par son nom (ni pkill, ni killall, ni pgrep -f).
- Lance la suite complète des tests avant de commiter. Ne supprime, n'ignore et n'affaiblis aucun test pour la faire passer. Si la demande change un comportement déjà testé, mets le test à jour et dis-le dans le message de commit.
- Si un point bloque vraiment et que la réponse est à Sylvain, écris ta question dans {{QUESTION}} et arrête-toi. Sinon décide, et note ton hypothèse dans le message de commit.
- Commite (sans `--no-verify`, aucun push).
- Dis ensuite « fini », avec ce que tu as vérifié et ce que tu n'as pas vérifié.
