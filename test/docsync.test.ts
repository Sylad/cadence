import { describe, expect, it } from 'vitest';
import { mkdirSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { run } from '../src/cli.js';
import { readDocsConfig } from '../src/config.js';
import { docSyncMatcher } from '../src/docsync.js';
import { renderBrief } from '../src/orchestrate/briefs.js';
import { commit, gitRepo, tempDir } from './helpers.js';

async function cad(dir: string, ...argv: string[]) {
  const out: string[] = [];
  const err: string[] = [];
  const code = await run(argv, { cwd: dir, env: { RAF_TODAY: '2026-10-09' }, out: (l) => out.push(l), err: (l) => err.push(l), now: () => new Date('2026-10-09T18:30:00') });
  return { code, out: out.join('\n'), err: err.join('\n') };
}

const git = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, stdio: 'ignore' });
const write = (dir: string, file: string, text = 'x') => {
  mkdirSync(dirname(join(dir, file)), { recursive: true });
  writeFileSync(join(dir, file), text);
};
/** Un commit réel : les fichiers écrits, indexés par chemin explicite, sujet donné. */
function work(dir: string, subject: string, files: string[], date = '2026-10-09T10:00:00') {
  for (const f of files) write(dir, f, `${subject}\n${Math.random()}`);
  git(dir, 'add', '--', ...files);
  commit(dir, subject, date);
}

const CONFIG = `docs:
  sync:
    - paths: [src/**, bin/*.js]
      docs: [README.md, docs/usage.md]
    - paths: [templates/]
      docs: [CLAUDE.md]
`;

/** Un dépôt avec un lot L1 en cours et la règle docs.sync déclarée. */
async function repo(config = CONFIG) {
  const dir = gitRepo();
  await cad(dir, 'init', '--project', 'demo', '--no-hook');
  await cad(dir, 'add', 'Un lot');
  await cad(dir, 'start', 'L1');
  write(dir, 'cadence.yaml', config);
  git(dir, 'add', '--', 'docs', 'cadence.yaml');
  commit(dir, 'chore(L1): départ', '2026-10-09T08:00:00');
  return dir;
}

describe('docs.sync : lecture de la clé', () => {
  const read = (text: string) => {
    const f = join(tempDir(), 'cadence.yaml');
    writeFileSync(f, text);
    return readDocsConfig(f);
  };

  it('lit les paires chemins → documents, et la date since', () => {
    expect(read(CONFIG).sync).toEqual([
      { paths: ['src/**', 'bin/*.js'], docs: ['README.md', 'docs/usage.md'] },
      { paths: ['templates/'], docs: ['CLAUDE.md'] },
    ]);
    expect(read(`docs:\n  since: 2026-10-01\n  sync: [{ paths: src/**, docs: README.md }]\n`)).toEqual({ since: '2026-10-01', sync: [{ paths: ['src/**'], docs: ['README.md'] }] });
  });

  it('absente : aucune règle ; fichier absent : aucune règle', () => {
    expect(read('qa: {}\n')).toEqual({ sync: [] });
    expect(readDocsConfig(join(tempDir(), 'rien.yaml'))).toEqual({ sync: [] });
  });

  it('refuse une forme fausse, en nommant la clé', () => {
    expect(() => read('docs: 3\n')).toThrow(/docs doit être un objet/);
    expect(() => read('docs: { autre: 1 }\n')).toThrow(/docs\.autre inconnu/);
    expect(() => read('docs: { sync: 3 }\n')).toThrow(/docs\.sync doit être une liste/);
    expect(() => read('docs: { sync: [{ paths: [a] }] }\n')).toThrow(/docs\.sync\[0\]\.docs/);
    expect(() => read('docs: { sync: [{ docs: [a] }] }\n')).toThrow(/docs\.sync\[0\]\.paths/);
    expect(() => read('docs: { sync: [{ paths: [a], docs: [b], x: 1 }] }\n')).toThrow(/docs\.sync\[0\]\.x inconnu/);
    expect(() => read('docs: { sync: [{ paths: [""], docs: [b] }] }\n')).toThrow(/docs\.sync\[0\]\.paths/);
    expect(() => read('docs: { since: hier }\n')).toThrow(/docs\.since/);
  });
});

describe('docs.sync : motifs de chemins', () => {
  const m = (p: string, f: string) => docSyncMatcher(p)(f);
  it('* reste dans un dossier, ** le traverse, / final prend tout le dossier, chemin exact sinon', () => {
    expect(m('src/**', 'src/a/b.ts')).toBe(true);
    expect(m('src/*.ts', 'src/a/b.ts')).toBe(false);
    expect(m('src/*.ts', 'src/b.ts')).toBe(true);
    expect(m('templates/', 'templates/orchestrate/x.md')).toBe(true);
    expect(m('templates/', 'templatesX/x.md')).toBe(false);
    expect(m('README.md', 'README.md')).toBe(true);
    expect(m('README.md', 'docs/README.md')).toBe(false);
    expect(m('a.b', 'aXb')).toBe(false); // le point n'est pas un joker
  });
});

describe('docs.sync : exclusions', () => {
  it('un motif « !… » écarte les fichiers qu\'il désigne (tests), sans rien déclencher seul', async () => {
    const dir = await repo(`docs:\n  sync:\n    - paths: [src/**, '!**/*.test.ts']\n      docs: [README.md]\n`);
    work(dir, 'feat(L1): test seul', ['src/a.test.ts', 'src/deep/b.test.ts']);
    expect((await cad(dir, 'check')).out).not.toContain('documentation en retard');
    work(dir, 'feat(L1): code', ['src/a.ts']);
    const { out } = await cad(dir, 'check');
    expect(out).toContain('src/a.ts sans toucher README.md');
    expect(out).not.toContain('a.test.ts');
  });
});

describe('raf check : docs.sync', () => {
  it('signale un lot dont les commits touchent les chemins sans toucher le document, avec la liste calculée', async () => {
    const dir = await repo();
    work(dir, 'feat(L1): code', ['src/a.ts', 'src/b.ts']);
    const { code, out } = await cad(dir, 'check');
    expect(code).toBe(1);
    expect(out).toMatch(/✗ L1 : documentation en retard — src\/a\.ts, src\/b\.ts sans toucher README\.md ou docs\/usage\.md \(docs\.sync\)/);
  });

  it('un document touché par un commit du lot, même plus tard ou à part, lève le constat', async () => {
    const dir = await repo();
    work(dir, 'feat(L1): code', ['src/a.ts']);
    work(dir, 'docs(L1): readme', ['README.md']);
    const { code, out } = await cad(dir, 'check');
    expect(out).not.toContain('documentation en retard');
    expect(code).toBe(0);
  });

  it('une règle par paire : le document de l\'une ne couvre pas l\'autre', async () => {
    const dir = await repo();
    work(dir, 'feat(L1): code', ['src/a.ts', 'templates/x.md', 'README.md']);
    const { out } = await cad(dir, 'check');
    expect(out).toContain('templates/x.md sans toucher CLAUDE.md');
    expect(out).not.toContain('sans toucher README.md');
  });

  it('un commit sans les chemins ne déclenche rien ; sans clé docs.sync, rien non plus', async () => {
    const dir = await repo();
    work(dir, 'feat(L1): autre', ['scripts/x.sh']);
    expect((await cad(dir, 'check')).out).not.toContain('documentation en retard');
    const nu = await repo('qa: {}\n');
    work(nu, 'feat(L1): code', ['src/a.ts']);
    expect((await cad(nu, 'check')).out).not.toContain('documentation en retard');
  });

  it('le « What\'s new » écrit dans le commit de version ne compte pas comme documentation', async () => {
    const dir = await repo();
    work(dir, 'chore: readme', ['README.md']);
    write(dir, 'README.md', "# x\n\n## What's new\n\n- 1.0\n\n## Usage\n\nu\n");
    git(dir, 'add', '--', 'README.md');
    commit(dir, 'chore: readme neuf', '2026-10-09T09:00:00');
    work(dir, 'feat(L1): code', ['src/a.ts']);
    write(dir, 'README.md', "# x\n\n## What's new\n\n- 1.1\n\n## Usage\n\nu\n");
    write(dir, 'CHANGELOG.md', '## 1.1\n');
    git(dir, 'add', '--', 'README.md', 'CHANGELOG.md');
    commit(dir, 'chore(L1): version 1.1', '2026-10-09T11:00:00');
    const { out } = await cad(dir, 'check');
    expect(out).toContain('L1 : documentation en retard');
  });

  it('un lot terminé n\'est audité que depuis docs.since', async () => {
    const dir = await repo(`${CONFIG}  since: 2026-10-10\n`);
    work(dir, 'feat(L1): code', ['src/a.ts']);
    await cad(dir, 'done', 'L1');
    expect((await cad(dir, 'check')).out).not.toContain('documentation en retard');
    const avant = await repo(`${CONFIG}  since: 2026-10-01\n`);
    work(avant, 'feat(L1): code', ['src/a.ts']);
    await cad(avant, 'done', 'L1');
    expect((await cad(avant, 'check')).out).toContain('L1 : documentation en retard');
  });

  it('un lot terminé le jour même de docs.since est audité', async () => {
    const dir = await repo(`${CONFIG}  since: 2026-10-09\n`);
    work(dir, 'feat(L1): code', ['src/a.ts']);
    await cad(dir, 'done', 'L1');
    expect((await cad(dir, 'check')).out).toContain('L1 : documentation en retard');
  });
});

describe('cadence lead tour : docs.sync', () => {
  it('affiche le lot en retard de documentation dans la dérive du projet', async () => {
    const root = tempDir();
    const dir = join(root, 'alpha');
    mkdirSync(dir);
    for (const a of [['init', '-q', '-b', 'main'], ['config', 'user.email', 't@e.x'], ['config', 'user.name', 'T'], ['config', 'commit.gpgsign', 'false']]) git(dir, ...a);
    await cad(dir, 'init', '--project', 'alpha', '--no-hook');
    await cad(dir, 'add', 'Un lot');
    await cad(dir, 'start', 'L1');
    write(dir, 'cadence.yaml', CONFIG);
    git(dir, 'add', '--', 'docs', 'cadence.yaml');
    commit(dir, 'chore(L1): départ', '2026-10-09T08:00:00');
    work(dir, 'feat(L1): code', ['src/a.ts']);
    const { out } = await cad(root, 'lead', 'tour');
    expect(out).toContain('documentation en retard');
    expect(out).toMatch(/dérive 1 \(✗ L1 : documentation en retard/);
  });
});

describe('brief de revue : docs.sync', () => {
  const vars = { chemin: '/r/p', lot: 'L9', titre: 'T', objectif: 'x', commits: '', reponse: '', constats: '', ux: '', choix: '', checks: '', news: '', captures: '' };
  it('review et review-small portent la consigne calculée en constat majeur ; vide sans règle', () => {
    for (const kind of ['review', 'review-small'] as const) {
      expect(renderBrief(kind, { ...vars, docs: 'DOCS-CALCULÉ' }), kind).toContain('DOCS-CALCULÉ');
      expect(renderBrief(kind, vars), kind).not.toContain('docs.sync');
    }
  });
});
