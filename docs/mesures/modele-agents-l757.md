# Modèle des agents du plugin : mesure avant/après (L757, D-4)

Constat du 16-11 (article « sous-agents et quota ») : aucun des 11 agents de `agents/` ne déclarait `model`, tous héritaient du
modèle de la session du lead, Opus. Ce lot donne un modèle explicite aux deux agents mécaniques et ne touche pas aux juges.

| Agent | `model` | Pourquoi |
|---|---|---|
| `livreur` | `sonnet` | enchaîne des commandes et rend une ligne ; ses refus deviennent une `Question` au lead, il ne juge rien |
| `precheck-reader` | `sonnet` | lecture rapide ; `cadence orchestrate` le lançait déjà sur Sonnet par `--model` (`src/orchestrate/cycle/session.ts`) |
| les 9 autres (`code-reviewer`, `ux-reviewer`, `qa-reviewer`…) | aucun, héritent | juges : on ne les touche qu'après la mesure du livreur |

Dans une vague, le modèle d'une étape reste celui de son `--model` : `readAgents` ne recopie pas `model` dans la définition passée à
`--agents` (test `test/modele-agents-l757.test.ts`). Le champ ne joue donc que lorsque le lead appelle l'agent avec l'outil Agent, et
dans `.claude/agents/cadence-*.md` installés par `cadence skills install`, qui recopient le fichier tel quel.

## Comment la mesure se lit

Critère : jetons Opus par livraison, avant/après, sur 5 livraisons chacun ; 0 livraison ratée de plus.

Source : les transcripts de Claude Code du lead. L'appel `Agent` du transcript principal (`~/.claude/projects/<dossier>/<session>.jsonl`)
porte `subagent_type` et `prompt` ; le transcript du livreur (`<session>/subagents/*.jsonl`) commence par ce prompt et porte, sur chaque
ligne assistant, `message.model` et `message.usage`. Une réponse en plusieurs blocs répète la même usage sous le même `message.id` :
elle compte une fois. Jetons = entrée + écriture de cache + lecture de cache + sortie.

```sh
node scripts/jetons-agents.mjs --until 2026-11-17 --dernieres 5     # avant : les 5 dernières livraisons sur Opus
node scripts/jetons-agents.mjs --since 2026-11-17 --dernieres 5     # après : les 5 dernières livraisons depuis la publication du lot
node scripts/jetons-agents.mjs --agent precheck-reader              # un autre agent ; --json pour le détail par modèle
```

Une ligne par livraison (date, jetons Opus, total, modèles, `ok` ou `RATÉE`, réponse rendue), puis
`livreur : 5 appel(s), jetons Opus médiane N, total T ; ratées k`. Une livraison est ratée quand le livreur rend une `Question` ou
aucune ligne « livré » / « poussé ». Remplacer `2026-11-17` par la date où le plugin publié porte ce lot.

Lecture : réussite si la médiane « après » est 0 jeton Opus (le livreur ne tourne plus sur Opus) et si le nombre de ratées « après »
ne dépasse pas celui d'« avant ». Une question légitime (porte rouge, sha déjà poussé) compte comme ratée des deux côtés : on compare
les causes en lisant les lignes avant de conclure. Si les ratées augmentent, on retire `model: sonnet` du livreur (règle : un mécanisme
sans gain mesuré est retiré). Ce n'est qu'avec ce résultat qu'on proposera un modèle pour un juge, `code-reviewer` restant sur Opus.

Les cas d'éval qui couvrent `agents/livreur.md` (`deliver-sha`, `livrer-sh-sans-bloc`, `raf-done-sans-revue`) posent une question en
lecture seule, sans outil Agent : ils vérifient que le texte de l'agent n'a pas régressé, pas le modèle ; la mesure ci-dessus le fait.
