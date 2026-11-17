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

## Porte des cas d'éval avant raf done (L755, revue r1)

- Une clé `evals` mal formée (carte, `case:`, nom de cas avec une espace) n'est plus lue comme « aucun cas » : `validateConfig` (src/config-set.ts) appelle `readEvalEntries`, donc la porte qui relit cadence.yaml la refuse ; `raf done` refuse le lot avec l'erreur de la clé (`refuseUnevaluatedPlugin`, src/raf-close-checks.ts), `--force` avertit. `evalEntriesOf` (qui avalait l'erreur) est retiré.
- Écran : `L1 : la porte des cas d'éval du plugin ne peut pas juger le lot, cadence.yaml : evals[0].case inconnu (…) — corriger la clé evals de cadence.yaml (docs/config.md), puis relancer raf done (--force pour passer outre)`.
- docs/config.md : ligne `evals` dans « Where a gate is declared » (douze portes, test L602 mis à jour). cadence.yaml : `docs/concepts.md` rejoue deliver-sha et livrer-sh-sans-bloc. Décision : docs/qa/expectations.md, citée par la revue, n'existe pas dans ce dépôt (aucun motif ajouté).

## cadence release : docs/whats-new.md sans introduction, structure reconnue (L761, revue de L753)

- L'introduction de « Version by version » est ce qui précède le premier paragraphe `**x.y.z**:` (zéro, un ou plusieurs paragraphes) ; le paragraphe long de la nouvelle version s'écrit juste avant ce premier paragraphe (src/whats-new-forms.ts `insertLong`), sous le titre quand il n'y a pas d'introduction, à la fin de la section quand elle n'a aucune version.
- La vérification (src/release.ts `whatsNewIssues`) ne saute plus « la première ligne » : un paragraphe de version en tête compte dans l'ordre ; un paragraphe d'un autre genre sous celui de la version qui sort = « mal placé » (garde le cas R10 « avant l'introduction »).
- Structure reconnue = `## In two lines` puis `## Version by version`, une fois chacun (`whatsNewStructureIssue`). Sinon `cadence release` refuse juste après `plan()`, avant fumée, CI rejouée et écrits : RafError, code 2, « structure non reconnue, … ». Fichier absent : rien à vérifier, comme avant. Les deux tests L418 (fichier vide, sans « Version by version ») passent de « code 1 + écarts » à « code 2 + refus ».

## cadence run : escalade Fable et plan en attente (L748, revue r1)

- Workflow : au lancement, `revueDuPlan` (v2/src/run/escalade.ts) lit la revue du plan (`raf list --json`) puis les `raf review <lot>` de `.cadence/plan-en-attente.yaml` ; la dernière est la revue courante.
- Décision (revue r1) : l'argv en attente se lit avec la table d'options de raf, déplacée de src/cli/context.ts vers `scripts/options-raf.mjs` (+ `.d.mts` aux types littéraux, comparée par test/options-raf-l748.test.ts ; publiée dans `files` et copiée par l'instantané). Option inconnue = plan en attente illisible, nommé.
- Décision (revue r1) : une revue conforme, au plan ou en attente, remplace les précédentes comme au plan sous L726 ; seules les non conformes écrites après elle (et celles vues par des runs) comptent. Tests : v2/test/run-modele-attente-l748.test.ts.

## Modèle des agents du plugin (L757, D-4)

- Décision : `livreur` et `precheck-reader` déclarent `model: sonnet` ; les 9 autres agents (juges compris) n'en déclarent aucun et héritent du modèle de la session. Test : test/modele-agents-l757.test.ts (liste exacte, recopie par `cadence skills install`, `readAgents` ne passe pas `model` à `--agents` : dans une vague le `--model` de l'étape décide).
- Workflow de mesure : `node scripts/jetons-agents.mjs [--agent livreur] [--since|--until ISO] [--dernieres 5] [--json]` relie chaque sous-agent (`<session>/subagents/*.jsonl`) à son appel Agent par le prompt, compte les jetons par modèle (message.id une fois) et marque `RATÉE` une réponse « Question » ou sans « livré »/« poussé ». Lecture et critère : docs/mesures/modele-agents-l757.md.
- Revue L757 r1 : la réponse lue est `SubagentHandback.input.message` (forme réelle des journaux), le dernier texte seulement à défaut ; réels : 14 ok / 4 ratées sur 18 (avant : 18 RATÉE). Les sous-agents d'une session sont pris dans l'ordre de leur premier horodatage et chaque appel ne sert qu'une fois (deux prompts identiques gardent chacun leur date). `precheck-reader` n'est pas mesurable par ce script (lancé par orchestrate en `--agent`, jamais par l'outil Agent) : exemple retiré de la doc, remplacé par `--agent code-reviewer` ; la colonne ok/RATÉE ne vaut que pour le livreur.

## Banc : id exact du modèle, juges et répétitions interrompues (L756, revue)

- Décision : les juges tournent en `stream-json --verbose` comme les bras ; le juge = modèle principal (`system/init`, `modeles_juge`), les auxiliaires facturés (`modelUsage` sans lui) à part (`autres_modeles_juge`). Le dernier `result` du flux fait foi (une sortie JSON d'un seul objet reste lue).
- Écran (en-tête de rapport) : `Juges : alias opus → claude-opus-5-5 ; autres modèles facturés : claude-haiku-5-5` ; « non lu (aucune session de juge n'a rendu son system/init) » sans init. La comparaison au passage précédent ne regarde que le juge.
- `modeles_exacts` de l'historique : `"id non lu"` (chaîne) pour un bras ou des juges sans id lu, jamais `[]`. Une répétition de séquence interrompue (`echecRepetition`) l'écrit aussi : `passer` lève `RepetitionInterrompue` qui emporte les étapes jouées. Tests : v2/test/revue-l756.test.ts.

## references: lue par cadence ref et cadence run (L760, revue r1)

- `references.dir` sous `~` (`~` seul ou `~/…`) vaut `$HOME` de l'environnement de la commande (src/ref/store.ts, `referencesDir`), comme les `docs` de `references.run` ; `~user` n'est pas développé. L'exemple de docs/config.md (`dir: ~/kb/references`) est joué par `cadence ref add` dans test/references-l760.test.ts.
- `cadence run` refuse un `references:` mal formé avant le worktree (ni worktree, ni branche, ni état, ni session) et dit la migration de l'ancienne forme à la fin de sa ligne de lancement (`; cadence.yaml : <migration>`). Test : v2/test/run-references-l760.test.ts.

## Garde de revue au push (L766, revue r1)

- Plan en lecture seule : le verdict se lit dans l'**historique** du plan (src/push-review.ts) : un commit de plan descendant du commit de lot (vers HEAD ou la tête poussée), ou l'arbre de travail au-dessus de HEAD, ajoute une note de verdict (texte qui **contient** la clé de `orchestrate.verdict`) absente de son parent. Décision : plus de compte dans le plan d'aujourd'hui (maritime `fields.notes: note`, note unique que `raf.py note` remplace : une seconde revue compte, une autre note n'efface pas la revue ; le même texte réécrit ne compte pas).
- Workflow hors vague : `raf hook install` pose aussi un bloc `pre-push` (src/hook.ts) en tête du script : refuse une session `CADENCE_ORCHESTRATED`, joue `raf hook pre-push`, rend l'entrée de git au script maison. Il remplace entier un hook de vague ou de porte ; une vague le reconnaît (`installPrePush` ne refuse plus, n'écrit rien, `guardPresent` vrai). Avec `core.hooksPath` dans l'arbre (maritime `.githooks`), le fichier est à commiter une fois : geste à faire dans maritime-atlas (`raf hook install` puis commit de `.githooks/pre-push`).
- Tests : test/push-review-l766.test.ts (R13-R15), test/hook-pre-push-durable-l766.test.ts (R16 vrai `git push` refusé hors vague, R17, R18). Test L600 sondes mis à jour (le glossaire dit désormais que `raf hook install` pose le pre-push).

## Porte : environnement périmé, revue r1 (L764)

- `.nvmrc` / `.node-version` jamais au patch près (scripts/environnement-porte.mjs, `tientNvmrc`) : même majeur toujours ; avec une `engines.node` déclarée, elle seule donne le minimum (warhammer40k : .nvmrc 22.23.5 + engines >=22.12.0 accepte Node 22.22.3) ; sans engines, la version de .nvmrc est un minimum dans son majeur.
- Copie jetable de `verify --gate` : les remises à niveau nomment l'arbre principal (`environnementPerime(dir, env, undefined, { arbre: repo })`) ; quand son package-lock.json n'est pas celui de la copie (HEAD ≠ sha ou lockfile modifié), la ligne dit « aucune possible depuis l'arbre principal … — CADENCE_PORTE_ENV=jouer … ». Décision : comparer les lockfiles plutôt que HEAD ≠ sha (HEAD ailleurs mais lockfile identique : `npm ci` dans l'arbre principal suffit).
- `cadence run` : la porte changée par le run (`porte_changee` de l'état) est dite une fois par changement au journal, puis reprise en tête du détail de l'état `integre` et sous sa ligne de fin (« … — à relire : la porte qui a jugé le run est la sienne »), comme un conflit résolu (L723). Pas de refus d'intégration. Tests : test/environnement-porte-l764.test.ts, v2/test/run-environnement-l764.test.ts.
