# orchestrate — plan d'implémentation (lot L3)

Spec validée : `docs/superpowers/specs/2026-10-04-orchestrate-design.md` (commit 1ca5bc8), avec les
amendements de Sylvain du 04-10 (notes du lot L3). Ce plan ne rouvre aucune question de design ; il
ordonne le travail et fixe les choix de mise en œuvre que la spec laisse ouverts.

## Amendements pris en compte

1. **Budget** = entrée + écriture de cache + sortie ; la lecture de cache est conservée à part et
   affichée à part (tableau, `wave.json`).
2. **Pas de `raf ux` automatique** : l'orchestrateur lance la revue UX et rapporte verdict et
   sous-tâches ; le lead enregistre. `raf review` reste automatique.
3. **Plans en lecture seule** : `orchestrate.start` / `orchestrate.verdict` dans `cadence.yaml`.
4. **Push bloqué par un hook `pre-push` temporaire**, posé pendant la vague et retiré à sa fin, qui
   refuse tout push quand `CADENCE_ORCHESTRATED` est dans l'environnement. **Jamais de `pushurl`
   modifié** (ni `GIT_CONFIG_*`). Après chaque session, référence amont et `git ls-remote` sont
   comparées à l'avant.
5. **Ordre** : revue UX, puis revue de code, qui clôt toujours le cycle.

## Choix de mise en œuvre (la spec ne tranche pas, le plan retient)

- Code dans `src/orchestrate/` ; gabarits dans `templates/orchestrate/` (ajoutés à `files`) ; échantillon
  réel de sortie `claude -p` enregistré dans `test/fixtures/claude-result.sample.json` (une seule
  exécution à la main, hors suite, modèle haiku, schéma trivial : la sortie structurée est dans
  `structured_output`, les compteurs dans `usage`).
- Lanceur injecté : `deps.claude(args, opts)` ; les tests de bout en bout utilisent un faux
  `claude` (`test/fixtures/fake-claude.mjs`, `CADENCE_CLAUDE_BIN`). Aucun test ne lance le vrai.
- Sorties structurées : `tests` et `build` portent en plus un booléen `vert`, pour que « annoncés
  rouges » se lise sans interpréter du texte.
- Conformité d'un cycle : revue de code sans bloquant ni majeur **et**, pour un lot visible avec
  revue UX, revue UX sans bloquant ni majeur. La revue UX n'est rejouée que si la précédente était
  non conforme ; la revue de code l'est à chaque passe (elle clôt le cycle).
- Hook `pre-push` : s'il en existe déjà un qui n'est pas le nôtre, le lot est refusé avant d'agir
  (pas de remplacement d'un hook versionné, ce qui salirait l'arbre).
- Après une session d'écriture, « dépôt sale » = fichier suivi modifié ou fichier non suivi
  apparu depuis l'avant-session (`.cadence/` exclu).
- `{verdict}` dans `orchestrate.verdict` est inséré échappé pour une chaîne entre guillemets doubles.

## Tâches

Chaque tâche : test d'abord (vu rouge), code, `npm test` / `npm run typecheck`, commit à chemins
explicites `feat(L3): …`.

### t1 — lanceur de session
`src/orchestrate/{result,launch}.ts`, `test/orchestrate-launch.test.ts`, fixture réelle.
Parseur (champ absent = erreur nommée, jamais zéro), compteurs, arguments (`--model`, `--agents` /
`--agent` pour les revues, `Agent` et `git push` / `deliver` / `raf done|review|ux` interdits,
permission-mode, add-dir), environnement de garde, délai avec mort du groupe de processus, pic de
contexte relu dans le journal `.jsonl`.

### t2 — état et verrous
`src/orchestrate/{state,lock}.ts`, `test/orchestrate-state.test.ts`. `wave.json` et un fichier par
lot, écriture atomique, journal, `.git/info/exclude`, verrou de vague et de dépôt (lien atomique, pid
mort retiré avec avertissement).

### t3 — gabarits et schémas (spec t4, avancée : le cycle en dépend)
`templates/orchestrate/*.md`, `src/orchestrate/{briefs,schemas}.ts`, `skills/lead/SKILL.md` renvoie au
gabarit, `package.json` `files`. Test épinglé : `implement.md` contient le brief du lead, le skill le cite.

### t4 — cycle d'un lot (spec t3 + t6)
`src/orchestrate/{cycle,guard}.ts`. Machine à états persistée (`next`), passes, petit lot, UX puis code,
contrôles après session (arbre, HEAD, amont), commits confrontés à git, `raf review` automatique
(sha relu), commits du plan, plans en lecture seule, hook pre-push.

### t5 — ordonnanceur
`src/orchestrate/pool.ts` : deux créneaux, une file par dépôt, budget et quota vérifiés avant chaque session.

### t6 — commande
`src/orchestrate/{command,table}.ts`, branchement dans `src/cli.ts` : parsing des lots, préconditions
(code 2), `--dry-run`, `--status`, `--resume`, `--budget`, `--answer`, tableau, codes 0/1/2/3, signaux.

### t7 — garde-fous
`raf done|ux|review` et `cadence deliver` refusent sous `CADENCE_ORCHESTRATED` ; `deliver` refuse un
dépôt dont le verrou d'orchestration est vivant.

### t8 — documentation
README (commande, état, garde-fous, `cadence.yaml: orchestrate`), skill `lead` (vague par
l'orchestrateur, ce qui reste au lead). Hors code : la première vague réelle mesurée et sa note au lot.

## Hors de cette livraison

Vague réelle avec le vrai `claude` (jamais lancée ici), mesure de contexte, note au lot, `raf done`,
`raf ux`, `raf review`, publication.
