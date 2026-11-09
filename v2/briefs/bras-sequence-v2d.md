{{DEMANDE}}

---

Tu es le responsable de cette demande, de bout en bout, dans le dépôt {{CLONE}}, et seulement là.

- Taille fixée par le gardien : {{TAILLE}}. Ne la reclasse pas ; écris-la en première ligne du message de commit : « Taille : {{TAILLE}} ».
- Si {{CLONE}}/.cadence/carte.md existe, lis-le en premier : il décrit les écrans, les workflows et les décisions des demandes précédentes.
- Registre des demandes : {{CLONE}}/.cadence/demandes/ garde chaque demande de Sylvain, une par document D-<n>.json avec les champs id, texte, etat (ouverte, livrée, vérifiée ou abandonnée) et preuve. Lis-les tous au début (crée le dossier s'il n'existe pas).
- Crée une entrée pour CHAQUE demande que contient le texte ci-dessus, y compris une phrase « pour plus tard » ou « au passage » : texte mot pour mot, état « ouverte ». Annonce-la en une ligne : « Noté D-<n> : … ». Ne réécris jamais le texte d'une entrée existante.
- Avant d'écrire du code, lis en entier (outil Read, sans offset, limit ni pages) chaque pièce jointe et chaque document de référence cités par la demande. Un hook refuse toute écriture dans le dépôt tant que ce n'est pas fait.
- Ne touche pas aux réglages de Claude Code (~/.claude/ et tout fichier .claude/settings*.json), ni par un outil ni par une commande : c'est compté comme un contournement.
- Pour lire, reste dans ce dossier, sauf pour les pièces jointes citées plus haut. N'utilise ni `raf` ni `cadence`, et ignore les parties du CLAUDE.md qui en parlent.
- Si la variable d'environnement CADENCE_PORT est définie, d'autres sessions tournent en même temps sur cette machine : lance l'application uniquement sur le port qu'elle indique, et arrête-la en tuant le numéro de processus que tu as lancé, jamais par son nom (ni pkill, ni killall, ni pgrep -f).
- Fais le changement avec ses tests : écris d'abord le test qui échoue quand le comportement est testable. Si le changement se voit à l'écran, lance l'app et regarde-la. Les captures vont dans {{CLONE}}.captures/.
- Avant de commiter, lance la suite COMPLÈTE du projet, pas seulement les fichiers touchés. Les tests des demandes précédentes restent verts : ne supprime, n'ignore et n'affaiblis aucun test pour y arriver ; si une demande change un comportement déjà testé, mets ce test à jour et dis-le dans le message de commit.
- À la fin, mets à jour {{CLONE}}/.cadence/carte.md en quelques lignes (crée-le s'il n'existe pas) : écrans, workflows et décisions de cette demande. Il est commité avec le reste.
- Si un point bloque vraiment et que la réponse est à Sylvain, écris ta question dans {{QUESTION}} et arrête-toi. Sinon, décide et note ton hypothèse dans le message de commit.
- Avant de commiter, relis le registre : traite chaque demande ouverte qui s'applique maintenant, celle-ci comme les précédentes, et passe-la à « livrée » avec sa preuve (commit, test ou commande et sa sortie). Une demande qui ne s'applique pas encore reste « ouverte ». Le registre est commité avec le reste.
- Commite (sans `--no-verify`, aucun push).
- Dis ensuite « fini », avec ce que tu as vérifié et ce que tu n'as pas vérifié.
