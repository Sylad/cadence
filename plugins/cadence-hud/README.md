# cadence-hud

Bande au-dessus du prompt de Claude Code (terminal et app de bureau), rafraîchie toutes les 5 s :

```
ctx ▰▰▰▰▱▱▱▱▱▱  42 % 84k/200k  │  5h  23 % ↻ 2 h 10  │  7j  61 % ↻ 6 j 15 h  │  $1.23  │  fable 410k $0.95 | sonnet 85k $0.12  │  ⚙ 2 agents nom, nom
⟳ cadence · 2026-10-07-2131 en cours  │  budget ▱▱▱▱▱▱▱▱▱▱   1 % 14k/2M  │  1 session/2
  L112  implémente  implement@sonnet 34 s         global-setup coupe le cache de compilation de Node...
  L75   corrige     fix@sonnet 3 min +1 ✝ · p2    raf show aligne les lignes suivantes d'une note...
  L107  prêt                                      Titre public trop long attrapé avant le push : raf...
        en attente  L101 · L106 · L107 · L111 · L113 · L73
```

- `ctx` — contexte de la session, coloré vert / orange / rouge (seuils 50 % et 75 %) ;
- `5h`, `7j` — fenêtres de quota (seuils 60 % et 85 %) et temps avant remise à zéro, en jours au-delà de 24 h ;
- `$1.23` — coût de la session ;
- `fable 410k $0.95 | sonnet 85k $0.12` — consommation **par modèle** sur la session, du plus cher au moins cher :
  tokens traités (entrée + sortie + cache) et part du coût. Alimentée à chaque fin de tour (boucle principale et
  sous-agents) : les tokens sont ceux que l'API a rapportés pour le modèle qui a répondu ; la part de coût est ce
  que le total de `/cost` a gagné depuis la fin de tour précédente, donc approximative quand deux tours finissent
  ensemble, mais la somme des parts reste le total. Les fenêtres de quota (`5h`, `7j`) restent celles que l'API
  renvoie : elle n'en publie pas de propre à un modèle ;
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

Quand la fenêtre est étroite, la première ligne ne se replie pas : ses segments tombent par priorité jusqu'à tenir sur
la largeur — d'abord les noms des agents, puis les heures de remise à zéro, puis la consommation par modèle, le coût,
le compteur d'agents, et en dernier les fenêtres de quota ; le contexte reste toujours. La largeur se mesure en
cellules de terminal, au pire cas : `▰ ▱ ⚙ │ ↻` (largeur ambiguë) comptent pour 2, de sorte que la ligne tient aussi
dans un terminal réglé en *ambiguous width = 2* — au prix de lâcher un segment un peu plus tôt dans un terminal en
largeur 1. Ce sont les seuls caractères non ASCII de cette ligne : les séparateurs (` | `), les points de
suspension (`...`), les valeurs inconnues (`-`) et le libellé de la limite de dépense (`EUR`, pas `€`) sont en ASCII, sans table de largeurs à entretenir. Seuls les
noms d'agents et de modèles, repris tels quels, peuvent encore y mettre un caractère ambigu. Les en-têtes de vague sont
tronqués en fin de ligne.

`/hud` masque ou réaffiche la bande.

Les vagues sont lues sur disque (`~/.cadence/orchestrate/waves/<pid>.json`, puis `<cwd>/.cadence/runs/<vague>/`),
par le script python de `hooks/collect.ts` ; aucune commande cadence n'est lancée.

Installer depuis la marketplace du dépôt cadence : `/plugin marketplace add Sylad/cadence` puis
`/plugin install cadence-hud@cadence`.

Vérifier : `claude plugin validate <dossier>` · `claude plugin test <dossier>` · `tsc -p <dossier>` une fois chargé.
Charger ailleurs qu'ici : `claude --plugin-dir <dossier>` ou la variable `CLAUDE_CODE_PLUGIN_DIRS=<dossier>`.
