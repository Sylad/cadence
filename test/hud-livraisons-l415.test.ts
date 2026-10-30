import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';

// Le mod est hors du typecheck de cadence (tsconfig.json) : son module est chargé à l'exécution, par une URL que tsc ne suit pas.
const { LAST_DELIVERIES } = (await import(new URL('../plugins/cadence-hud/hooks/collect.ts', import.meta.url).href)) as { LAST_DELIVERIES: string };

// L415 : le script Python de la dernière livraison de chaque projet, joué sur de vrais journaux (les tests du mod n'ont pas accès au système de fichiers).

const OLD = new Date('2026-10-28T10:00:00Z');
const RECENT = new Date('2026-10-29T10:00:00Z');

function lastOf(setup: (repo: (name: string, green: string | null, failed: string | null, redIsNewer?: boolean) => void, root: string) => void): unknown {
  const root = mkdtempSync(join(tmpdir(), 'livraisons-'));
  try {
    const repo = (name: string, green: string | null, failed: string | null, redIsNewer = false) => {
      const dir = join(root, name, '.git', 'cadence');
      mkdirSync(dir, { recursive: true });
      if (green !== null) {
        writeFileSync(join(dir, 'deliveries.log'), green);
        utimesSync(join(dir, 'deliveries.log'), redIsNewer ? OLD : RECENT, redIsNewer ? OLD : RECENT);
      }
      if (failed !== null) {
        writeFileSync(join(dir, 'deliveries-failed.log'), failed);
        utimesSync(join(dir, 'deliveries-failed.log'), redIsNewer ? RECENT : OLD, redIsNewer ? RECENT : OLD);
      }
    };
    setup(repo, root);
    const run = spawnSync('python3', ['-I', '-c', LAST_DELIVERIES, root], { encoding: 'utf8' });
    expect(run.status).toBe(0);
    return JSON.parse(run.stdout);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

it('L415 R2 — LAST_DELIVERIES rend, par projet, la dernière ligne du journal vert : jour, sha, « verte », et le jour de la dernière verte', () => {
  expect(lastOf(repo => repo('ol', '2026-10-27 aaa1111\n2026-10-29 bbb2222\n', null))).toEqual([{ project: 'ol', day: '2026-10-29', sha: 'bbb2222', status: 'verte', green: '2026-10-29' }]);
});

it('L415 R3 — une livraison rouge écrite après la dernière verte est la dernière livraison (« rouge », son sha) ; le jour de la dernière verte reste rendu', () => {
  expect(lastOf(repo => repo('finance', '2026-10-27 aaa1111\n', '2026-10-29 bbb2222 [ci] CI en échec ⏎ boum\n', true))).toEqual([
    { project: 'finance', day: '2026-10-29', sha: 'bbb2222', status: 'rouge', green: '2026-10-27' },
  ]);
});

it('L415 R3 — une livraison verte écrite après le rouge l’efface : la dernière est la verte', () => {
  expect(lastOf(repo => repo('ol', '2026-10-29 bbb2222\n', '2026-10-28 ccc3333 [ci] CI en échec\n', false))).toEqual([{ project: 'ol', day: '2026-10-29', sha: 'bbb2222', status: 'verte', green: '2026-10-29' }]);
});

it('L415 R3 — un projet qui n’a jamais livré vert : le rouge seul, green nul', () => {
  expect(lastOf(repo => repo('neuf', null, '2026-10-29 ccc3333 [refus] refusé\n'))).toEqual([{ project: 'neuf', day: '2026-10-29', sha: 'ccc3333', status: 'rouge', green: null }]);
});

it('L415 R2 — sans journal, journaux vides ou lignes illisibles, dépôt dont .git est un fichier, dossier sans git : le projet est absent, jamais une erreur', () => {
  expect(
    lastOf((repo, root) => {
      repo('vide', '\n\n', '\n');
      repo('illisible', 'pas un jour\n', 'pas un jour non plus\n');
      repo('propre', null, null);
      mkdirSync(join(root, 'sans-git'));
      mkdirSync(join(root, 'worktree'));
      writeFileSync(join(root, 'worktree', '.git'), 'gitdir: /ailleurs\n');
      writeFileSync(join(root, 'cadence.yaml'), '');
    }),
  ).toEqual([]);
});

it('L415 R2 — une ligne verte sans sha n’est pas une livraison ; la dernière ligne lisible fait foi quand une dernière ligne est illisible', () => {
  expect(lastOf(repo => repo('ol', '2026-10-27 aaa1111\n2026-10-29\n', null))).toEqual([{ project: 'ol', day: '2026-10-27', sha: 'aaa1111', status: 'verte', green: '2026-10-27' }]);
});

it('L415 R2 — les projets sont rendus par nom, le dossier lui-même compris ; les dossiers cachés et node_modules sont sautés', () => {
  const out = lastOf((repo, root) => {
    repo('b', '2026-10-29 bbb2222\n', null);
    repo('a', '2026-10-29 aaa1111\n', null);
    repo('.cache', '2026-10-29 ccc3333\n', null);
    repo('node_modules', '2026-10-29 ddd4444\n', null);
    const own = join(root, '.git', 'cadence');
    mkdirSync(own, { recursive: true });
    writeFileSync(join(own, 'deliveries.log'), '2026-10-29 eee5555\n');
  }) as { project: string }[];
  expect(out).toHaveLength(3);
  expect(out.map(d => d.project).slice(1)).toEqual(['a', 'b']);
  expect(out.map(d => d.project)).not.toContain('.cache');
  expect(out.map(d => d.project)).not.toContain('node_modules');
});
