# Carte

## cadence release : rejeu de la CI de publication (L698, D-14, D-16, D-17)

- Workflow : `cadence release` clone le commit de version, lit `.github/workflows/*` déclenchés par un tag **dans le clone**, rejoue les étapes reconnues (src/release-ci.ts), refuse au premier rouge, retire le clone.
- Décision D-17 (revue r2) : les scripts de cycle de vie de `npm ci` (preinstall, install, postinstall, prepublish, preprepare, prepare, postprepare), aussi dans les paquets de workspaces, sont **contrôlés** comme les autres plutôt que coupés par `--ignore-scripts` (2 dépendances du dépôt ont des scripts d'installation : la CI les joue, le rejeu aussi).
- Environnement : **liste blanche** de variables (VARIABLE_TRANSMISE), HOME temporaire, cales qui échouent pour ssh, scp, sftp, kubectl, helm, gh, docker en tête du PATH. Limite assumée et écrite dans docs/releasing.md : ce n'est pas un bac à sable (`/usr/bin/ssh` par chemin absolu lit encore ~/.ssh).
- `working-directory` (étape, puis defaults.run du job, puis du workflow) est honoré ; calculé, absolu, hors du clone ou absent : refusé. Un job sous `if:` n'est pas rejoué.
- Les tests du paquet jouet écrivent leur trace dans un chemin écrit dans trace.cjs (plus de variable ACME_TRACE, que la liste blanche ne transmet pas).
- rsync n'est pas coupé : la suite de cadence s'en sert en local (mise-en-service) ; un rsync distant passe par la cale ssh. Rejeu réel vert sur ac87f32b (350 s).
