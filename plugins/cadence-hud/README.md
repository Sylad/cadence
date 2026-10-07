# cadence-hud

Bande au-dessus du prompt de Claude Code (terminal et app de bureau), rafraîchie toutes les 5 s :

- `ctx ▰▰▰▰▱▱▱▱▱▱ 42 % 84k/200k` — contexte de la session, coloré vert / orange / rouge (seuils 50 % et 75 %) ;
- `5h 23 % ↻ 2 h 10 · 7j 61 % ↻ 3 j` — fenêtres de quota (seuils 60 % et 85 %) et temps avant remise à zéro ;
- `$1.23` — coût de la session ;
- `⚙ 2 agents nom, nom` — sous-agents de CETTE session en cours ;
- une ligne par vague `cadence orchestrate` vivante : identifiant, statut, budget consommé / plafond,
  sessions en cours / plafond, lots en attente, puis chaque lot (`cadence:L75 corrige · fix@sonnet 3 min`),
  coloré par statut (prêt = vert, question / suspendu = orange, échec / rendu = rouge, en attente = gris) ;
  `+N` = sessions claude filles de l'étape, `✝` = l'étape est marquée en cours mais son processus est mort.

`/hud` masque ou réaffiche la bande.

Les vagues sont lues sur disque (`~/.cadence/orchestrate/waves/<pid>.json`, puis `<cwd>/.cadence/runs/<vague>/`),
par le script python de `hooks/collect.ts` ; aucune commande cadence n'est lancée.

Vérifier : `claude plugin validate <dossier>` · `claude plugin test <dossier>` · `tsc -p <dossier>` une fois chargé.
Charger ailleurs qu'ici : `claude --plugin-dir <dossier>` ou la variable `CLAUDE_CODE_PLUGIN_DIRS=<dossier>`.
