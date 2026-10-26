# orchestrate-snapshot rouge en session de vague (L360, 26-10)

Relevé fait depuis une session de vague (lot L360, vague 2026-10-26-1700), pour que la mesure reste dans le dépôt.

## Environnement d'une session de vague

- `cwd` : `<dépôt>/.cadence/runs/<vague>/worktrees/cadence--<lot>` (un worktree sous le dépôt installé).
- `TMPDIR` : `/tmp/cadence-<8 hex>` — `shortTmpBase()` (`src/orchestrate/state.ts`) retombe sur `/tmp` quand le chemin est long, donc **hors de tout dépôt**.
- `PATH` : `<dépôt>/.cadence/runs/<vague>/tool/bin` en tête, puis le Node du projet, puis le `PATH` du lead.
- `HOME` hérité ; `NODE_PATH` absent ; posés par la vague : `CADENCE_ORCHESTRATED`, `CADENCE_SESSION`, `CADENCE_MAX_SESSIONS`, `CADENCE_TEST_WORKERS`, `CLAUDECODE`, `PYTHONDONTWRITEBYTECODE`, `KUBECONFIG=/dev/null`.

## Mesures

- `createRequire('<TMPDIR>/x.json').resolve('yaml')` échoue pour `TMPDIR`, `/tmp` et `/var/tmp` : ces TMPDIR étaient propres.
- Le commit d'avant le lot (HEAD~2), extrait dans `$TMPDIR`, passe `test/orchestrate-snapshot.test.ts` 17/17 dans cette session, sans le correctif.

## Conclusion

L'hypothèse « TMPDIR sous un dépôt installé » (première version de L360) n'explique pas ces sessions. La cause des rouges de L346 et L354 reste inconnue ; `pickRootBase` n'est qu'une garde. Si le rouge revient, le test `R2 — …` de `test/orchestrate-snapshot.test.ts` nomme le fichier qui fournit `yaml`, ainsi que `NODE_PATH` et `HOME` : c'est la mesure à relever.
