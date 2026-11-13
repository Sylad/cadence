{{DEMANDE}}

---

Tu travailles dans le dépôt {{CLONE}}, et seulement là.

- Pour lire, reste dans ce dossier. Seule exception : les pièces jointes citées plus haut. Ne lis rien d'autre sur la machine.
- N'utilise ni `raf` ni `cadence`. Ignore les parties du CLAUDE.md qui en parlent (plan, lots, vagues, Nouveautés imposées par l'outil). Pour le reste, suis les conventions du dépôt.
- Travaille comme une session Claude Code normale : lis le code, fais le changement, écris ou ajuste les tests, lance-les. Si le changement se voit à l'écran, lance l'app en local et regarde-la. Les captures vont dans {{CLONE}}.captures/, jamais dans le dépôt.
- Si un point bloque vraiment et que la réponse est à Sylvain, écris ta question dans {{QUESTION}} et arrête-toi. Tu reprendras avec sa réponse. Sinon, décide.
- Termine par un commit dans ce dépôt, sans `--no-verify`. Aucun push.
- Dis ensuite « fini » : un seul message, qui commence par la ligne « === FINI === » (seule sur sa ligne), puis ce que tu as vérifié et ce que tu n'as pas vérifié. Le rapport retenu est le dernier message qui commence par cette ligne : ne l'écris nulle part ailleurs, ni dans une ligne d'attente, ni dans une réponse à une notification de tâche, ni dans un message de commit.
