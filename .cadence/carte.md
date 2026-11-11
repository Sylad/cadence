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
- Revue r1 (D-12) : PATH des commandes réduit à `<installe>/node_modules/.bin`, un dossier à lui avec le seul `node` de la release (lien vers process.execPath :
  le dossier nvm porte un `cadence2` global) et les dossiers système (`/usr/local/bin`, `/usr/bin`, `/bin` + sbin, pour bash et git) ; `NODE_PATH` vide.
  Un bin de package.json sans lien dans `.bin` (fichier absent de HEAD, npm se tait) : refus explicite avant toute commande.

## CI de publication rejouée avant le tag (src/release-ci.ts) — L698, D-14

- Workflow : `cadence release`, après la fumée du paquet (L696) et avant tout écrit : `git clone --no-hardlinks` du dépôt dans un dossier temporaire,
  détaché sur HEAD, les fichiers de version qu'elle va écrire (plus `docs/whats-new.md` de l'arbre de travail) commités (`release: <version>`) et tagués
  `v<version>` : le commit et le tag que verra le checkout de la CI. Puis les étapes `run` de chaque workflow de `.github/workflows` déclenché par un
  tag (`on.push.tags`), dans l'ordre, en `bash -e`, `CI=true`, `GITHUB_REF_NAME`, `RUNNER_TEMP`, `GITHUB_OUTPUT` posés, `CADENCE_*`, `GIT_*`, `npm_*`,
  `RAF_*` retirés. Rouge = refus (code 2) avec le fichier, l'étape, la commande et la fin de la sortie ; le clone est retiré, vert ou rouge.
- Décision : une étape `npm publish` est rejouée comme `npm run prepublishOnly --if-present && npm pack --dry-run` (ce que publish joue avant l'envoi :
  suite, prepack, prepare, postpack ; rien ne part, aucun registre touché). Non rejouées, listées avec la raison : actions `uses:`, `sudo`/`apt-get`,
  `npm install -g`, `npm view`, `gh`, `git config --global`/`push`/`fetch`, `curl`/`wget`, étapes sous `if:`. Les `echo` et commentaires d'un script
  ne comptent pas pour cette classification (« npm publish est sauté » dans un message).
- Décision : `--dry-run` liste les étapes sans les jouer (la suite complète dure plusieurs minutes) ; sans workflow déclenché par un tag, la commande le dit.
- Décision : l'étape « git clone … npm ci … npm test » que le lead jouait à la main après le tag (L446/L508) n'est plus imprimée : la commande fait
  mieux (commit de version réel, tag, tous les scripts de prepublishOnly, prepare) avant d'écrire. Tests L446/L508 du clone imprimé mis à jour.
- Test statique `test/paquet-files-l698.test.ts` : chaque chemin de `files` existe après le build (`npm run prepare` joué si dist/ manque), chaque `bin`
  existe et est couvert par un chemin de `files`.
