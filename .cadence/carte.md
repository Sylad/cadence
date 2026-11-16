# Carte

## cadence release : rejeu de la CI de publication (L698, D-14, D-16, D-17)

- Workflow : `cadence release` clone le commit de version, lit `.github/workflows/*` déclenchés par un tag **dans le clone**, rejoue les étapes reconnues (src/release-ci.ts), refuse au premier rouge, retire le clone.
- Décision D-17 (revue r2) : les scripts de cycle de vie de `npm ci` (preinstall, install, postinstall, prepublish, preprepare, prepare, postprepare), aussi dans les paquets de workspaces, sont **contrôlés** comme les autres plutôt que coupés par `--ignore-scripts` (2 dépendances du dépôt ont des scripts d'installation : la CI les joue, le rejeu aussi).
- Environnement : **liste blanche** de variables (VARIABLE_TRANSMISE), HOME temporaire, cales qui échouent pour ssh, scp, sftp, kubectl, helm, gh, docker en tête du PATH. Limite assumée et écrite dans docs/releasing.md : ce n'est pas un bac à sable (`/usr/bin/ssh` par chemin absolu lit encore ~/.ssh).
- `working-directory` (étape, puis defaults.run du job, puis du workflow) est honoré ; calculé, absolu, hors du clone ou absent : refusé. Un job sous `if:` n'est pas rejoué.
- Les tests du paquet jouet écrivent leur trace dans un chemin écrit dans trace.cjs (plus de variable ACME_TRACE, que la liste blanche ne transmet pas).
- rsync n'est pas coupé : la suite de cadence s'en sert en local (mise-en-service) ; un rsync distant passe par la cale ssh. Rejeu réel vert sur ac87f32b (350 s).

## cadence run et lead tour : le quota (L700, D-15)

- Workflow : une session `claude -p` dont le résultat COMMENCE par « You've hit your weekly limit · resets <jour heure> » met le run à l'état `quota` (v2/src/run/quota.ts lit jour, heure, fuseau entre parenthèses ; heure illisible = pas de reprise seule). Le run rend la branche (fin()), attend, puis reprend la même session (`--resume`, même worktree, même modèle) une minute après la remise à zéro ; il relit son état toutes les 10 min (un `--reponse` arrête l'attente), 5 reprises au plus.
- « You've hit your Opus limit » : bascule sur fable dans la même session, sans attendre ; jamais sur la limite hebdo (elle bloque tous les modèles, Fable compris : vécu le 10-11).
- Écrans : `cadence run --liste` ajoute « · limite hebdo, reprise après AAAA-MM-JJ HH:MM » ; `cadence lead tour` imprime toujours une ligne `quota hebdo : N % · remise à zéro dans …` (⚠ au-delà de 80 %, âge au-delà de 15 min, « relevé périmé » après la remise à zéro, « inconnu » sans fichier), puis une ligne par run en quota (src/quota-tour.ts).
- La bande cadence-hud écrit `~/.cadence/orchestrate/hud-quota.json` (`percent`, `resetsAt`, `at`) depuis `rate_limits.seven_day` à chaque rafraîchissement : un seul fichier, la limite hebdo est celle du compte.
- Revue L700 r1 (D-18) : un seul processus joue ou attend un run. Verrou `<run>.verrou` à côté de l'état (`{ pid, start, role: session|attente, depuis }`, v2/src/verrou.ts, pose atomique par lien, porteur mort = pid absent ou start différent). Décision : un `--reponse` sur un run tenu par un vivant est **refusé** (pas de prise de main automatique : tuer un processus qui passe de l'attente à la session pourrait laisser un claude orphelin) ; le message donne `kill <pid>`, puis relancer.
- Écrans : `--liste` « reprise seule après … (processus N en attente) » ou « attente arrêtée (aucun processus n'attend ; reprise prévue …) : reprendre : cadence run --reponse <id> "reprends" » ; `lead tour` idem (« avant : kill N, puis … »). Le jour, le mois et l'heure de « resets … » se lisent hors de la parenthèse du fuseau.

## cadence run et le registre des demandes (L701)

- Sans option : consigne du lead, rien n'entre dans `.cadence/demandes/` (lignes du brief v2d sur le registre retirées, porte qui refuse tout fichier du registre touché). `--demande-humaine` inscrit la demande sous le D-<n> suivant ; `--registre D-n` complète une entrée commitée (lot, id du run).
- Revue r1 : avec `--registre D-n`, le brief v2d perd seulement « Crée une entrée pour CHAQUE demande » (lecture et relecture du registre gardées, test sur le brief rendu en mode complet) ; la porte refuse toute entrée **neuve** autre que D-n (`git diff --diff-filter=A`), reprise une fois sinon porte-rouge. Passer une autre entrée à « livrée » reste permis. `--demande-humaine` garde le brief entier.
- D-8 à D-12, D-14, D-16, D-17 et D-18 : `abandonnée`, raison « consigne du lead, pas une demande de l'humain », texte intact, ancien état dans `etat_avant_abandon`.

## Coût : une seule grille pour perf, orchestrate et cadence cost (L704, revue r1)

- `stepEuros` (src/cost.ts) chiffre l'écriture de cache à `cacheWritePrice` (cacheWrite de `perf.prices`, sinon entrée × 2, avec avertissement) : perf, table et `--status` d'orchestrate, `cadence cost`.
- Décision revue r1 : une étape qui ne porte que `counted` (journal ancien) **et** le budget chiffré par `orchestrate --dry-run` se répartissent `COUNTED_WRITE_SHARE` = 90 % en écriture de cache, 10 % en sortie (l'entrée hors cache, une centaine de tokens, est négligée comme dans `cadence cost`). Avant : 90 % au prix d'entrée.
- Écran : `a:L1 — estimation du lot : 5,17 € (budget de 750000 tokens au prix sonnet, 90 % en écriture de cache)`. Test : test/orchestrate-estimation-cache-l704.test.ts.

## Banc v2 : environnement d'un passage (L742, revue r1)

- Chaque rapport de banc (court, mécanique, micro, bruit, éclair, séquence) porte en tête la version de Claude Code, le modèle exact de chaque bras, le contexte max et les réglages suivis (v2/src/bench/environnement.ts), comparés au rapport précédent de `rapports/`.
- Écran : la ligne `⚠ Environnement différent de <passage> : …` s'imprime sur la sortie du passage, **séquences comprises** (`conclureSequence` reçoit `out`, une fois par répétition).
- Décision revue r1 : les autres modèles facturés (sous-agents, `modelUsage`) sont écrits mais **jamais comparés** — lancer un sous-agent dépend de la session, pas de l'environnement ; `CLAUDE_CODE_SUBAGENT_MODEL` reste un réglage suivi, comparé.
- Tests : v2/test/environnement-l742.test.ts (« sessions : », « Réglages de », CLAUDE_CONFIG_DIR, fichier illisible, claude absent ou muet, contexte max, sous-agent sans ⚠), v2/test/sequence-cli.test.ts (⚠ sur la sortie d'une séquence).

## Livreur sans clé deliver et lead.ux absent (L744, revue r1)

- Décision : `lead.ux` absent du brief vaut `human` (défaut de docs/lead.md), jamais « brief incomplet ». Sans clé `deliver:` dans cadence.yaml (lue par `grep -n '^deliver:'` avant toute commande), le livreur pousse le sha puis le commit du plan par son propre sha (seulement s'il est posé juste sur le sha), ne lance jamais `cadence deliver`, et rend `L84 poussé 3d6edf4 avec le commit du plan 9a1b2c3, rien à déployer (pas de clé deliver)`.
- Revue r1 : la fiche docs/specs/livreur-delegue/fiche.yaml (C1, R3, R10, R14, contrat A1), docs/skills.md et skills/lead/SKILL.md disent la même chose qu'agents/livreur.md. Test : test/livreur-delegue.test.ts lit la fiche (YAML) et les deux docs.

## cadence run --clore et --archives : run intégré à la main (L745, 5e passe : changement de conception)

- Décision (5e passe, après quatre revues non conformes) : on ne cherche plus à prouver qu'un run est intégré avant de supprimer. `--liste` ne fait qu'afficher ; `--clore` ne retire rien qu'il n'ait d'abord archivé. Retirés : patch-id, tableau de dix cas, reconnaissance par le contenu, `--force`.
- Écran `--liste` : `integre a la main` seulement si la tête de la branche du run (sinon la tête notée `tete`) est un ancêtre de la cible (`merge-base --is-ancestor`) et que le run a un commit ; sinon l'état du run, puis une ligne `    commits absents de la cible : N — main ; clore en archivant son travail : cadence run --clore <id>`. Clos : `integre a la main (main = sha), clos le …` ou `clos le … sans intégration, travail archivé : cadence run --archives`.
- Workflow `--clore <id>` (v2/src/run/clore.ts) : têtes connues (branche → `refs/cadence/archive/<id>`, HEAD du worktree lu dans `git worktree list --porcelain`, détaché ou dossier supprimé compris → `<id>-worktree`, tête notée → `<id>-fin`), archives posées puis relues (jamais écrasées ; un échec = refus, rien retiré), dossier du worktree retiré par `git worktree remove` sans `--force` et seulement si `git status --untracked-files=all --ignore-submodules=none` est vide (sinon il reste, HEAD détaché, et la sortie dit pourquoi), branche retirée, état `clos` (`integre`, `archives`, `restes`). Clôt aussi un run non intégré ; refuse un run qui se reprend ou intégré par cadence run.
- Écran `--archives` : une ligne par archive (ref, sha court, date, sujet) et dessous `restaurer : git branch archive-<id> <ref>`.
- Hypothèse : un worktree avec un sous-module initialisé n'est jamais retiré (refus de git), plus strict que « aucun commit de sous-module non poussé ». Limites écrites dans la doc : fichiers ignorés du worktree, commits atteignables par le seul reflog, et l'intégration normale par `cadence run` qui retire encore son worktree avec `--force` (sous-module non poussé, hors de ce lot).
- `--reponse` refuse un run clos. Budget run 845. Le mot « contrat » est interdit dans v2/src (anti-rechute C1).
