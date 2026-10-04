# orchestrate — design (lot L3 de cadence : chef d'orchestre à sessions courtes)

Date : 2026-10-04. Statut : à valider (une seule validation avant code). Approche validée le 04-10
(note du lot) : `cadence orchestrate <projet>:<lot>…`, une session `claude -p` neuve par étape,
au plus deux sessions, une par dépôt, état dans `.cadence/runs/`, livraisons au lead.

## But

Le skill `lead` délègue à des sous-agents, mais la session lead les lance, attend leurs rapports, les
reprend pour corriger, et grossit à chaque tour. L'orchestrateur est un **programme** (le CLI
cadence), pas une conversation : il lance pour chaque étape d'un lot une session Claude neuve en
ligne de commande avec un brief court, lit son résultat, écrit l'état dans des fichiers et passe à
l'étape suivante. La session lead ne garde que la décision (quels lots), le tableau de fin et les
questions remontées.

### Mesure de départ

| Date | Mesure | Valeur |
|---|---|---|
| 02-10 | part de l'usage consommée au-delà de 150 k de contexte | 75 % |
| 02-10 | contexte des agents repris pour corriger | jusqu'à 440 k |
| 04-10 | session lead, contexte moyen / pic | 146 k / 243 k |
| 04-10 | agents lancés par la session lead | 22 |

La mesure se refait de la même façon (journaux `~/.claude/projects/<dossier>/<session>.jsonl`,
contexte d'un tour = entrée + écriture de cache + lecture de cache du message) sur la première vague
réelle, et le résultat va en note du lot. **Cibles** : aucune session de la vague au-delà de 150 k de
pic ; session lead sous 60 k de moyenne pour une vague de 4 lots ; aucun agent repris.

## Décisions

| Sujet | Choix |
|---|---|
| Nature | sous-commande du CLI (`src/orchestrate/`), aucune dépendance nouvelle (`child_process`) |
| Choix des lots | **Sylvain**, à chaque vague (décision 04-10) ; l'orchestrateur ne choisit rien |
| Session | `claude -p` neuve par étape, jamais `--resume` d'une session de travail — seule entorse (L26) : UNE relance de mise en forme (`--resume <id> --json-schema`) quand `structured_output` manque d'une session réussie ; jetons comptés, sinon échec |
| Modèles | implémentation et corrections Sonnet ; revues Opus ; Haiku sur demande explicite (`@haiku`) |
| Concurrence | ≤ 2 sessions, 1 par dépôt, imposé par le code (ordonnanceur + verrous) |
| Budget | 2 M tokens par vague par défaut (`--budget`, décision 04-10) |
| Verdict de code | `raf review` enregistré **par l'orchestrateur** quand la revue est conforme (décision 04-10) |
| Verdict UX | reste au lead (recommandation, cf. question 2) |
| `raf done`, push, livraison | jamais par l'orchestrateur ni par une de ses sessions |
| État | `.cadence/runs/<vague>/` dans le dossier où la commande est lancée, écriture atomique |
| Briefs | gabarits versionnés `templates/orchestrate/*.md`, source unique, le skill `lead` y renvoie |

## Commande

```sh
cadence orchestrate finance-tracker:L41 ol-companion:L22 cadence:L18@haiku
cadence orchestrate L18                       # depuis un projet : le projet est le dépôt courant
cadence orchestrate … --budget 1.5M           # 1500000, 1.5M, 800k ; défaut 2M
cadence orchestrate … --dry-run               # préconditions + plan de la vague ; rien n'est lancé
cadence orchestrate --status [<vague>]        # le tableau, relu depuis l'état (défaut : la dernière)
cadence orchestrate --resume [<vague>] [--budget 1M] [--answer ol-companion:L22 "réponse"]
```

- `<projet>` est le nom d'un sous-dossier du dossier courant qui est un projet cadence (même règle
  que `lead` : `docs/plan/raf.yaml`, ou `cadence.yaml` avec une clé `plan:`). `@haiku`, `@sonnet`,
  `@opus` change le modèle de l'implémentation et des corrections de ce lot ; les revues restent Opus.
- Ordre : lots d'un même projet dans l'ordre donné (un dépôt = une file) ; deux projets au plus en
  parallèle. Un lot dont une dépendance (`after`) n'est ni terminée ni plus tôt dans la vague est
  refusé avant d'agir.
- Identifiant de vague : `AAAA-MM-JJ-HHMM` (heure du lancement), ou `--wave <nom>`.
- `--resume` reprend la dernière vague non terminée ; `--budget` y **remplace** le budget restant ;
  `--answer` joint une réponse de Sylvain au lot arrêté sur une question (cf. cas limites).
- Codes de sortie : 0 tous les lots prêts à livrer · 1 au moins un lot rendu au lead (question,
  échec, revue non conforme après 2 passes) · 2 refus avant d'agir · 3 vague suspendue (budget ou
  quota), reprenable.
- La session lead lance la commande **en arrière-plan** et est notifiée à la fin (pas d'attente
  muette, pas de boucle de sondage) ; `--status` permet de regarder où en est la vague.

`--dry-run` vérifie les préconditions (sans poser de verrou ni écrire d'état), puis affiche par lot :
file et créneau, étapes prévues (petit lot ou non, UX ou non), modèle de chaque étape, commande
`claude` résolue et chemin du brief rendu (écrit dans un dossier temporaire). Code 0 ou 2.

## Cycle d'un lot

```
préconditions → raf start → implémentation (Sonnet)
  → revue de code (Opus, neuve) [+ revue UX (Opus, neuve) si visible]
  → conforme ? ─ oui → raf review (auto) → « prêt à livrer »
              └ non → correction (Sonnet, NEUVE) → nouvelle revue … 2 passes de correction au plus
                     → toujours non conforme : « rendu au lead » avec les constats restants
```

1. **Préconditions** du lot : arbre propre (aucun fichier suivi modifié, la règle de `deliver`) ;
   lot présent, statut `todo` ou `doing` ; dépendances satisfaites ; verrou du dépôt libre.
2. **`raf start <lot>`** s'il est `todo`, puis commit d'entretien du plan, chemin explicite
   (`plan: <lot> démarré (orchestrate <vague>)`) : un commit qui ne touche que le plan est exempt
   (README, « entretien du plan ») et l'arbre reste propre pour la session.
3. **Implémentation** : session Sonnet, brief `implement.md`.
4. **Revues**, chacune dans une session neuve, lecture seule :
   - **revue de code** : agent `code-reviewer`, Opus, brief `review.md` (dépôt + lot, jamais le
     rapport de l'auteur — règle de l'agent) ;
   - **revue UX** si le lot est `visible` : agent `ux-reviewer`, Opus, brief `ux.md` ; elle a besoin
     de l'application en marche — URL ou commande de lancement lue dans `cadence.yaml`
     (`orchestrate.ux`), sinon l'étape est marquée « UX à faire par le lead » sans session.
   La revue de code passe après la revue UX quand les deux ont lieu, et c'est **toujours une revue de
   code qui clôt le cycle** : une correction issue de l'UX change du code, et une revue antérieure
   au dernier commit serait périmée (règle du verdict lié au commit).
5. **Conforme** = 0 bloquant et 0 majeur dans la sortie structurée de la revue de code (les mineurs
   ne bloquent pas). **Passe des mineurs** (L38) : une revue conforme qui porte des constats mineurs
   enchaîne UNE passe de correction de ces mineurs (session Sonnet neuve, brief `fix.md`, hors des 2
   passes de défauts), puis une revue courte (`review-small`) ; celle-ci conclut même avec de
   nouveaux mineurs, rendus au lead comme propositions. Les sous-tâches proposées restent rendues au lead.
6. **Correction** : session Sonnet **neuve** (jamais la session d'implémentation reprise), brief
   `fix.md` avec les constats de la dernière revue (code et UX ensemble, une seule session) et la
   liste des commits du lot ; puis nouvelle revue. **2 passes de correction au plus**, puis la main
   est rendue au lead.
7. **Petit lot** (`estimate ≤ 0.5` ou `quickwin`) : une **passe unique** relecture + UX — une seule
   session Opus, agent `code-reviewer`, brief `review-small.md` qui ajoute, pour un lot visible, la
   grille de l'`ux-reviewer` (captures 1440 / 390, règle nommée). Mêmes règles de conformité et de
   corrections ensuite.
8. **Haiku** : seulement quand Sylvain l'écrit (`L18@haiku`), pour un lot mécanique (README,
   renommage, montée de version). Le « Haiku au tour » de la règle du 03-10 disparaît : le tour
   (`cadence session start`) et la lecture des rapports sont faits par le code, sans modèle.

### Briefs

Gabarits Markdown versionnés dans `templates/orchestrate/` (ajouté à `files` du paquet), rendus par
substitution de `{{chemin}}`, `{{lot}}`, `{{titre}}`, `{{objectif}}`, `{{constats}}`, `{{commits}}`,
`{{reponse}}`. `implement.md` **est** le brief de `skills/lead` §2, mot pour mot, plus deux lignes :
pas de sous-agent, et le rapport final rendu dans la sortie structurée. `skills/lead` renvoie vers
le gabarit au lieu d'en garder une copie (source unique, testée). `{{objectif}}` vient du titre et des
notes du lot : Sylvain qui choisit la vague n'a rien d'autre à écrire. Pas de gabarit surchargé par
projet dans L3 : les règles propres à un projet sont dans son CLAUDE.md, que chaque brief fait lire.

## Lancement d'une session

```sh
claude -p "<brief rendu>" \
  --output-format json --json-schema '<schéma de l étape>' \
  --model sonnet|opus|haiku \
  --agents '<agents du paquet, JSON>' --agent code-reviewer      # revues seulement
  --permission-mode <orchestrate.permissionMode, défaut auto> \
  --disallowedTools Agent "Bash(git push:*)" "Bash(cadence deliver:*)" \
                    "Bash(raf done:*)" "Bash(raf review:*)" "Bash(raf ux:*)"
```

- **Répertoire** : la racine du dépôt du projet (`cwd`). Dossiers additionnels seulement s'ils sont
  déclarés (`orchestrate.addDirs`, ex. le dossier `tmp/` partagé).
- **Agents** : les définitions du paquet (`agents/*.md`, lues depuis `AGENTS_DIR`) passées par
  `--agents` : la version de l'agent est celle de cadence, que le projet ait le plugin, une copie
  locale ou rien.
- **Pas de sous-agent** (`Agent` interdit) : l'orchestrateur est le seul à déléguer, et chaque
  contexte reste mesurable.
- **Environnement** : `CADENCE_ORCHESTRATED=<vague>` ; pour chaque remote du dépôt,
  `remote.<nom>.pushurl` remplacé par une URL invalide via `GIT_CONFIG_COUNT` / `GIT_CONFIG_KEY_n` /
  `GIT_CONFIG_VALUE_n` — un push échoue même lancé par un `sh -c` qui contourne les règles d'outils.
- **Délai** : 45 min pour une implémentation ou une correction, 25 min pour une revue
  (`orchestrate.timeouts`) ; au-delà, le groupe de processus est tué : « délai dépassé ».
- **Journal** : la sortie JSON de chaque session dans
  `.cadence/runs/<vague>/<projet>--<lot>/<n>-<étape>.json`, son stderr à côté (`.err`), et le
  `session_id` dans l'état : la session reste consultable (`claude --resume <id>`) pour un humain,
  jamais reprise par l'orchestrateur.

### Lecture du résultat et des tokens

La sortie `--output-format json` est un objet unique : `is_error`, `subtype`, `result`,
`session_id`, `num_turns`, `duration_ms`, `usage` (`input_tokens`, `cache_creation_input_tokens`,
`cache_read_input_tokens`, `output_tokens`), `modelUsage` par modèle, et la sortie structurée
demandée par `--json-schema`. Ces noms sont à **épingler sur un échantillon réel enregistré**
(t1) : le parseur est testé contre lui, et un champ absent est une erreur nommée, jamais un zéro.

Tokens d'une session = les quatre compteurs de `usage`, conservés séparément dans l'état ; le
**compte du budget** est l'entrée + l'écriture de cache + la sortie, la lecture de cache affichée à
part (cf. question 1). Le pic de contexte de la session est relu dans son journal `.jsonl` après
coup, pour la mesure ; il n'entre pas dans le budget.

Sorties structurées (schémas JSON dans `src/orchestrate/schemas.ts`) :

- implémentation / correction : `commits[] {sha, sujet}`, `tests {commande, resultat}`,
  `build {commande, resultat}`, `nonVerifie[]`, `questions[]`, `resume` (5 lignes au plus) ;
- revue de code (et passe unique) : `bloquants`, `majeurs`, `mineurs` (nombres), `constats[]
  {gravite, fichier, ligne, texte}`, `sousTaches[]`, `nonVerifie[]`, `verdict` (la ligne pour
  `raf review`) ;
- revue UX : même forme, `verdict` pour `raf ux`.

Rien d'un rapport n'est cru sur parole : les commits annoncés sont confrontés à `git log` (commits du
lot depuis le début de l'étape, par `raf commits`), et c'est cette liste qui fait foi.

## Contraintes imposées par le code

| Règle | Mise en œuvre |
|---|---|
| ≤ 2 sessions en même temps | ordonnanceur à deux créneaux ; `--parallel` n'existe pas |
| 1 session par dépôt | une file par dépôt ; verrou `orchestrate.lock` dans l'état partagé du dépôt (`.git/cadence/`, celui de `deliver`), même mécanique (lien atomique, pid mort retiré avec avertissement) |
| une vague à la fois | verrou `.cadence/orchestrate.lock` dans le dossier de lancement |
| jamais de livraison | `cadence deliver` refuse quand `CADENCE_ORCHESTRATED` est posé, **et** refuse un dépôt dont le verrou `orchestrate.lock` est vivant |
| jamais de push | `pushurl` invalide (ci-dessus) ; après chaque session, la référence amont et `git ls-remote` comparées à l'avant : un écart arrête la vague (incident) |
| jamais `raf done` / `raf ux` par une session | `raf done|ux|review` refusent quand `CADENCE_ORCHESTRATED` est posé ; l'orchestrateur appelle `raf review` en interne (API `Plan`), pas par le shell |
| revues en lecture seule | après une session de revue, `HEAD` et l'arbre doivent être identiques à l'avant, sinon incident |

## État : `.cadence/runs/<vague>/`

`wave.json` : `{ id, created, cwd, budget, consumed, status, lots: ["projet:lot", …] }`,
`status` ∈ `running | suspended-budget | suspended-quota | done | interrupted`.

Un fichier par lot, `<projet>--<lot>.json` (deux projets peuvent avoir chacun un `L3`) :

```json
{
  "project": "ol-companion", "repo": "/home/…/ol-companion", "lot": "L22",
  "title": "…", "visible": true, "small": false, "model": "sonnet",
  "readOnlyPlan": false,
  "status": "reviewing",
  "pass": 1,
  "startedSha": "3751e87…",
  "steps": [
    { "n": 1, "kind": "implement", "model": "sonnet", "status": "ok",
      "pid": 41237, "sessionId": "…", "started": "…", "ended": "…",
      "tokens": { "input": 812, "cacheWrite": 91234, "cacheRead": 2210443, "output": 18311, "counted": 110357 },
      "peakContext": 96120,
      "headBefore": "3751e87…", "headAfter": "9c01d2a…",
      "commits": ["9c01d2a feat(L22): …"],
      "report": "1-implement.json" },
    { "n": 2, "kind": "review", "model": "opus", "status": "running", "pid": 41390 }
  ],
  "verdict": null, "uxVerdict": null,
  "questions": [], "answers": [],
  "outcome": null
}
```

- `status` ∈ `queued | implementing | reviewing | fixing | question | ready | handed-back |
  failed | suspended` ; `outcome` est la phrase du tableau.
- Écriture atomique (fichier temporaire + renommage) après chaque transition ; le dossier
  `.cadence/` est ajouté à `.git/info/exclude` quand le dossier de lancement est un dépôt (l'état ne
  salit jamais un arbre).
- **Reprise après coupure** (Ctrl-C, WSL fermé) : sur SIGINT / SIGTERM l'orchestrateur tue les
  groupes de processus des sessions, marque les étapes `interrupted`, libère ses verrous. Au
  `--resume` : une étape `running` dont le pid d'orchestrateur est mort est `interrupted` ; si le pid
  de la session vit encore, le lot est refusé (« session encore en vie, pid N »). Une étape
  interrompue est **relancée entière** dans une session neuve, dont le brief liste les commits du
  lot déjà présents depuis `headBefore` (« une session précédente a été interrompue ; reprends à
  partir de ces commits »). Les étapes `ok` ne sont jamais rejouées.

## Ce que l'orchestrateur enregistre, ce qui reste au lead

- **`raf review <lot> "<verdict>"`** enregistré par l'orchestrateur quand la dernière revue de code est
  conforme, après avoir vérifié qu'aucun commit du lot n'est postérieur à la session de revue. Le
  verdict est la ligne de l'agent suivie de `— orchestré (vague <id>, <n> passe(s) de correction)`,
  puis un commit d'entretien du plan, chemin explicite. Le sha retenu par `raf review` est donc
  celui que la revue a lu.
- **Mineurs et sous-tâches proposées** : écrits dans l'état et le tableau, **pas** ajoutés au plan
  (l'ajout d'un lot reste une décision du lead, comme aujourd'hui).
- **Reste au lead** : choisir les lots de la vague (avec Sylvain) ; les questions remontées ; la
  re-vérification après la vague (`git log`, tests, `raf check` — « re-vérifier après un agent ») ;
  `raf done` ; le verdict UX `raf ux` (recommandation : l'agent UX rend des maquettes à approuver et
  ses captures sont à regarder, cf. question 2) ; push et livraisons, un projet à la fois, avec le
  skill `deliver`, puis la revue QA ; `session-close`.

## Projets à plan en lecture seule

Un projet dont `cadence.yaml` décrit un plan tenu par son propre outil (maritime-atlas,
`python3 scripts/raf.py`) : `raf start` et `raf review` refusent d'y écrire. L'orchestrateur appelle
alors les commandes que le projet déclare, et ne fait rien d'autre :

```yaml
orchestrate:
  start: python3 scripts/raf.py start {lot}
  verdict: python3 scripts/raf.py note {lot} "revue de code : {verdict}"   # optionnel
```

Sans `start`, le lot doit déjà être en cours (refus sinon : « plan en lecture seule : démarrer le lot
avec l'outil du projet ») ; sans `verdict`, le verdict reste dans l'état et le tableau et le lead le
reporte. Les fichiers modifiés par ces commandes ne sont commités que s'ils sont des fichiers du
plan (`plan.path`, `plan.files`) ; sinon le lot s'arrête, arbre sale. Les briefs disent d'utiliser
l'outil du projet (son CLAUDE.md le nomme), comme `lead` aujourd'hui.

## Sortie

Une ligne par lot, puis le total :

```
lot                    état             passes  revue                         UX            commits  tokens   durée
ol-companion:L22       prêt à livrer    1       conforme après 1 correction   à faire lead  4        412 k    38 min
finance-tracker:L41    question         0       —                             —             1        96 k     12 min
cadence:L18            prêt à livrer    0       conforme                      —             1        58 k      6 min
vague 2026-10-04-1412 : 566 k / 2 M comptés (lecture de cache 7,1 M) — 2 prêts, 1 question
questions : finance-tracker:L41 — « … » (cadence orchestrate --resume --answer finance-tracker:L41 "…")
```

Pendant la vague, une ligne par transition dans `.cadence/runs/<vague>/journal.log` (et sur la
sortie standard).

## Erreurs et cas limites

| Cas | Comportement |
|---|---|
| Budget atteint | aucune nouvelle session ; celles en cours finissent ; lots suivants `suspended` ; vague `suspended-budget`, code 3 ; `--resume --budget …` continue |
| Quota atteint (`is_error` avec message de limite d'usage) | plus aucune session, la session concernée est `interrupted` ; vague `suspended-quota`, heure de remise affichée si le message la donne ; code 3 ; **pas** d'attente ni de nouvel essai automatique |
| Session qui ne rend rien (code ≠ 0, JSON illisible, champ attendu absent, délai dépassé) | étape `failed` avec la cause, le stderr gardé ; pas de nouvel essai automatique (une implémentation a pu commiter) ; lot `failed`, rendu au lead ; les autres lots continuent |
| Agent qui demande une décision (`questions[]` non vide) | lot `question`, arrêté ; la question est dans le tableau ; `--resume --answer projet:lot "…"` relance l'étape dans une session neuve, réponse dans le brief (`{{reponse}}`) et dans `answers[]` |
| Tests rouges | annoncés rouges par l'implémentation, ou rouges quand l'orchestrateur lance la commande du projet (`orchestrate.test`, optionnelle ; sinon la revue de code les lance) : la sortie de test devient un constat bloquant et part en correction (compte comme une passe) |
| Dépôt sale avant un lot | lot refusé avant d'agir (code 2 si c'est le seul), fichiers listés |
| Dépôt sale après une session | lot `handed-back`, fichiers listés — l'orchestrateur ne commite ni ne jette le travail d'une session |
| Commit d'une session qui ne cite pas le lot | signalé dans le tableau (sha + sujet), le lot continue |
| Lot `done` ou `dropped`, inconnu, dépendance non satisfaite | refus avant d'agir |
| `claude` absent ou version qui n'a pas `--json-schema` | refus avant d'agir, avec la version lue |
| Push ou changement d'arbre détecté pendant une revue | incident : vague arrêtée, rien enregistré |

## Plan de test

TDD, vitest, dépôts jetables (`test/helpers.ts`). Le lanceur est injecté
(`deps.claude: (args, opts) => …`) et, pour les tests de bout en bout du CLI, un **faux `claude`**
(`test/fixtures/fake-claude.mjs`, désigné par `CADENCE_CLAUDE_BIN`) lit un scénario JSON : pour
chaque appel, reconnu par `--agent` / `--model` / un marqueur du brief, il agit dans `cwd` (commits
citant ou non le lot, fichier laissé modifié, `git push`, attente, code ≠ 0, sortie illisible,
message de limite d'usage) puis écrit un résultat au format de l'échantillon réel, avec ses
compteurs. Les appels reçus sont journalisés pour les assertions (arguments, env, `cwd`).

Cas, chacun vu rouge avant le code :

1. parseur : échantillon réel enregistré → compteurs et sortie structurée ; champ absent → erreur.
2. arguments : modèle par étape, `--agents`/`--agent` pour les revues, `Agent` interdit, env
   `CADENCE_ORCHESTRATED` et `pushurl`, `cwd` = dépôt.
3. cycle nominal : implémentation → revue conforme → `raf review` écrit avec le sha relu, commit du
   plan, `raf done` **non** appelé.
4. revue non conforme → correction en session neuve (jamais `--resume`) → conforme ; puis 2 passes
   épuisées → `handed-back`.
5. lot visible : UX puis code ; correction UX suivie d'une revue de code (jamais de verdict périmé).
6. petit lot : une seule session de revue ; `@haiku` respecté pour l'implémentation, pas pour la revue.
7. ordonnanceur : 3 projets → jamais plus de 2 sessions simultanées, jamais 2 dans un dépôt.
8. budget : session qui dépasse → aucune nouvelle, code 3 ; `--resume --budget` reprend.
9. quota, session muette, délai dépassé, question puis `--answer`.
10. reprise : orchestrateur tué au milieu d'une étape → `--resume` relance l'étape avec les commits
    déjà présents dans le brief ; étapes `ok` non rejouées ; pid de session vivant → refus.
11. garde-fous : `git push` du faux claude échoue ; `cadence deliver` et `raf done|ux|review`
    refusent sous `CADENCE_ORCHESTRATED` ; deliver refuse un dépôt sous verrou d'orchestration.
12. plan en lecture seule : commandes `orchestrate.start` / `verdict` appelées, refus sans `start`
    si le lot est à faire.
13. `--dry-run` : rien lancé, aucun fichier d'état ; sortie du tableau et `--status`.
14. gabarits : `skills/lead` cite le gabarit, `implement.md` contient le brief du lead (test épinglé).

Hors suite automatique : une vague réelle sur un dépôt jetable (un lot trivial) pour enregistrer
l'échantillon de t1, puis la première vague réelle, mesurée (cible ci-dessus).

## Découpage proposé

| Sous-tâche | Contenu | Estimation |
|---|---|---|
| t1 | lanceur de session : arguments, env de garde, délai, parseur JSON, compteurs ; échantillon réel enregistré | 0.5 |
| t2 | état et verrous : schémas, écriture atomique, `info/exclude`, verrou de vague et de dépôt, reprise | 0.5 |
| t3 | cycle d'un lot : machine à états, passes, petit lot, UX, conformité, contrôles après session | 0.75 |
| t4 | gabarits `templates/orchestrate/*`, schémas de sortie, `skills/lead` qui y renvoie | 0.25 |
| t5 | ordonnanceur : 2 créneaux, files par dépôt, budget, quota | 0.25 |
| t6 | `raf review` automatique ; plans en lecture seule (`orchestrate.start|verdict`) | 0.25 |
| t7 | commande, `--dry-run`, `--status`, `--resume`, `--answer`, tableau, codes de sortie | 0.25 |
| t8 | garde-fous côté `raf` et `deliver` (`CADENCE_ORCHESTRATED`, verrou d'orchestration) | 0.25 |
| t9 | README, skill `lead` (vague par l'orchestrateur), première vague réelle mesurée, note au lot | 0.25 |

Total 3,25 j pour 3 estimés.

## Hors périmètre

Choix automatique des lots ; livraison, push, `raf done` ; ajout au plan des sous-tâches proposées ;
gabarits surchargés par projet ; retour arrière d'un lot raté ; notifications ; sessions sur une
autre machine que Big-Blue.

## Questions ouvertes pour Sylvain

1. **Quels tokens compte le budget ?** Une session Sonnet de 40 tours à 80 k relit environ 3 M de
   cache : compter la lecture de cache ferait tenir moins d'un lot dans 2 M. *Recommandation* :
   le budget compte entrée + écriture de cache + sortie (environ 400 k par lot, donc 4 à 5 lots par
   vague de 2 M), la lecture de cache est affichée à part dans le tableau.
2. **`raf ux` automatique comme `raf review` ?** *Recommandation* : non — l'orchestrateur lance la
   revue UX et rapporte verdict, captures et sous-tâches, mais le lead l'enregistre après avoir
   regardé les captures (l'agent rend des maquettes à approuver avant tout code, et une revue UX
   « conforme » sur une app lancée en local peut manquer l'état réel).
3. **Plans en lecture seule (maritime-atlas)** : l'orchestrateur appelle-t-il l'outil du projet ?
   *Recommandation* : oui pour le démarrage (`orchestrate.start: python3 scripts/raf.py start {lot}`),
   et pour le verdict une note via `orchestrate.verdict` (raf.py n'a pas de commande de revue) ;
   sans déclaration, rien n'est écrit et le lead reporte.
