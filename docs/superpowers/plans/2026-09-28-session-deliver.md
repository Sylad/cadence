# session et deliver — plan d'implémentation

> Exécution : native (session principale, TDD), relecteur Opus sur l'ensemble à la fin.

**Goal :** `cadence session start|close|next`, `cadence deliver`, trois skills et leur distribution.

**Architecture :** modules purs testés (`state.ts`, `session.ts`, `deliver.ts`, `skills.ts`), branchés
dans `cli.ts` ; `run` devient `number | Promise<number>` pour la seule commande `deliver`.

**Tech :** Node ≥ 20, TypeScript, vitest, `yaml` (seule dépendance).

**Spec :** `docs/superpowers/specs/2026-09-28-session-deliver-design.md`

## Global Constraints

- Aucune dépendance nouvelle ; messages du CLI en français ; README et skills en anglais.
- État local sous `git rev-parse --git-path cadence`, jamais dans l'arbre de travail.
- `CADENCE_SHORT` = 7 caractères exactement.
- Codes `deliver` : 0 livré, 1 étape en échec, 2 refus avant d'agir.

## Review Focus

1. Dépôt sans branche amont / sans remote : `session start` ne plante pas, dit « pas de branche amont ».
2. Verrou périmé (pid mort) : retiré avec avertissement, la livraison continue.
3. `gh` renvoie une liste vide puis des runs : pas d'échec avant le délai d'apparition.
4. `cadence.yaml` mal formé (deploy pas une liste, verify sans url ni command) : refus code 2, message clair.
5. Échec d'une commande de déploiement : le verrou est quand même retiré.

---

### Task 1 : état local et faits de dépôt (`src/state.ts`, `src/git.ts`)

- `stateDir(cwd): string` (crée le dossier), `readNext/writeNext`, `readLock/writeLock/removeLock`,
  `pidAlive(pid)`, `appendDelivery(dir, day, sha)`, `lastDelivery(dir): string | null`.
- git : `repoStatus(cwd): { branch, dirty: number, upstream: string | null, ahead: number }`,
  `headSha(cwd)`, `onRemote(cwd, sha): boolean`.
- Tests : dépôt temporaire sans amont (upstream null), avec un clone « origin » (ahead 1 puis 0 après push),
  aller-retour next / lock / deliveries.

### Task 2 : `session start|close|next` (`src/session.ts`, `cli.ts`)

- Factoriser la sélection des propositions de `now` : `nextUp(lots, byLot): Lot[]` (doing, puis todo
  prêts, gains rapides d'abord) — `now` l'utilise.
- `sessionStart(ctx, { since, idle })` et `sessionClose(ctx, { since })` renvoient des lignes + code.
- Tests (via `run`) : notes de clôture affichées, lot doing silencieux (> 2 j), commits groupés par lot,
  écarts, propositions ordonnées ; close : commit sans lot listé, lot doing sans commit du jour,
  code 1 sur arbre sale, 0 sur dépôt propre sans amont… (amont absent = pas un écart).

### Task 3 : `deliver` (`src/deliver.ts`, `cli.ts`, `bin/*.js`)

- `loadDeliverConfig(path)` valide la forme (code 2 sinon).
- `deliver(opts, deps)` avec `deps = { exec(cmd, env) → code, gh(sha) → Run[], fetch, sleep, now, out, err }`.
- CI github : sondage 15 s, 300 s d'apparition, `ciTimeout` ; conclusions acceptées success/skipped/neutral.
- Vérifications réessayées toutes les 10 s jusqu'à `verifyTimeout`, substitution `${SHA}`/`${SHORT}`.
- Tests : refus (config absente, arbre sale, sha non poussé, verrou vivant), verrou périmé retiré,
  dry-run n'exécute rien, CI vide → échec après délai (sleep simulé qui avance l'horloge), run en échec,
  déploiement en échec → verrou retiré, vérif url qui passe au 2e essai, succès → deliveries.log + lots livrés.

### Task 4 : skills, plugin, install (`skills/*/SKILL.md`, `.claude-plugin/`, `src/skills.ts`)

- Trois SKILL.md selon la spec ; `plugin.json` + `marketplace.json` ; `package.json` `files` += `skills`, `.claude-plugin`.
- `installSkills(srcDir, destDir, force)` : préfixe `cadence-`, réécrit `name:`, refuse un dossier différent.
- Tests : installation, idempotence, refus sans `--force`.

### Task 5 : README, aide, finance-tracker

- README (sections session, deliver, skills), aide de `bin/cadence.js`.
- finance-tracker : lot raf, `cadence.yaml`, script de bump, skills installés, CLAUDE.md, `cadence deliver --dry-run`.
