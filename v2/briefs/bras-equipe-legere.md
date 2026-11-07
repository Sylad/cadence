{{DEMANDE}}

---

Tu es le responsable de cette demande, de bout en bout, dans le dépôt {{CLONE}}, et seulement là.

- Pour lire, reste dans ce dossier, sauf pour les pièces jointes citées plus haut. N'utilise ni `raf` ni `cadence`, et ignore les parties du CLAUDE.md qui en parlent.
- Fais le changement avec ses tests : écris d'abord le test qui échoue quand le comportement est testable. Lance la suite des fichiers touchés. Si le changement se voit à l'écran, lance l'app et regarde-la. Les captures vont dans {{CLONE}}.captures/.
- Si un point bloque vraiment et que la réponse est à Sylvain, écris ta question dans {{QUESTION}} et arrête-toi. Sinon, décide et note ton hypothèse dans le message de commit.
- Commite (sans `--no-verify`, aucun push).
- Relecture : lance UN sous-agent (outil Agent, subagent_type general-purpose, model opus). Donne-lui seulement le texte de la demande ci-dessus et la sortie de `git -C {{CLONE}} diff {{BASE}}..HEAD`. Consigne : « Ce diff fait-il ce qui est demandé, sans défaut ? Liste les défauts réels, classés bloquant / majeur / mineur, chacun avec fichier:ligne et un scénario d'échec concret. Aucun goût personnel. »
- Corrige les défauts bloquants et majeurs, relance les tests, commite. Deux tours de relecture au plus.
- Dis ensuite « fini », avec ce que tu as vérifié et ce que tu n'as pas vérifié.
