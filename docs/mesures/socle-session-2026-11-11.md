# Le socle d'une session chargée par cadence, poste par poste (L694, D-7)

Avant son premier geste, chaque session que cadence lance (`cadence run`, mode léger ou complet, sessions des bancs) envoie un contexte de
**62 k jetons** : c'est le `base` de [`cadence cost`](../cost.md). Cette page dit d'où ils viennent et ce qu'on gagnerait à en couper. Aucune
coupe n'est appliquée ici.

## Mesuré

**Les sessions.** Les journaux `~/.claude/projects/<dossier>/<session>.jsonl` modifiés depuis le lundi 2026-11-09 : 19 sessions `cadence run`
(10 et 11-11, dossiers `…-cadence-run-cadence-2026111…`, toutes en mode léger : aucune demande de la semaine n'avait de référence) et 290
sessions de banc (`~/bench/cadence/…`). Aucune vague `orchestrate` n'a tourné cette semaine. Premier appel des 17 sessions `cadence run` en Opus 5.5 :
**61 561 à 62 677 jetons** (entrée + cache lu + cache écrit), médiane 62 448 sur les 18 sessions terminées ; banc : médiane 63 910 pour les sessions de travail, 55 à 56 k pour les juges.

**Ce que le modèle reçoit.** Claude Code écrit dans le journal, avant le premier message `assistant`, un enregistrement `attachment` par
élément injecté : `instructions` (chaque `CLAUDE.md` chargé, avec son chemin et son texte), `prompt_snapshot` (le texte du prompt système),
`skill_listing`, `agent_listing_delta`, `deferred_tools_delta` (noms des outils différés, schémas déjà chargés), `mcp_instructions_delta`,
`hook_additional_context` et `hook_success` (hooks `SessionStart`), `session_context` (git status), `environment`. Chaque poste ci-dessous
est la longueur en caractères de ces textes, lue dans le journal de la session `9ebe8ab8` (11-11, socle 62 005), identique à ±1 caractère dans
les 19 sessions sauf la demande et le git status.

**Caractères → jetons.** Aucun compteur hors ligne ; le rapport est mesuré sur les journaux de la semaine, de deux façons :

- régression du premier appel sur les longueurs, sur 155 sessions Opus de même configuration (mêmes skills, agents et outils) : **2,01
  caractères par jeton** pour les `CLAUDE.md`, **2,14** pour la demande et le git status, écart résiduel 64 jetons (RMS) ;
- croissance du contexte entre deux appels, moins la sortie du premier, sur 692 résultats d'outil de plus de 2 500 caractères : médiane
  **2,14** (quartiles 2,04 et 2,23), sans écart selon la part d'accents.

Les listes (skills, agents, outils, MCP) ne varient pas entre les sessions : la régression ne peut pas les séparer, elles sont comptées à
2,14. Le **reste** (socle moins la somme des postes) est déduit : schémas JSON des outils intégrés (Bash, Read, Edit, Write, Agent, Artifact,
Skill, ToolSearch, Workflow…) et enveloppes `<system-reminder>`, que le journal n'écrit pas.

## Le socle, poste par poste

| poste | origine | caractères | jetons |
|---|---|---:|---:|
| outils intégrés et enveloppes (déduit) | Claude Code | — | 16 683 |
| `~/projects/developpeur/CLAUDE.md` (dossier parent du worktree) | utilisateur | 11 073 | 5 509 |
| agents de `~/.claude/agents` (16, dont 12 AetherWX/maritime : 4 093) | utilisateur | 10 828 | 5 060 |
| skills intégrés (dataviz, artifact-*, claude-api, code-review…) | Claude Code | 7 761 | 3 627 |
| agents du plugin cadence (9) | plugin cadence | 7 379 | 3 448 |
| skills de `~/.claude/skills` (16, dont 8 AetherWX : 1 741) | utilisateur | 7 315 | 3 418 |
| `~/.claude/CLAUDE.md` (règles des cartes : 1 312) + `@RTK.md` (224) | utilisateur | 5 675 | 2 823 |
| prompt système, texte | Claude Code | 5 094 | 2 380 |
| agents intégrés (Explore, Plan, web-fetch…) | Claude Code | 4 161 | 1 944 |
| skills des plugins cloudflare 1 658, superpowers 1 341, qodo 1 160, claude-hud, ralph-loop, feature-dev | plugins | 9 389 | 4 388 |
| skills `anthropic-skills:*` (compte claude.ai) | compte | 3 463 | 1 618 |
| hook `SessionStart` de superpowers (« You have superpowers… ») | plugin superpowers | 3 405 | 1 591 |
| brief `bras-A.md` et demande (médiane) | cadence | 3 122 | 1 459 |
| connecteurs claude.ai : noms des outils Google (noms 1 313, instructions 116), Claude Docs (instructions 885, 3 schémas 432, noms 129) | compte | 6 152 | 2 875 |
| skills du plugin cadence | plugin cadence | 2 035 | 951 |
| mémoire auto : consignes du prompt système (`MEMORY.md` vide, 0) | Claude Code | 2 114 | 988 |
| `CLAUDE.md` du dépôt cadence | dépôt | 1 365 | 679 |
| noms des outils du plugin playwright | plugin playwright | 1 331 | 622 |
| agents du plugin feature-dev (3) | plugin feature-dev | 1 021 | 477 |
| git status, courriel, environnement, modèle, date | Claude Code | 1 582 | 740 |
| context7 (instructions 334, noms 28), outils différés intégrés (115), cloudflare (119), avis MCP à authentifier (53) | divers | 1 389 | 649 |
| hook `SessionStart` « BANC DU WEEKEND MANQUANT » | utilisateur | 162 | 76 |
| **total** | | | **62 005** |

Deux constats hors tableau. **Le `CLAUDE.md` parent est chargé parce que le worktree de `cadence run` est créé à côté du dépôt**
(`dirname(repo)/.cadence-run/`, `v2/src/run/run.ts:31`) : Claude Code remonte l'arborescence jusqu'à `~/projects/developpeur/CLAUDE.md`.
**Les plugins de l'utilisateur sont tous actifs** dans `cadence run` et les bancs (`argsClaude`, `v2/src/bench/bras.ts:64`) : le hook de
superpowers est dans les 309 sessions de la semaine, alors que `orchestrate` les coupe depuis L398 ([mesure du 2026-10-28](contexte-session-2026-10-28.md)).
Le cache partagé entre sessions ne couvre que 22 à 24 k jetons du premier appel (prompt système et outils) ; le reste du socle est écrit à
chaque session.

## Coupes proposées, chiffrées avec `cadence cost`

Déroulé d'une session médiane de la semaine, mesuré sur les mêmes journaux (`test/fixtures/socle-2026-11-11/`) : `cadence run` 37 appels,
croissance 2 329, sortie 854, 97 % lu dans le cache, 2,31 $ ; banc 39 appels, 1 935, 601, 97,4 %, 2,05 $. Grille de [cost](../cost.md)
(Opus 5.5 : sortie 20, cache lu 0,20, cache écrit 8 $/M). Gain d'une coupe = coût du déroulé moins le même avec `base` diminué des jetons
coupés ; semaine = gain × sessions de la semaine (19 `cadence run`, 290 de banc, du 09 au 11-11). `test/socle-coupes-l694.test.ts` recalcule
chaque gain.

| coupe | où | jetons | par lot (`cadence run`) | semaine run | semaine banc |
|---|---|---:|---:|---:|---:|
| C1 — worktree de `cadence run` hors de l'arborescence du dépôt (le `CLAUDE.md` parent n'est plus chargé) | cadence | 5 509 | 0,09 $ | 1,68 $ | — |
| C2 — `--settings` `enabledPlugins:false` pour les plugins sauf cadence et playwright, comme L398 | cadence | 6 575 | 0,11 $ | 2,00 $ | 29,96 $ |
| C3 — connecteurs claude.ai (Google, Claude Docs) coupés pour la session | cadence | 2 875 | 0,05 $ | 0,88 $ | 13,11 $ |
| C4 — mémoire auto désactivée pour la session (rien à lire : `MEMORY.md` vide) | cadence | 988 | 0,02 $ | 0,30 $ | 4,50 $ |
| U1 — les 12 agents AetherWX/maritime vont dans `maritime-atlas/.claude/agents` | `~/.claude`, proposée | 4 093 | 0,07 $ | 1,25 $ | 18,65 $ |
| U2 — les 8 skills AetherWX vont dans `maritime-atlas/.claude/skills` | `~/.claude`, proposée | 1 741 | 0,03 $ | 0,53 $ | 7,92 $ |
| U3 — les règles des cartes du `CLAUDE.md` global vont dans le `CLAUDE.md` des projets cartographiques | `~/.claude`, proposée | 1 312 | 0,02 $ | 0,40 $ | 5,97 $ |

C1 à C4 ensemble : −15 947 jetons, **0,26 $ par lot (−11 %)**, 4,86 $ sur les 19 sessions de la semaine ; avec U1 à U3 : −23 093 jetons,
0,37 $ par lot (−16 %). Les coupes ne retirent rien à la qualité mesurée tant qu'aucune session n'utilise ce qu'elles retirent ; c'est à
vérifier coupe par coupe sur les erreurs réelles (D-7), pas supposé.

À savoir avant d'en décider :

- **C1** retire aussi les consignes du `CLAUDE.md` parent aux projets qu'il concerne : pour maritime-atlas, il porte la topologie et l'avertissement
  « `kubectl` pointe sur la PROD ». La coupe vaut pour cadence, pas forcément pour tous les dépôts : à décider par dépôt.
- **C2** coupe le hook de superpowers, qui demande d'ouvrir des skills avant tout geste (des tours en plus, non comptés ici). Le banc passe
  par le même `argsClaude` : tous ses bras changent ensemble, mais ses résultats d'avant ne se comparent plus à ceux d'après.
- **C3 et C4** : le mécanisme (variable d'environnement ou réglage passé par `--settings`) reste à vérifier sur une vraie session, comme L398
  l'a fait pour `enabledPlugins`.
- **U1 à U3** touchent la configuration de l'utilisateur : proposées seulement. Elles allègent aussi ses propres sessions hors maritime-atlas,
  non comptées ici.
- Non chiffré : le premier appel écrit tout le socle hors préfixe partagé dans le cache (2 × le prix d'entrée) ; le déroulé de `cost`, linéaire,
  le compte avec le reste (son écart connu est de −8 %).

## Limites

- Le rapport 2,14 pour les listes est celui des résultats d'outil, pas une mesure de ces listes ; une erreur de ±10 % sur lui déplace le reste
  déduit (16,7 k) d'environ ±2,5 k.
- Une semaine en cours : 3 jours, sessions toutes en mode léger. Le mode complet ajoute à la demande le brief `bras-sequence-v2d.md`
  (3 201 caractères, ~1,5 k jetons) et son hook de lecture.
