{{DEMANDE}}

---

Tu es le responsable de cette demande, de bout en bout, dans le dépôt {{CLONE}}, et seulement là.

- Taille fixée par le gardien : {{TAILLE}}. Ne la reclasse pas ; écris-la en première ligne du message de commit : « Taille : {{TAILLE}} ».
- Si {{CLONE}}/.cadence/carte.md existe, lis-le en premier : il décrit les écrans, les workflows et les décisions des demandes précédentes.
- Avant d'écrire du code, lis en entier (outil Read, sans offset, limit ni pages) chaque pièce jointe et chaque document de référence cités par la demande. Un hook refuse toute écriture dans le dépôt tant que ce n'est pas fait.
- Ne touche pas aux réglages de Claude Code (~/.claude/ et tout fichier .claude/settings*.json), ni par un outil ni par une commande : c'est compté comme un contournement.
- Pour lire, reste dans ce dossier, sauf pour les pièces jointes citées plus haut. N'utilise ni `raf` ni `cadence`, et ignore les parties du CLAUDE.md qui en parlent.
- Sorties attendues, AVANT le code : écris dans {{CLONE}}/.cadence/sorties.md une section pour cette demande (crée-le s'il n'existe pas, garde les sections des demandes précédentes). Une ligne par sortie visible : où (écran, panneau, légende, cartouche, URL, réponse d'un service), ce qu'on doit y voir, et pour quelle option ou quel réglage. Ajoute les sorties AILLEURS dans l'application qui montrent la même chose que ce que tu changes : trouve-les par une recherche dans le code (les constantes, styles, clés et fonctions que tu vas toucher, et leurs usages), pas de mémoire. Applique les règles du projet et les règles globales de tes instructions.
- Si la variable d'environnement CADENCE_PORT est définie, d'autres sessions tournent en même temps sur cette machine : lance l'application uniquement sur ce port (`ng serve --port $CADENCE_PORT`), jamais sur un autre.
- Fais le changement avec ses tests : écris d'abord le test qui échoue quand le comportement est testable. Si le changement se voit à l'écran, lance l'app et regarde-la. Les captures vont dans {{CLONE}}.captures/.
- Avant de commiter, lance la suite COMPLÈTE du projet, pas seulement les fichiers touchés. Les tests des demandes précédentes restent verts : ne supprime, n'ignore et n'affaiblis aucun test pour y arriver ; si une demande change un comportement déjà testé, mets ce test à jour et dis-le dans le message de commit.
- Sorties attendues, APRÈS le code : vérifie chaque ligne de ta section sur la vraie sortie (capture de l'application lancée, ou réponse réelle du service) et note à côté « vérifié : <chemin de la capture ou commande> » ou « écart : … ». Corrige les écarts avant de commiter. Une sortie vérifiable par un test devient un test. sorties.md est commité avec le reste.
- À la fin, mets à jour {{CLONE}}/.cadence/carte.md en quelques lignes (crée-le s'il n'existe pas) : écrans, workflows et décisions de cette demande. Il est commité avec le reste.
- Si un point bloque vraiment et que la réponse est à Sylvain, écris ta question dans {{QUESTION}} et arrête-toi. Sinon, décide et note ton hypothèse dans le message de commit.
- Commite (sans `--no-verify`, aucun push).
- Dis ensuite « fini », avec ce que tu as vérifié et ce que tu n'as pas vérifié.
