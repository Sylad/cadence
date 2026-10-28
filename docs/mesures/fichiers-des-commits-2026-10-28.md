# `raf check`, `raf now` et `session start` : les fichiers des commits en un seul `git log` (L394)

Date : 28 octobre 2026. Dépôt mesuré : celui de cadence lui-même, 2 764 commits, plan de ~560 Ko. Machine de développement (WSL2), cache disque chaud, une mesure par ligne.

## Constat

`workCommits` (`src/audit.ts`) écarte les commits qui ne touchent que le plan ou qu'une version. Pour chacun, `isPlanOnly` et `isReleaseOnly` lisent ses fichiers par un `git diff-tree` : un processus git par commit lié, soit 89 % du temps de `raf check` (20 s), de `raf now` (15 s) et de `cadence session start` (25 s). `cadence lead tour --json` (35 s) dépassait le délai de 20 s de la bande du HUD, qui affichait alors une liste de projets vide.

## Correction

`workCommits` précharge les fichiers de tous ses commits d'un seul `git log --name-only` (`preloadChangedFiles`, écrit pour le Gantt en L381), et `audit` précharge d'emblée ceux de tous les lots liés. `changedFiles` lit ensuite le cache.

## Mesure

```
node m.mjs <build>/ check ; node m.mjs <build>/ now     # run() de src/cli.ts, dans le dépôt de cadence
```

| Commande | Avant (`HEAD` au départ du lot) | Après |
|---|---|---|
| `raf check` | 16,5 s | 3,4 s |
| `raf now` | 14,7 s | 3,5 s |

Le test `test/git-par-commit-l394.test.ts` compte les sous-commandes git lancées (un `git` d'enveloppe dans le `PATH`) : aucun `diff-tree` pour `raf check` et `cadence session start`, avec 24 commits liés.
