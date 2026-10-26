# Mesure : le parcours d'un nouvel utilisateur (L357)

Un PC Windows 11 dont le WSL (Ubuntu 24.04.5, noyau 6.18) n'avait jamais vu cadence : ni Node, ni `claude`, ni `@sylad/cadence`, ni `~/.npm`. Le parcours suit le README et `docs/` tels que le paquet npm les publie (`@sylad/cadence 1.13.0`), dans l'ordre d'un lead qui pilote deux petits projets. Les temps sont ceux des commandes (`date` autour de chacune, aller-retour SSH et démarrage de WSL compris, environ 0,4 s) ; le temps passé à chercher une solution n'est pas mesuré : il est dit « non mesuré ». Une seule passe, un seul réseau : ce sont des ordres de grandeur, pas des moyennes.

## Parcours

| # | Étape | Commande | Temps | Résultat |
|---|---|---|---|---|
| S1 | Node 22.18 ou plus (le README l'exige, sans dire où le prendre) | `curl -fsSL https://deb.nodesource.com/setup_22.x -o ns.sh && sudo -E bash ns.sh && sudo apt-get install -y nodejs` | 15,0 s | Node 22.23.4, npm 10.9.9 |
| S2 | Installer le paquet (README, « Start ») | `npm install -g @sylad/cadence` | 0,7 s | refusé, EACCES (voir A2) |
| S3 | Idem après un préfixe npm utilisateur | `npm config set prefix ~/.npm-global` puis `npm install -g @sylad/cadence` | 1,1 s | `raf` et `cadence` installés, 2 paquets |
| S4 | Claude Code puis le plugin (README, « Install as a Claude Code plugin ») | `curl -fsSL https://claude.ai/install.sh -o ci.sh && bash ci.sh`, `claude plugin marketplace add Sylad/cadence`, `claude plugin install cadence@cadence` | 13,8 s | `claude` 2.1.310, plugin `cadence@cadence` 1.13.0 activé |
| S5 | Deux dépôts jouets, un plan dans chacun | `git init` puis `raf init` (×2) | 2,5 s | `.cadence/raf.yaml`, hook `post-commit`, `.gitignore` |
| S6 | Un lot jouet par projet, démarré | `raf add "…" --estimate 0.25` puis `raf start L1` | 0,8 s | lots créés ; le commit échoue (voir A6) |
| S7 | Le tour du dossier | `cadence lead tour` | 0,8 s (le programme : 0,13 s) | une ligne par projet, sans `cadence.yaml` dans le dossier parent |
| S8 | Le `cadence.yaml` minimal de chaque projet | `orchestrate.test: "test -f hello.txt"` | 1,1 s (avec `raf todo L1` et le commit) | la ligne « porte de tests absente » disparaît |
| S9 | La vague en simulation | `cadence orchestrate alpha:L1 --dry-run` | 1,1 s | implement (sonnet) → review (sonnet), budget 600 k tokens |
| S10 | Une première vague pour de vrai | `cadence orchestrate alpha:L1 --wave essai` | 4,1 s (avec les deux essais de `deliver` de S11) | échec net : `Not logged in · Please run /login` ; lot rendu au lead |
| S11 | La livraison à blanc | `cadence deliver --dry-run` | 2,3 s (avec le dépôt distant et le commit) | refusée deux fois avec une phrase claire (`clé deliver absente`, puis `au moins une vérification`), puis le plan de livraison |
| S12 | Le plugin, la compétence `lead` | `/lead` dans Claude Code | non joué | voir « Non joué » |

Au total : environ 40 s de commandes, dont 29 s pour installer Node et Claude Code. Le parcours entier a été fait sans lire le code, mais avec `docs/deliver.md` ouvert pour S11.

## Accrocs

Chaque accroc cite la commande, le message reçu, le temps perdu et le lot qu'il justifie. Un accroc dont le message est clair et dont la solution est dite n'est pas un défaut de cadence : il est listé seulement si la page de départ aurait pu l'éviter.

| # | Commande | Message ou constat | Temps perdu | Lot proposé |
|---|---|---|---|---|
| A1 | `npm install -g @sylad/cadence` (machine sans Node) | `npm: command not found` ; le README dit « Needs Node 22.18 or later » sans dire comment l'obtenir | non mesuré (la recherche) ; 15,0 s d'installation | lot : README « Start » — une ligne par système pour obtenir Node 22.18+ (nvm ou NodeSource ; non vérifié : la version du `nodejs` de l'archive Ubuntu, la commande n'ayant rien rendu), vérifiée sur une machine vierge |
| A2 | `npm install -g @sylad/cadence` (Node système installé par `apt`) | `npm error … EACCES: permission denied, mkdir '/usr/lib/node_modules/@sylad'` | 0,7 s, puis la recherche de la solution (non mesuré) | lot : README « Start » — dire le préfixe utilisateur (`npm config set prefix ~/.npm-global` et le `PATH`) avant la première commande, ou conseiller nvm |
| A3 | `raf --version` | `raf: Unknown option '--version'. To specify a positional argument starting with a '-' …` alors que `cadence --version` répond `1.13.0` | 0,4 s | lot : `raf --version` (et `-v`) répondent comme `cadence`, ou le message oriente vers `cadence --version` |
| A4 | `raf init` puis `cadence orchestrate` | `raf init` ne crée pas de `cadence.yaml` ; le README n'en parle pas, `docs/` le décrit clé par clé sans « le minimum qui marche » ; seul le tour avertit (`porte de tests absente … orchestrate.test n'est pas déclaré`) | non mesuré (lecture de `orchestrate.md` et `deliver.md`) | lot : une section « cadence.yaml minimal » (3 à 5 lignes : `orchestrate.test`, `deliver.verify`) dans le README et dans `docs/overview.md`, ou `raf init --config` qui l'écrit |
| A5 | `git commit -m "chore: init raf"` après `raf init` | `raf: commit sans lot — citer un identifiant la prochaine fois (raf now)` ; puis `raf check` rend 2 écarts (`✗ commit sans lot : 00c6183 chore: init raf`), repris par la colonne « dérive » du tour, pour le tout premier commit (le plan lui-même) | 0 s à la commande ; l'écart reste affiché à chaque tour jusqu'à `raf ignore` | lot : `raf init` n'ouvre pas d'écart pour le commit qui ajoute `.cadence/` (ou le README donne la commande `raf ignore <sha>` juste après `raf init`) |
| A6 | `git commit` (identité git absente de la machine) | `fatal: empty ident name (for <user@host>) not allowed` ; le hook `raf` ne dit rien de plus | non mesuré | lot : aucun — message de git, clair ; à citer dans le démarrage en 10 minutes (L358) comme prérequis |
| A7 | `cadence orchestrate alpha:L1` (sans `claude` connecté) | `échec : implement sans résultat : success : Not logged in · Please run /login (code 1)` — le message est exact, mais ni le README ni `docs/orchestrate.md` ne disent avant que la vague lance `claude -p` et qu'il doit être connecté ; le lot reste `doing` avec un commit `plan: L1 démarré (orchestrate essai)` | 1,8 s | lot : README — prérequis « Claude Code installé et connecté » avant `orchestrate` ; `orchestrate` vérifie `claude auth status` avant de démarrer le lot (aucune écriture dans le plan si la session ne peut pas s'ouvrir) |
| A8 | `raf now` après la vague échouée | `L1 … 1 commit(s)` alors que `raf commits L1` ne liste rien et que le tour disait `0 commit` avant la vague : le commit du plan (`plan: L1 démarré`) est compté par l'un et pas par l'autre | 0 s | lot : même définition du compte de commits d'un lot dans `raf now`, `raf commits` et le tour (`plan:` exclu) |
| A9 | `cadence orchestrate alpha:L1 --dry-run` lancé DANS `alpha/` | `orchestrate : alpha:L1 : dossier …/alpha/alpha introuvable` ; le message ne dit pas que `<projet>` est un sous-dossier du dossier courant ni que `.:L1` marche (essayé : oui) | non mesuré | lot : le message ajoute « le projet est un sous-dossier du dossier courant ; dans un dépôt, `.:L1` » |

Ce qui a bien marché, pour que la liste ne se lise pas comme un procès : le plugin s'installe en 14 s avec les commandes de la ligne de commande (`claude plugin …`), `raf init` pose le plan, le hook et le `.gitignore` sans rien demander, le tour marche sans `cadence.yaml` dans le dossier parent, la simulation de la vague montre la commande, le modèle et le budget de chaque étape, et les deux refus de `deliver --dry-run` disent la clé manquante.

## Non joué

- **La compétence `lead` et la vague de bout en bout.** Le WSL de la machine n'est pas connecté à Claude (`claude auth status` : `loggedIn: false`, la vague le dit : `Not logged in`). Se connecter demande le compte de la personne ; une session d'orchestration ne le fait pas à sa place et ne copie pas les identifiants d'une autre machine. La vague s'est donc arrêtée au premier `claude -p` (S10), avant tout travail sur le lot jouet : ni review, ni commits de lot, ni `raf done` n'ont été vus. Le tour (S7), la simulation (S9) et la livraison à blanc (S11), qui n'ouvrent pas de session, ont été joués en entier.
- **Le temps d'une vague complète** : non mesuré, pour la même raison. À relever à la prochaine passe, une fois la machine connectée (les lots A1 à A9 d'abord, pour que la passe suivante parte d'un parcours sans accroc).
- **Les autres systèmes** (macOS, Linux natif, PowerShell sans WSL) : non joués.

## Rejouer

Le dossier jouet est resté sur la machine (`~/atelier/alpha`, `~/atelier/beta`, avec un dépôt distant nu `~/atelier/alpha.git`). Pour repartir de zéro : `rm -rf ~/atelier ~/.npm-global && npm uninstall -g @sylad/cadence`, puis refaire S3 à S11.
