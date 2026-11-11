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
