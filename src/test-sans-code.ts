import { existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { tryGit } from './git.js';
import { withFiles } from './orchestrate/gate-parts.js';

/** Nombre de tests ajoutés joués au plus (un essai par fichier : le coût est celui du rejeu seul). */
const MAX_TESTS_SANS_CODE = 10;

const git = (cwd: string, args: string[]): string => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });

interface TestsVertsSansCode {
  /** Les tests ajoutés par le lot qui restent verts une fois retiré tout ce que le lot a changé hors tests : ils ne gardent rien de ce changement. */
  refuses: string[];
  /** Les tests ajoutés au-delà de la borne, non joués. */
  ignores: string[];
}

/**
 * Contrôle d'après écriture (L646) : un test AJOUTÉ par le lot (fichier de test ajouté au diff `start`..HEAD : un test déplacé en est un, un test modifié non) qui reste vert sans ce que le lot a changé hors tests ne garde rien de ce changement.
 * « Sans le code » : un arbre d'essai (worktree détaché au HEAD) où chaque fichier du diff qui n'est pas un test (`isTest`), du code ou non, revient à son état de `start` si le lot l'a modifié ou supprimé
 * et est retiré si le lot l'a ajouté ; les fichiers de test y restent ceux de HEAD. Les `max` premiers tests ajoutés y sont rejoués chacun seul (`replay`, `{files}` remplacé), les suivants rendus dans `ignores` ; code 0 = refusé.
 * Tout autre code n'est pas un vert, 127 (commande introuvable) ou dépendance absente de l'arbre compris : rien n'est refusé pour lui. Sans test ajouté ou sans fichier de code (`isCode`, hors tests) au diff, rien à comparer : rien n'est joué, le lot n'est pas refusé.
 */
export async function testsVertsSansCode(o: {
  dir: string;
  start: string;
  isCode: (file: string) => boolean;
  isTest: (file: string) => boolean;
  replay: string;
  /** `orchestrate.worktreeDeps` : les dossiers de dépendances à lier dans l'arbre d'essai ; absent, le `node_modules` de la racine. */
  deps?: string[];
  run: (command: string, cwd: string) => Promise<{ code: number; output: string }>;
  max?: number;
}): Promise<TestsVertsSansCode> {
  const changed = git(o.dir, ['-c', 'core.quotepath=off', 'diff', '--name-status', '--no-renames', o.start, 'HEAD'])
    .split('\n')
    .filter(Boolean)
    .map((l) => ({ status: l[0]!, file: l.slice(1).trim() }));
  const added = changed.filter((c) => c.status === 'A' && o.isTest(c.file)).map((c) => c.file);
  const code = changed.filter((c) => o.isCode(c.file) && !o.isTest(c.file));
  // Un test ajouté peut garder un fichier du lot qui n'est pas du code (gabarit, doc, package.json) : « sans le lot » les remet aussi à leur état de départ, sinon un test sur ce gabarit sortirait vert à tort.
  const others = changed.filter((c) => !o.isTest(c.file));
  const empty: TestsVertsSansCode = { refuses: [], ignores: [] };
  if (!added.length || !code.length) return empty;
  const max = o.max ?? MAX_TESTS_SANS_CODE;
  const played = added.slice(0, max);
  const tree = join(mkdtempSync(join(tmpdir(), 'cadence-sans-code-')), 'tree');
  try {
    git(o.dir, ['worktree', 'add', '--detach', tree, 'HEAD']);
    for (const c of others) {
      if (c.status === 'A') rmSync(join(tree, c.file), { force: true });
      else git(tree, ['checkout', o.start, '--', c.file]);
    }
    // Les dépendances du lot : le worktree d'essai n'a que les fichiers suivis.
    for (const dep of o.deps ?? ['node_modules']) {
      if (!existsSync(join(o.dir, dep)) || existsSync(join(tree, dep))) continue;
      mkdirSync(dirname(join(tree, dep)), { recursive: true });
      symlinkSync(join(o.dir, dep), join(tree, dep), 'dir');
    }
    const refuses: string[] = [];
    for (const f of played) if ((await o.run(withFiles(o.replay, [f]), tree)).code === 0) refuses.push(f);
    return { refuses, ignores: added.slice(max) };
  } finally {
    tryGit(o.dir, ['worktree', 'remove', '--force', tree]);
    rmSync(join(tree, '..'), { recursive: true, force: true });
    tryGit(o.dir, ['worktree', 'prune']);
  }
}
