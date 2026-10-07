# cadence-hud

Bande au-dessus du prompt de Claude Code (terminal et app de bureau), rafraîchie toutes les 5 s :

```
ctx ▰▰▰▰▱▱▱▱▱▱  42 % 84k/200k  │  5h  23 % ↻ 2 h 10  │  7j  61 % ↻ 6 j 15 h  │  $1.23  │  ⚙ 2 agents nom, nom
⟳ cadence · 2026-10-07-2131 en cours  │  budget ▱▱▱▱▱▱▱▱▱▱   1 % 14k/2M  │  1 session/2
  L112  implémente  implement@sonnet 34 s         global-setup coupe le cache de compilation de Node…
  L75   corrige     fix@sonnet 3 min +1 ✝ · p2    raf show aligne les lignes suivantes d'une note…
  L107  prêt                                      Titre public trop long attrapé avant le push : raf…
        en attente  L101 · L106 · L107 · L111 · L113 · L73
```

- `ctx` — contexte de la session, coloré vert / orange / rouge (seuils 50 % et 75 %) ;
- `5h`, `7j` — fenêtres de quota (seuils 60 % et 85 %) et temps avant remise à zéro, en jours au-delà de 24 h ;
- `$1.23` — coût de la session ;
- `⚙ 2 agents nom, nom` — sous-agents de CETTE session en cours ;
- par vague `cadence orchestrate` vivante : un en-tête (projet si tous les lots sont du même, identifiant, statut,
  budget consommé / plafond, sessions en cours / plafond), puis un **tableau des lots actifs** à colonnes alignées —
  lot, statut coloré (prêt = vert, question / suspendu = orange, échec / rendu = rouge), détail de l'étape
  (`+N` = sessions claude filles, `✝` = étape marquée en cours mais processus mort, `pN` = passe), puis le
  début du titre du lot sur la largeur restante — et une seule
  ligne grise `en attente` listant les lots qui n'ont pas démarré. Les lots de projets différents gardent le
  préfixe `projet:` ;
- sans vague vivante, la **dernière vague terminée** du dossier courant reste sur une ligne grise avec son statut
  (`terminée` / `interrompue il y a 12 min`), son budget consommé et le bilan de ses lots (`3 prêts · 1 échec · 3 suspendus`),
  jusqu'à ce qu'une nouvelle vague démarre.

`/hud` masque ou réaffiche la bande.

Les vagues sont lues sur disque (`~/.cadence/orchestrate/waves/<pid>.json`, puis `<cwd>/.cadence/runs/<vague>/`),
par le script python de `hooks/collect.ts` ; aucune commande cadence n'est lancée.

Vérifier : `claude plugin validate <dossier>` · `claude plugin test <dossier>` · `tsc -p <dossier>` une fois chargé.
Charger ailleurs qu'ici : `claude --plugin-dir <dossier>` ou la variable `CLAUDE_CODE_PLUGIN_DIRS=<dossier>`.
