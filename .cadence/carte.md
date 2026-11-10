# Carte

## Banc séquence (v2/src/sequence/passage.ts) — L690, D-8

- Workflow : un clone par bras, gardé d'étape en étape ; session neuve par étape, sauf bras qui déclare `suite` dans `bras.yaml`
  (`gardee`, `compactee`, `seuil` à 150 k) : l'étape k reprend la dernière session de l'étape k-1 (`x.sessions`).
- Décision : pour un journal qui existait avant l'étape (session reprise), fuites et lecture des références ne lisent que les
  lignes horodatées depuis le début de l'étape (`lignesEtape(…, debut)`). Fichiers neufs : toutes leurs lignes.
- Décision : pas d'option `cadence run --suite` ; la clé `suite` n'existe qu'au banc (doc : docs/v2/banc.md, section Banc séquence).

## Dépôt tenu, plan en attente (src/repo-held.ts, src/cli/attente-commands.ts) — L695, D-9

- Workflow : un programme tient la branche par `<git-common-dir>/cadence/tenu/<kind>-<pid>.json` (cadence run : du début à la fin, écrit par
  v2/src/run/run.ts ; `verify --gate` joué dans l'arbre principal). Pre-commit de `raf hook install` : commit sur cette branche refusé (code 3) avec le geste.
- `raf add|note|done` sur la branche tenue : la ligne de commande va dans `.cadence/plan-en-attente.yaml` (info/exclude). cadence run, en rendant le dépôt
  (intégré ou non), lance `raf attente appliquer` ; sinon le premier add|note|done sur la branche libre l'applique d'abord. Le plan reste à commiter par le lead.
- Décision : porteur mort (pid absent ou repris) = fichier ignoré et retiré. Les vagues v1 (orchestrate) ne tiennent pas la branche par ce mécanisme :
  leur orchestrateur commite lui-même le plan sur la branche ; elles gardent L425, L475, L521.
- Revue r1 (D-10) : le fichier tenu du run porte `start` ; un run qui lève finit en `echec` et rend le dépôt (try/finally, plan en attente appliqué).
  Décision : pas de gestionnaire SIGINT dans le run (code synchrone, il différerait la mort) ; un run tué laisse son fichier, porteur mort par pid+start.
- Décision : les commits des programmes (commitPlan v1, deliver, config set) passent le pre-commit par `CADENCE_COMMIT_PROGRAMME=1` (`commitAsProgram`,
  src/git.ts), posée sur ce seul `git commit`. Plan en attente : ajout et application sous `<git-common-dir>/cadence/plan-en-attente.lock`.

## Fumée du paquet avant le tag (src/release-fumee.ts, scripts/fumee/) — L696, D-11

- Workflow : `cadence release` (et `--dry-run`), après ses refus habituels et la garde du banc v2, avant tout écrit : `npm pack` de HEAD dans un worktree détaché
  (node_modules du dépôt liés pour `prepare`), `npm install` du tarball dans un dossier vide, puis chaque commande de `release.smoke` (cadence.yaml), chacune
  dans un dossier vide, bin du paquet en tête du PATH, `CADENCE_FUMEE_PAQUET` / `CADENCE_FUMEE_RACINE` posés, `CADENCE_*` et `GIT_*` retirés. Rouge = refus (code 2) avec la commande, le code, la fin de la sortie.
- Décision : sans `release.smoke`, `<bin> --help` pour chaque bin de package.json ; ni l'un ni l'autre, pas de fumée. Pas d'option pour la sauter.
- Décision : `cadence2` n'est pas un bin publié (le banc se lie depuis le checkout) : sa fumée charge `v2/dist/cli.js` du paquet installé. `cadence-hud` n'est pas dans
  le paquet npm (marketplace git) : pas de fumée npm pour lui. Rejoué : v2.0.1 refusée (`cadence run --help`, puis `ENOENT bras-A.md`), v2.0.2 verte en ~10 s.
