# Code Mode de Claude Code et mode script maison : banc court sur une revue UX (L839, D-34)

Étude du 25-11-2026. Question posée par la note du 25-11 sur L839 : le Code Mode de Claude Code (fonction expérimentale,
`CLAUDE_CODE_EXPERIMENTAL_CODE_MODE=1`, [doc](https://code.claude.com/docs/en/code-mode.md)) fait-il baisser le coût d'une
revue UX à défauts égaux, et les hooks `PreToolUse` voient-ils encore les commandes ? Le mode script maison
(`Mode: script`, [`cadence mesures`](../mesures-page.md)) est comparé au même banc.

## Verdict

| Mécanisme | Verdict | Raison mesurée |
|---|---|---|
| Code Mode de Claude Code | **ne pas garder** | mêmes défauts retrouvés (7 sur 7), coût +26 %, jetons +58 %, durée +22 % |
| Mode script maison (`Mode: script`) | **ne pas garder** | mêmes défauts retrouvés (7 sur 7), coût +3 %, jetons +71 %, durée × 2,3 |

Le critère fixé avant le banc ([page du banc](../mesures/ux-mode-script-l839.md)) était « autant de défauts connus pour moins
de jetons ». Aucun des deux mécanismes ne le remplit. Les hooks, eux, tiennent sous Code Mode (section 4) : ce n'est pas la
raison du refus.

Ce que ce verdict ne couvre pas est dit en section 6.

## 1. Le banc

- **Écran** : `test/fixtures/mesures/defauts.html`, la page de test de L839, petite et connue, avec ses 7 défauts semés
  (D1 bandeau de 600 px qui fait défiler à 375 px, D2 titre tronqué, D3 mot coupé, D4 valeur séparée de son unité,
  D5 libellé court sur deux lignes, D6 cible de 16 × 16 px, D7 police de 10 px). Les commentaires CSS qui nomment les
  défauts sont retirés de la copie servie, et le brief interdit de lire le fichier : la revue juge la page rendue.
- **Revue** : le texte de `agents/ux-reviewer.md` en prompt système ajouté, le même brief pour tous (quatre largeurs,
  état de base et état « panneau ouvert », rapport dans un fichier), Playwright MCP seul serveur MCP, modèle
  `claude-opus-5-5`, `claude -p`, 2 essais par bras.
- **Bras A** : sans la variable. **Bras B** : avec la variable. **Bras C** : sans la variable, brief suivi de la ligne
  `Mode: script`.
- **Mesures** : celles du résultat JSON de `claude -p` (coût au tarif API, jetons, durée, tours), les appels d'outils du
  flux, le journal d'un hook `PreToolUse` posé sur tous les outils, et les 7 défauts cherchés un à un dans chaque rapport.
- **Budget** : 15 $ au plus. Dépensé : 4,22 $ (six revues 4,16 $, sondes Haiku 0,06 $).

## 2. Ce qu'il a fallu pour que le Code Mode démarre

Trois faits, tous mesurés avant la première revue :

1. **Claude Code 2.1.325, la version installée sur la machine, ne démarre pas le Code Mode sous `claude -p`.** Avec la
   variable (dans le shell, puis par `--settings`), la session n'a aucun appel de code, ses appels sont ceux du bras
   sans variable, et rien ne le dit : ni la sortie, ni le flux `stream-json`, ni le journal de débogage. Parmi les
   raisons que ce binaire connaît, celle qui s'applique est « for now it only works in the interactive terminal » ;
   la page de doc dit la même chose (« Surface: an interactive `claude` session »).
2. **La 2.1.332 le démarre sous `claude -p`.** Le banc a utilisé le binaire officiel de cette version, téléchargé dans
   un dossier temporaire, sans toucher à l'installation.
3. **Sous `claude -p`, la variable posée dans l'environnement de la commande ne suffit pas.** Il faut la passer par
   `--settings '{"env":{"CLAUDE_CODE_EXPERIMENTAL_CODE_MODE":"1"}}'`. Posée seulement dans le shell, elle est ignorée en
   silence. Il faut aussi que `CLAUDE_AGENT_SDK_MCP_NO_PREFIX` soit absente de l'environnement.

Conséquence pour cadence : un `cadence run` d'aujourd'hui (2.1.325, `claude -p`) ne peut pas être en Code Mode, variable
posée ou non. La note du 25-11 (« s'active par la variable dans l'env de la commande, marche avec `claude -p` ») est à
corriger sur ces trois points.

On reconnaît une session en Code Mode dans le flux `stream-json` à ses identifiants d'appel `toolu_cc_…` (50 et 57 dans
les deux essais du bras B, 0 dans les bras A et C).

## 3. Résultats

| Essai | Défauts connus | Coût | Jetons (tous postes) | dont sortie | Durée | Requêtes au modèle | Appels d'outils |
|---|---|---|---|---|---|---|---|
| A1 sans la variable | 7 / 7 | 0,59 $ | 337 924 | 10 236 | 94 s | 8 | 9 |
| A2 sans la variable | 7 / 7 | 0,68 $ | 338 056 | 11 689 | 114 s | 7 | 9 |
| B1 Code Mode | 7 / 7 | 0,81 $ | 512 008 | 12 775 | 115 s | 9 | 16 |
| B2 Code Mode | 7 / 7 | 0,78 $ | 559 112 | 14 497 | 139 s | 10 | 18 |
| C1 mode script | 7 / 7 | 0,67 $ | 539 563 | 11 215 | 241 s | 14 | 15 |
| C2 mode script | 7 / 7 | 0,63 $ | 618 946 | 9 825 | 233 s | 16 | 17 |

| Bras | Défauts connus | Coût moyen | Jetons moyens | Durée moyenne |
|---|---|---|---|---|
| A sans la variable | 14 / 14 | 0,63 $ | 337 990 | 104 s |
| B Code Mode | 14 / 14 | 0,80 $ (+26 %) | 535 560 (+58 %) | 127 s (+22 %) |
| C mode script | 14 / 14 | 0,65 $ (+3 %) | 579 255 (+71 %) | 237 s (× 2,3) |

Les jetons sont la somme entrée + écriture de cache + lecture de cache + sortie ; la lecture de cache en fait plus de 80 %,
d'où un écart de coût plus petit que l'écart de jetons. Les six rapports nomment aussi le débord du panneau ouvert (700 px
à 375 px), qui n'est pas dans la liste des 7.

Lecture :

- **Le bras A fait déjà ce que les deux mécanismes promettent.** Sans consigne, Opus 5.5 mesure la page par 2 ou 3 scripts
  Playwright (`browser_run_code_unsafe`), ne prend aucun instantané (`browser_snapshot` : 0 appel dans les six essais) et
  relit 3 ou 4 captures. Il n'y a plus de clics et d'instantanés un par un à économiser sur cet écran : 9 appels d'outils,
  pas les 69 du vécu du 24-11.
- **Le Code Mode n'a pas réduit les appels, il en a ajouté** (16 et 18 contre 9) : plus de captures relues, et le rapport
  écrit puis repris par 1 à 6 `Edit`. Chaque requête de plus relit tout le contexte en cache.
- **Le mode script double la durée** : `cadence mesures` joue 8 passes de navigateur (4 largeurs × 2 états) avant que
  l'agent ne lise quoi que ce soit, puis l'agent lance quand même son script Playwright pour le contraste et le focus.

## 4. Hooks `PreToolUse` sous Code Mode

Vérifié sur la 2.1.332, avec et sans la variable :

| Contrôle | Sans la variable | Avec la variable |
|---|---|---|
| Un hook `PreToolUse` posé sur tous les outils journalise 3 commandes Bash demandées une à une | 3 lignes | 3 lignes, les mêmes commandes |
| Ce hook refuse la commande qui porte un marqueur (code 2) | refusée, non exécutée | refusée, non exécutée |
| Le vrai hook pipefail de la machine, réglages de l'utilisateur chargés : `npx vitest run --help \| tail -1` | refusée, message du hook rendu mot pour mot | refusée, même message |
| Journal du hook contre appels du flux, sur les deux revues du bras | identiques (9 et 9) | identiques (16 et 18) |

Deux différences à connaître :

- Le hook ne reçoit **aucun appel pour le code lui-même** : aucune ligne `REPL` dans le journal du hook posé sur `*`.
  Il voit les appels que le code fait, sous leur nom habituel (`Bash`, `Read`, `mcp__playwright__…`).
- Une commande peut arriver **précédée de `cd '<dossier>' &&`** (vu une fois dans le bras B). Un hook qui compare la
  commande entière à un motif ancré au début la manquerait. Le hook pipefail cherche le motif dans la commande : il tient.

Non vérifié : le hook arret-18h30 (le banc s'est joué avant 18 h, il n'avait rien à refuser), le mode auto (le banc
tournait en `bypassPermissions`), une exécution de plus de 10 minutes, et le Code Mode dans un sous-agent lancé par
l'outil Agent (le banc lance `claude -p`, pas un sous-agent).

## 5. Rejouer le banc

Par essai, depuis un dossier vide, la page servie par `python3 -m http.server 8839 --bind 127.0.0.1` :

```bash
claude -p "$BRIEF" --model claude-opus-5-5 --append-system-prompt "$(corps de agents/ux-reviewer.md)" \
  --setting-sources project --settings "$REGLAGES" --mcp-config mcp.json --strict-mcp-config \
  --permission-mode bypassPermissions --output-format stream-json --verbose --max-budget-usd 2.5 --no-session-persistence
```

- `mcp.json` : `{"mcpServers":{"playwright":{"command":"npx","args":["@playwright/mcp@latest","--headless","--isolated"]}}}`.
- `$REGLAGES`, bras A et C : un hook `PreToolUse` de matcher `*` qui écrit `tool_name` et `tool_input.command` dans un journal.
  Bras B : le même, plus `"env":{"CLAUDE_CODE_EXPERIMENTAL_CODE_MODE":"1"}`.
- `$BRIEF` : l'URL de la page, les quatre largeurs, les deux états, « ne lis pas le fichier HTML sur le disque », « pas de
  sondes d'interaction », le dossier des captures et `Report file:`. Bras C : plus la ligne `Mode: script`.
- Lancer `claude` sans les variables `CLAUDE_CODE_*` de la session qui lance le banc (`env -u …`), sinon la session fille
  se prend pour une session de l'application.
- Chiffres : l'événement `result` du flux (`total_cost_usd`, `usage`, `duration_ms`, `num_turns`) ; appels :
  les `tool_use` des messages `assistant` ; Code Mode actif : `grep -c toolu_cc_`.

## 6. Limites

- **Un petit écran, 2 essais par bras.** Le cas réduit sans modèle de la [page du banc](../mesures/ux-mode-script-l839.md)
  montre que le gain du mode script grandit avec la page ; ce banc ne dit rien d'un écran lourd comme maritime UXW-36.
  L'écart de coût du bras C (+3 %) est dans le bruit de 2 essais ; celui du bras B (+26 %) et les écarts de jetons et de
  durée ne le sont pas (les deux essais de chaque bras sont du même côté).
- **Le bras C a payé le brief du banc.** `cadence mesures` n'étant pas permis dans cette session, le brief renvoyait à
  `node scripts/mesures-page.mjs`, qui n'est pas lançable tel quel : l'agent a dépensé plusieurs appels Bash pour trouver
  comment appeler `main`. Ce détour pèse sur ses requêtes et ses jetons, pas sur les 8 passes de navigateur qui font sa durée.
- **Une revue UX, pas un `cadence run`.** La précision du 25-11 sur D-34 demandait aussi un `cadence run` rejoué. Il n'est
  pas joué : sur la version installée il ne peut pas être en Code Mode (section 2), et ce banc devait rester court.
- **Une fonction expérimentale qui bouge.** Le changelog de la 2.1.332 porte à lui seul 11 lignes sur le Code Mode (8 corrections, 3 améliorations). Ce verdict vaut pour
  la 2.1.332 du 25-11.

## 7. Suites proposées au lead

- **Code Mode** : rien à retirer, il n'a jamais été activé. La veille `veille/code-mode/` continue ; le banc se rejoue en
  20 minutes et 5 $ si une version annonce un gain sur les revues ou sur les lots.
- **Mode script** : ne pas mettre `Mode: script` dans les briefs. Le retrait de la section « Script mode » de
  `agents/ux-reviewer.md`, que le critère de la page du banc prévoit, est un geste du lead : il peut préférer le banc
  complet (UXW-36 rejouée) avant de retirer. La commande `cadence mesures` reste utile sans modèle (mesures de mise en
  page en un passage, test de non-régression d'un écran).
- **Le vécu du 24-11** (63,63 $ de `ux-reviewer` sur 24 h, 69 appels pour UXW-36) ne se reproduit pas ici : avant
  d'outiller, regarder dans les transcriptions de ces revues quels appels coûtent (instantanés, captures relues,
  sondes d'interaction).
