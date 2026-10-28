# Mesure du contexte initial d'une session de vague (L398)

Avant L398, une session de vague (`claude -p`) chargeait les plugins activés par l'utilisateur : leurs hooks (celui de démarrage de superpowers injecte 3 405 caractères de consignes) et la liste de leurs skills. Des vagues relevaient 29 à 60 k jetons au premier tour pour des sessions qui ne font que lire, éditer et lancer Bash. Depuis L398, `buildArgs` et `buildRetryArgs` passent `--settings '{"enabledPlugins":{"<id>":false,…}}'` avec les plugins activés (`enabledPlugins: { "<id>": true }`) dans `$CLAUDE_CONFIG_DIR/settings.json` (repli `~/.claude/settings.json`), `.claude/settings.json` et `.claude/settings.local.json` du projet. Rien d'autre n'est touché : les réglages de l'utilisateur et du projet (`permissions`, `autoMode`, `language`, `env`, hooks, fournisseur et authentification), ses skills, ses agents et son `CLAUDE.md` global s'appliquent avec leur précédence normale. Sans plugin activé, aucun drapeau n'est ajouté. Les sessions de `cadence ref analyse` font de même.

Une première conception (`--setting-sources project,local`, qui écartait tout `~/.claude` et relayait une copie des réglages de l'utilisateur dans un fichier `--settings`) mesurait 41 880 → 29 798 jetons (−29 %) ; elle est abandonnée : la copie en 0644 des secrets de `env`, jamais supprimée, les identifiants Bedrock/Vertex retirés, `CLAUDE_CONFIG_DIR` ignoré et les clés du projet écrasées l'ont fait juger non conforme. **Le chiffre de −29 % ne vaut plus.**

## Vérification : `enabledPlugins` à `false` désactive bien le plugin

Vraie session `claude -p --model haiku` le 2026-10-28, dans un dossier vide (`git init`), journal `--debug-file`, plugin `superpowers@claude-plugins-official` (un hook `SessionStart`, 15 skills) :

| Drapeaux | Journal debug | Ce que le modèle voit |
|---|---|---|
| aucun | `Read hooks.json for plugin superpowers (enabled=true)` puis `Hook SessionStart … provided additionalContext (3405 chars)` | consignes du hook présentes, 15 skills `superpowers:*` sur 84 |
| `--settings '{"enabledPlugins":{"superpowers@claude-plugins-official":false}}'` | `Read hooks.json for plugin superpowers (enabled=false; will NOT register, plugin is disabled)` ; aucun hook joué | aucune consigne du hook, 0 skill `superpowers:*` sur 69 |

Le même drapeau l'emporte sur un `.claude/settings.json` du projet qui active le plugin (`enabled=false` au journal, 0 skill) : `--settings` a la précédence la plus haute, et son `enabledPlugins` se fusionne avec les autres fichiers (les autres plugins restent). Pour ce seul plugin, le premier tour passait de 53 360 à 52 127 jetons (haiku, sans les drapeaux de l'étape).

## Méthode

Un dossier vide (`git init`) hors dépôt, la ligne de commande d'une étape `implement` telle que `buildArgs` la compose (modèle `sonnet`, `--json-schema` de l'étape, `--session-id`, `--permission-mode auto`, `--disallowedTools` du programme, variables `CADENCE_ORCHESTRATED`, `CLAUDE_CODE_DISABLE_BACKGROUND_TASKS=1` et le bac à sable `KUBECONFIG=/dev/null`), le prompt « Réponds ok ». Le contexte du **premier tour** est `input_tokens + cache_creation_input_tokens + cache_read_input_tokens` du premier message `assistant` de `--output-format stream-json --verbose` ; le champ `usage` du résultat final additionne tous les appels de la session (ici deux : avec `--json-schema`, le modèle répond par l'outil `StructuredOutput`), il est donné à part. Relevé le 2026-10-28 sur la machine de développement (8 plugins activés : feature-dev, ralph-loop, superpowers, playwright, cloudflare, qodo, claude-hud, cadence ; `--settings` de 328 octets), chaque ligne deux fois.

| Ligne de commande | Premier tour (jetons) | Session de mesure, 2 appels (jetons) |
|---|---|---|
| **avant** L398 : aucun `--settings` | **42 541** (42 541, 42 541) | 85 127 (85 127, 85 127) |
| **après** L398 : `--settings '{"enabledPlugins":{…8 plugins à false}}'` | **38 330** (38 330, 38 329) | 76 704 (76 705, 76 703) |

Écart : **−4 211 jetons au premier tour (−9,9 %)** à chaque session, relance de mise en forme comprise ; −8 423 sur les deux appels de la session de mesure. Les ~38 k restants sont le prompt système et les outils intégrés de Claude Code (~30 k), plus les skills, agents, `CLAUDE.md` global et mémoire de l'utilisateur, gardés par décision : ce sont ses réglages, avec leur précédence, et une session de vague les a comme lui.

## Ce qui n'est pas mesuré

Les « jetons par étape avant/après sur deux vagues » n'ont pas été relevés : lancer deux vagues complètes dépasse la session du lot ; ils se relèvent sur les journaux de vague (`cadence perf`), **avant** = vagues antérieures à la version qui porte L398, **après** = vagues suivantes. Tant qu'ils manquent, seul le gain du premier tour (−4,2 k) est établi, pas le gain total d'une session. Le poids propre de chaque plugin n'est pas mesuré non plus : seul superpowers l'a été à part (environ −1,2 k).
