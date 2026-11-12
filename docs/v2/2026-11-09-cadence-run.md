# cadence run — une demande, une session

Depuis le 2026-11-09, `cadence run` remplace `cadence orchestrate` pour faire une demande. Il joue exactement ce que le banc a mesuré gagnant (docs/v2/banc.md), et rien d'autre.

```bash
cadence run "<demande>" [--piece docs/norme.md]… [--lot L12] [--demande-humaine | --registre D-n] [--taille retouche|fonction] [--complet] [--modele opus|fable] [--sans-porte] [--fond]
cadence run --reponse <id> "<texte>"
cadence run --liste
cadence run --help        # ou -h
```

## Aiguillage (10-11)

Le brief complet (v2d, hook de lecture) ne gagne au banc que quand la demande a des références à lire : normes, captures. Sans elles, au banc court du 10-11, Claude seul faisait aussi bien, et plus vite. `cadence run` choisit donc son mode par une règle mécanique :

- **complet** (brief v2d + hook) : une `--piece` est donnée, ou la demande contient un mot de la section `references` de `cadence.yaml`, ou `--complet` est passé. Les documents de la référence trouvée deviennent des pièces à lire en entier ;
- **léger** (brief de Claude seul, `v2/briefs/bras-A.md`) : sinon. Le worktree, la porte et l'intégration ne changent pas.

```yaml
references:
  - mots: [sigwx, jet, cb]
    docs: [docs/normes/sigwx.md]
```

Le modèle, le mode et sa raison s'affichent au lancement (« session Fable en mode leger (…) »). Dans un vrai dépôt, la ligne « Taille » du brief complet, qui ne sert qu'au banc, est retirée : elle casserait un commitlint. Les mots se comparent sans accents ni casse, en mot entier. Un document ou une `--piece` peut être relatif au dépôt, absolu ou sous `~` : une base de connaissance hors du dépôt (par exemple `~/kb/dossiers/<dépôt>-<lot>.md`) se lit comme une pièce.

## Déroulé

1. Ouvre un worktree à côté du dépôt (`../.cadence-run/<projet>-<id>`), sur une branche `cadence/run-<id>`. Les `node_modules` et `.venv` y sont liés en dur.
2. Lance une seule session, dans le mode choisi par l'aiguillage et sur le modèle choisi (`--modele`, sinon `CADENCE_RUN_MODELE`, sinon Opus). En mode complet : brief `v2/briefs/bras-sequence-v2d.md` et hook « lecture obligatoire ». Les pièces passées par `--piece` doivent être lues en entier avant toute écriture. Le registre des demandes du dépôt (`.cadence/demandes/`) ne garde que les demandes de l'humain (L701) : voir « Registre des demandes » ci-dessous.
3. Si la session pose une question, le run s'arrête à l'état `attente`. `--reponse` reprend alors la même session, sur le modèle de son lancement (gardé dans l'état du run).
4. Rebase sur la branche de départ, puis porte complète (`orchestrate.test` et `orchestrate.build` de `cadence.yaml`), jouée une seule fois. Si elle est rouge, la même session corrige une fois, puis la porte est rejouée.
5. Intégration en avance rapide sur la branche de départ, puis le worktree est retiré. Rien n'est poussé. Le plan (`raf`) et `cadence deliver` restent ceux de la v1.

**Quota (L700, D-15).** En `claude -p`, la fin de quota ne se reconnaît qu'au texte du résultat (doc officielle lue le 11-11). Un résultat qui commence par « You've hit your weekly limit · resets <jour heure> » met le run à l'état `quota`, pas `echec`, avec l'heure de reprise lue dans ce texte (jour, heure, fuseau entre parenthèses). Le run rend la branche, puis attend : une minute après l'heure dite, il reprend la même session (`--resume`, même worktree, même modèle) et continue (porte, intégration). Un seul processus joue ou attend un run à la fois (revue L700 r1, D-18) : le verrou `<run>.verrou`, à côté de l'état, porte son pid ; tant que le processus qui attend vit, `cadence run --reponse` est refusé avec ce pid (pour reprendre avant : `kill <pid>`, puis `cadence run --reponse <id> "reprends"`), et deux processus ne reprennent jamais la même session. Si ce processus est mort (PC éteint, WSL arrêté, kill), rien ne reprend seul : `--liste` et `lead tour` disent « attente arrêtée » avec la commande `--reponse`. Le jour et l'heure se lisent hors de la parenthèse du fuseau. Une heure illisible : pas de reprise seule, `--reponse` seulement. « You've hit your Opus limit » bascule sur `fable` dans la même session, sans attendre ; jamais la limite hebdo, qui bloque tous les modèles (Fable compris, vécu le 10-11). `cadence run --liste` et `cadence lead tour` montrent les runs en quota et leur heure de reprise ; le tour montre aussi la jauge hebdo publiée par la bande cadence-hud.

**Registre des demandes (L701).** Sans option, la demande passée à `cadence run` est une consigne du lead (brief de correction, relevé d'erreurs) : rien n'est inscrit, le run cite seulement le lot. Les lignes du brief complet qui font inscrire la demande sont retirées, et la session reçoit la consigne de ne pas écrire dans `.cadence/demandes/`, même si un CLAUDE.md le demande. Si elle y écrit quand même, la porte la refuse comme une porte rouge : la session est reprise une fois pour rendre ces fichiers, sinon rien n'est intégré (`porte-rouge`). `--demande-humaine` inscrit la demande, mot pour mot, sous le numéro suivant (`D-<n>`, état `ouverte`, avec le lot et l'id du run). `--registre D-n` rattache le run à une entrée existante, commitée sur la branche de départ (absente : refus avant toute création) ; le run y ajoute le lot et son id, sans toucher au texte ; en mode complet, la ligne du brief qui fait créer une entrée est retirée (lecture et relecture du registre restent), et la porte refuse toute entrée neuve autre que `D-n` comme ci-dessus (passer une entrée existante à `livrée` reste permis). Dans les deux cas, l'entrée est écrite dans le worktree et la session la commite avec son travail, puis la passe à `livrée` avec sa preuve. Les deux options s'excluent. Vécu les 10 et 11-11 : D-8 à D-12, D-14, D-16, D-17 et D-18, inscrites à tort, passées à `abandonnée`.

**Run interrompu, `--fond` (L709, issue #55 du compte pro).** Le 11-11, au compte pro, deux runs `--fond` se sont arrêtés à la minute où la session Claude Code qui les avait lancés s'est fermée : 2 runs perdus, 3 h de créneau, et rien pour les reprendre. Trois corrections :

- `--fond` relance le run détaché (nouvelle session et nouveau groupe de processus, journal dans `../.cadence-run/fond-<heure>.log`), avec les options de Node du lanceur. Surtout, les sessions `claude` du run ne reçoivent plus ce qu'une session Claude Code transmet à ses commandes et qui les lie à elle : `CLAUDE_PID`, `CLAUDE_SSH_*`, `CLAUDE_CODE_CHILD_SESSION`, `CLAUDE_CODE_MESSAGING_*` (sa socket), `CLAUDE_CODE_SDK_HAS_HOST_AUTH_REFRESH` (l'authentification rafraîchie par l'hôte), `CLAUDE_CODE_HOST_SESSION_ID` et `CLAUDE_CODE_SESSION_ID`. Une session lancée sans elles s'authentifie seule (vérifié le 12-11 sur Big-Blue). Le test `v2/test/run-fond-l709.test.ts` lance un run `--fond` depuis un shell qui exporte ces variables, tue tout le groupe de ce shell, puis vérifie que le run et sa session vivent, sans ces variables, et que le run va jusqu'à l'intégration.
- `--liste` affiche `interrompu` pour un run `en-cours` dont aucun processus vivant ne tient le verrou (processus tué, session lanceuse fermée, PC éteint), avec la commande de reprise. L'état écrit sur disque reste `en-cours` ; le code qui le lit passe par `etatVu` (`v2/src/run/run.ts`).
- L'id de session est écrit dans l'état dès le lancement : la première session reçoit `--session-id <uuid>`, les suivantes `--resume`. `cadence run --reponse <id> "reprends"` reprend donc aussi un run mort pendant sa première session : même session, même worktree, avec un rappel qu'elle a été interrompue. Un run d'avant L709 (id vide) repart sur une nouvelle session.

**Un run arrêté sans raison : ce que joindre à une issue (L711, issue #55 du compte pro).** Le 12-11, un run `--fond` est mort à la fin de la session Claude Code qui l'avait lancé, sans rien laisser dans son journal ; la cause n'a pas été reproduite sur Big-Blue. Le journal d'un run `--fond` (`../.cadence-run/fond-<heure>.log`, chemin donné au lancement) garde désormais de quoi l'établir au prochain cas. **Joins ce fichier entier à l'issue**, avec la ligne de `cadence run --liste` du run. On y lit :

- au lancement, l'identité du processus du run : `processus du run (2026-11-12 18:28:03) : pid 1544714, pgid 1544703, sid 1544703, ppid 1544703, cgroup 0::/init.scope`. Le cgroup ne s'écrit que si `/proc/self/cgroup` existe ; sans `/proc`, pgid et sid viennent de `ps`, ou valent `?` ;
- chaque signal reçu, avec l'heure, sur une ligne qui commence par `cause d'arrêt` : celui reçu par le groupe du run (SIGHUP, SIGTERM, SIGINT), celui reçu par l'enveloppe de la session `claude`, celui qui a arrêté le processus du run, avec son code (`a reçu SIGHUP et s'est arrêté (code 129)`), et celui sur lequel `claude` lui-même est mort (`la session claude s'est arrêtée sur SIGKILL (code 137)`).

`--liste` ajoute à un run `interrompu` la dernière ligne `cause d'arrêt` de son journal. L'arrêt lui-même ne change pas : le run est synchrone (il attend `claude` pendant toute la session), donc un gestionnaire de signal dans son processus ne s'exécuterait qu'à la fin de la session, et le run ne s'arrêterait plus au signal. `--fond` détache donc un veilleur (`cadence run --veilleur`, usage interne), qui lance le run, ne transmet ni n'arrête rien, et écrit ce que le run ne peut pas écrire lui-même (`v2/src/trace.ts`) ; le run apprend le chemin de son journal par la variable `CADENCE_RUN_JOURNAL`, qu'il ne transmet pas à ses sessions `claude`. Un signal envoyé à `claude` seul, qui est dans sa propre session, ne se voit qu'à sa mort. Tests : `v2/test/run-signal-l711.test.ts` (un run factice reçoit SIGTERM, le journal le dit avec l'heure, `--liste` l'affiche ; SIGTERM au groupe, l'enveloppe et le veilleur l'écrivent ; `claude` mort sur un signal).

**Le run prend un créneau (L710, issue #55 du compte pro).** Le 12-11, `cadence lead tour` affichait « créneaux libres : 3 sur 3 » pendant que deux runs tournaient : le registre des créneaux ne voyait que les vagues et les sessions du lead. Pendant sa session, sa porte et son intégration, le run s'inscrit dans le registre commun (`$CADENCE_HOME/runs/<id>.json`, `CADENCE_HOME` valant `~/.cadence/orchestrate` par défaut, comme pour `orchestrate`), puis s'en retire à la fin (`inscrireCreneau`, `v2/src/verrou.ts`). Il compte tant que son état est `en-cours` et qu'un processus vivant tient son verrou : c'est le contrôle de `interrompu` dans `--liste`. Un run mort, fini, en attente ou en quota ne compte pas. `cadence lead tour`, `cadence orchestrate --status` et la bande `cadence-hud` l'ajoutent aux sessions en cours et le nomment (`runs cadence run : 1 (projet <id>)`), selon la formule de [concepts.md](../concepts.md#slots-and-holds). Les vagues l'attendent comme une session du lead, et leur journal le cite (`… en cours : w1, cadence run <id>`). Tests : `test/creneaux-runs-l710.test.ts` (registre et bande sur le même registre : un run vivant compte, un pid mort ne compte pas, une vague attend) et `v2/test/run-creneau-l710.test.ts` (l'inscription pendant la session, puis son retrait).

En cas d'échec, le worktree est gardé avec l'état du run (`../.cadence-run/<projet>-<id>.json`). Le run s'arrête alors dans l'un de ces états : `sans-commit`, `conflit`, `porte-rouge`, `sans-porte` ou `refus-integration`.

## Pourquoi ces options

| Option | Justification |
|---|---|
| `--piece` | Le hook « lecture obligatoire » est le seul gain clairement prouvé au banc séquence (lecture des références). La pièce est la liste qu'il fait respecter. |
| `--taille` | Le brief mesuré reçoit la taille du gardien. Sans gardien, la valeur par défaut est `fonction`, comme au banc court. |
| `--reponse` | Une question à Sylvain reprend la même session (cause C2 : ne pas découper le contexte). |
| `--liste` | Retrouver un run rendu, en attente, rouge ou interrompu (L709), sans fouiller le disque. |
| `--complet` | Forcer le mode complet quand l'aiguillage rate une demande qui a des références. |
| `--lot` | Les commits d'un dépôt suivi par un plan citent le lot (`feat(L51): …`) : la session le reçoit avec la demande. |
| `--demande-humaine`, `--registre` | Le registre ne garde que les demandes de l'humain : sans l'une des deux, le run est une consigne du lead et n'y écrit rien (L701 ; huit consignes inscrites à tort les 10 et 11-11). |
| `--modele`, `CADENCE_RUN_MODELE` | Choisir le modèle de la session : `opus` (défaut, celui des deux bras mesurés au banc) ou `fable` ; Sonnet et Haiku n'écrivent pas de code (cause C2). La valeur s'écrit en minuscules. L'option l'emporte sur la variable ; une valeur inconnue est refusée en code 2 avant toute création ; la ligne de lancement dit le modèle utilisé (L699). En Fable, le run sort de ce que le banc a mesuré. |
| `--fond` | Le run se détache et survit à la session qui l'a lancée (vécu au compte pro le 10-11 : un lot mort avec la session précédente, puis deux runs le 11-11, issue #55) ; journal dans `../.cadence-run/`. Ses sessions ne gardent aucun lien avec la session lanceuse (L709). Le journal dit qui était le run et ce qui l'a arrêté (L711). |
| `KUBECONFIG` | Comme les vagues : sans `orchestrate.prodAccess: true`, la session n'a ni `kubectl`, ni `helm`, ni `KUBECONFIG` ; avec, elle joue le banc du projet. |
| `--sans-porte` | Un dépôt sans porte déclarée n'est pas intégré en silence : il faut le choisir explicitement. |
| `--help`, `-h` | L'usage, sans rien créer (issue #54 : « --help » partait en demande, laissait worktree, branche et état). Un autre argument qui commence par `-` est refusé en code 2 avant toute création. |

## Mesures qui le fondent

- Bras v2b (une session, sans relecture), préféré à v2 (avec relecture) : environ ×1,4 plus rapide.
- Registre des demandes (v2d) : la demande différée est tenue 3 fois sur 3 avec registre, 0 sur 3 sans, pour +7 % de temps (micro-banc, 09-11).
- Hook « lecture obligatoire » : les références sont lues en entier.
