# cadence-hud

Bande au-dessus du prompt de Claude Code (terminal et app de bureau), rafraîchie toutes les 5 s :

```
ctx ▰▰▰▰▱▱▱▱▱▱  42 % 84k/200k  │  5h  23 % ↻ 2 h 10  │  7j  61 % ↻ 6 j 15 h  │  $1.23  │  fable 410k sonnet 85k  │  ⚙ 2 agents nom, nom  │  2 cmd
⟳ cadence · 2026-10-07-2131 en cours  │  budget ▱▱▱▱▱▱▱▱▱▱   1 % 14k/2M  │  1 session/2
  L112  implémente  implement@sonnet 34 s         global-setup coupe le cache de compilation de Node...
  L75   corrige     fix@sonnet 3 min +1 ✝ · p2    raf show aligne les lignes suivantes d'une note...
  L107  prêt                                      Titre public trop long attrapé avant le push : raf...
        en attente  L101 · L106 · L107 · L111 · L113 · L73
```

- `ctx` — contexte de la session, coloré vert / orange / rouge (seuils 50 % et 75 %) ;
- `5h`, `7j` — fenêtres de quota (seuils 60 % et 85 %) et temps avant remise à zéro, en jours au-delà de 24 h ;
- `$1.23` — coût de la session ;
- `fable 410k sonnet 85k` — consommation **par modèle** sur la session, du plus cher au moins cher : tokens
  traités (entrée + sortie + cache), sur 40 caractères au plus (le reste est coupé par `...`). Alimentée à chaque
  fin de tour (boucle principale et sous-agents) : les tokens sont ceux que l'API a rapportés pour le modèle qui a
  répondu ; l'ordre vient de la part de coût de chaque modèle (ce que le total de `/cost` a gagné depuis la fin de
  tour précédente, approximative quand deux tours finissent ensemble), qui n'est pas affichée. Les fenêtres de
  quota (`5h`, `7j`) restent celles que l'API renvoie : elle n'en publie pas de propre à un modèle ;
- `⚙ 2 agents nom, nom` — sous-agents de CETTE session en cours ;
- `2 cmd` — **commandes d'arrière-plan** de la session en cours, celles de la carte « commandes en arrière-plan »
  de la fenêtre : Bash lancé en arrière-plan (`run_in_background`, Ctrl+B, délai dépassé) et Monitor, y compris
  ceux des sous-agents (sauf le cas ci-dessous). Le mod les suit à leur lancement (résultat de l'appel d'outil), les retire à la notification
  de fin de la tâche (terminée, échouée, arrêtée, ou l'expiration d'un Monitor « [Monitor expired …] ») ou à un
  `TaskStop`, et n'affiche rien à zéro ; elle tombe avec le compteur d'agents quand la fenêtre est étroite. Une
  commande lancée par un sous-agent est retirée quand ce sous-agent finit (sa propre notification de fin revient au
  sous-agent, jamais à la session) ; la session, et un rechargement à chaud du mod, partent de zéro commande. Une
  commande lancée avant le chargement du mod, ou dont la
  notification n'arrive pas, n'est pas vue : le compteur ne remonte qu'aux lancements qu'il a vus. Une commande
  lancée par un sous-agent synchrone (`backgroundEndsWithFinalResponse: true` dans le résultat) n'est pas comptée
  non plus : elle prend fin avec la réponse finale du sous-agent, pas à une notification. Trois filets
  complètent les fins vues : un sous-agent propriétaire que `$.agent.list()` donne terminé (ou n'y figure plus)
  emporte ses commandes même si son avis de fin n'est pas passé par la session (la liste est lue après le collecteur,
  pour qu'un sous-agent lancé pendant l'attente ne soit pas pris pour un disparu) ; un `TaskStop` retire la tâche
  même quand son résultat ne la nomme pas (l'`task_id` / `shell_id` de l'appel sert de repli) ; une commande sans
  fin vue depuis **plus d'une heure** (ou dont la fiche manque, donc l'âge est inconnu) n'est plus comptée « en cours »
  (orange) : la bande l'écrit à part, en gris, juste après `N cmd` : `1 cmd sans fin vue`. **`/hud cmd`** liste ce qui est compté : identifiant, outil (Bash / Monitor), origine
  (`session` ou `agent <id>`), âge et nom (description de l'appel, sinon sa commande), avec `(sans fin vue)` sur
  les anciennes ;
- par vague `cadence orchestrate` vivante : un en-tête (projet si tous les lots sont du même, identifiant, statut,
  budget consommé / plafond, sessions en cours / plafond), puis un **tableau des lots actifs** à colonnes alignées —
  lot, statut coloré (prêt = vert, question / suspendu = orange, échec / rendu = rouge), détail de l'étape
  (`+N` = sessions claude filles, `✝` = étape marquée en cours mais processus mort, `pN` = passe), puis le
  début du titre du lot sur la largeur restante — et une seule
  ligne grise `en attente` listant les lots qui n'ont pas démarré. Les lots de projets différents gardent le
  préfixe `projet:` ;
- sans vague vivante, la **dernière vague terminée** du dossier courant reste sur une ligne grise avec son statut
  (`terminée` / `interrompue il y a 12 min`) et le bilan de ses lots (`3 prêts · 1 échec · 3 suspendus`), **sans
  budget** (il n'a plus d'objet une fois la vague finie) ; elle **disparaît 30 min après sa fin**, ou plus tôt
  quand une nouvelle vague démarre.

Quand la fenêtre est étroite, la première ligne ne se replie pas : ses segments tombent par priorité jusqu'à tenir sur
la largeur — d'abord les noms des agents, puis les heures de remise à zéro, puis la consommation par modèle, le coût,
les compteurs d'agents et de commandes, et en dernier les fenêtres de quota ; le contexte reste toujours. Une fois la ligne tenue, les segments tombés qui
entrent dans la place restante reviennent, du plus utile au moins utile : un gros segment (les modèles) qui ne tient
pas ne prive donc pas la ligne des petits qui tiennent (les heures de remise à zéro). La largeur se mesure en
cellules de terminal, et par défaut au pire cas : `▰ ▱ ⚙ │ ↻` (largeur ambiguë) comptent pour 2, de sorte que la ligne
tient aussi dans un terminal réglé en *ambiguous width = 2* — au prix de lâcher un segment un peu plus tôt dans un
terminal en largeur 1, comme l'app de bureau (jauge et séparateurs y comptent 14 cellules de moins). Pour mesurer à
la largeur de votre terminal, définir `CADENCE_HUD_AMBIGUOUS=1` (ou `2`, le défaut ; toute autre valeur vaut 2) dans
l'environnement de Claude Code, par exemple dans le bloc `env` de `~/.claude/settings.json` ; le mod ne détecte pas le terminal. Ce sont les seuls caractères non ASCII de cette ligne : les séparateurs (` | `), les points de
suspension (`...`), les valeurs inconnues (`-`) et le libellé de la limite de dépense (`EUR`, pas `€`) sont en ASCII, sans table de largeurs à entretenir. Seuls les
noms d'agents et de modèles, repris tels quels, peuvent encore y mettre un caractère ambigu. Les en-têtes de vague sont
tronqués en fin de ligne.

- **avancement des plans** (L149) — sous les vagues, une ligne par projet actif (au moins un lot ouvert), dans l'ordre de
  la clé `priority:` du `cadence.yaml` du dossier de lancement, les autres ensuite par ordre alphabétique :

  ```
  ol      ▮▮▮▮▮▯▯▯▯▯ 39/78 · 0 en cours · +3 cette semaine
  cadence ▮▮▮▮▮▯▯▯▯▯ 10/20 · 2 en cours : L149 L153
  ```

  La barre se colore selon la part de lots faits (L152) : cases pleines en rouge sous 33 %, en orange sous 66 %, en vert au-delà (seuils propres à la barre,
  distincts de ceux de la consommation, 60 % et 85 %) ; les cases vides restent grises.

  Le compte des lots en cours est suivi de leurs ids (`2 en cours : L149 L153`, L153), trois au plus puis `…` (`5 en cours : L1 L2 L3 …`) ; le compte seul à zéro, ou avec un `cadence` trop ancien pour les donner.

  La barre (dix cases) et la fraction comptent les lots faits sur faits + en cours + à faire ; les lots abandonnés et
  les lots récurrents n'y entrent pas. `+N cette semaine` = lots créés sur les 7 derniers jours, aujourd'hui compris (absent à zéro). Les
  chiffres viennent de `cadence lead tour <dossier> --json` (champ `progress`), lancé dans le dossier de lancement de la
  vague, sinon dans le dossier de la session (un dossier parent de projets donne une ligne par projet ; un dossier qui est
  lui-même un projet, sans sous-projet, donne la ligne de ce projet seul) : relu à **chaque transition de vague** (un lot change d'étape ou de
  statut), sinon **toutes les minutes** ; un `cadence` absent ou en échec garde le dernier tableau lu, sans message
  d'erreur dans la bande. **`/hud projets`** replie la liste sur une ligne grise (`▸ projets (2)`) et la rouvre.

`/hud` masque ou réaffiche la bande ; `/hud cmd` liste les commandes d'arrière-plan comptées (voir `N cmd`) ; `/hud projets` replie ou rouvre la liste des projets ; tout autre argument répond `argument inconnu : … (attendu : cmd, projets)` sans masquer la bande.

Les vagues sont lues sur disque (`~/.cadence/orchestrate/waves/<pid>.json`, puis `<cwd>/.cadence/runs/<vague>/`),
par le script python de `hooks/collect.ts` ; aucune commande cadence n'est lancée pour elles. Seul l'avancement des plans
appelle `cadence lead tour --json` (CLI `@sylad/cadence` sur le PATH, facultative).

**La bande écrit aussi un fichier** (elle n'est donc pas en lecture seule) : à chaque rafraîchissement, soit toutes les 5 s,
un `python3` écrit le contexte de la session dans `~/.cadence/orchestrate/hud-context/<id de session>.json`
(`session`, `cwd` = le dossier de la session, `percent`, `tokens`, `window`, `at` ; écriture atomique, un fichier PAR
session). C'est ce que lit `cadence session context` : la session lead ne voit pas la bande, qui n'est qu'un rendu, et le
skill `lead` en tire son seuil de 60 % pour enchaîner sans le humain. La commande lit par défaut le fichier de SA session, celui
que nomme la variable `CLAUDE_CODE_SESSION_ID` (posée par Claude Code dans l'environnement de ses commandes Bash, valeur
identique au nom du fichier) ; `--session <id>` l'emporte. Le dossier courant ne sert que si la variable est absente ET qu'une
seule session publie pour ce dossier ; avec deux sessions dans le même dossier (elles alternent, « la plus récente » serait
parfois celle de l'autre), elle sort en code 2 et demande `--session`. Sans bande chargée dans cette session, ou avec un chiffre de plus de 2 min,
la commande sort en code 2 et le lead n'enchaîne pas : **désactiver ou modifier ce mod coupe donc l'enchaînement du lead**.
Les fichiers de plus de 24 h sont ignorés et supprimés à la lecture de la commande.

Installer depuis la marketplace du dépôt cadence : `/plugin marketplace add Sylad/cadence` puis
`/plugin install cadence-hud@cadence`.

Vérifier : `claude plugin validate <dossier>` · `claude plugin test <dossier>` · `tsc -p <dossier>` une fois chargé.
Charger ailleurs qu'ici : `claude --plugin-dir <dossier>` ou la variable `CLAUDE_CODE_PLUGIN_DIRS=<dossier>`.
