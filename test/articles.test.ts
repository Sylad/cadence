import { describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { readDocsConfig } from '../src/config.js';
import { articleHeadings, articleSections, openArticleLots } from '../src/articles.js';
import { deliver, parseDeliverConfig, type DeliverDeps } from '../src/deliver.js';
import { headSha } from '../src/git.js';
import { Plan } from '../src/plan.js';
import { sharedStateDir as stateDir } from '../src/state.js';
import { commit, gitRepo, tempDir } from './helpers.js';

const git = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, stdio: 'ignore' });
const write = (dir: string, file: string, text: string) => {
  mkdirSync(dirname(join(dir, file)), { recursive: true });
  writeFileSync(join(dir, file), text);
};
const read = (text: string) => {
  const f = join(tempDir(), 'cadence.yaml');
  writeFileSync(f, text);
  return readDocsConfig(f);
};

const ARTICLE = `---
title: Étude de cas
---
# Étude de cas demo

## Les alertes météo
Texte.

## Architecture
Texte.

### Le cache des tuiles
Texte.

## Chiffres
Texte.
`;

describe('docs.articles : lecture de la clé', () => {
  it('lit le dépôt voisin, le fichier et le nom éventuel', () => {
    expect(read('docs:\n  articles:\n    - { repo: ../claude-code-codex, file: src/cas/demo.md }\n').articles).toEqual([
      { repo: '../claude-code-codex', file: 'src/cas/demo.md' },
    ]);
    expect(read('docs:\n  articles: [{ repo: ../x, file: a.md, name: Demo }]\n').articles).toEqual([{ repo: '../x', file: 'a.md', name: 'Demo' }]);
  });
  it('absente : pas de clé articles', () => {
    expect(read('docs: { sync: [] }\n')).toEqual({ sync: [] });
  });
  it('refuse une forme fausse, en nommant la clé', () => {
    expect(() => read('docs: { articles: 3 }\n')).toThrow(/docs\.articles doit être une liste/);
    expect(() => read('docs: { articles: [{ file: a.md }] }\n')).toThrow(/docs\.articles\[0\]\.repo/);
    expect(() => read('docs: { articles: [{ repo: ../x }] }\n')).toThrow(/docs\.articles\[0\]\.file/);
    expect(() => read('docs: { articles: [{ repo: ../x, file: a.md, autre: 1 }] }\n')).toThrow(/docs\.articles\[0\]\.autre inconnu/);
  });
});

describe('articleHeadings / articleSections', () => {
  it('lit les titres Markdown (sans l\'en-tête) et les <h2> d\'une page Astro', () => {
    expect(articleHeadings(ARTICLE).map((h) => h.text)).toEqual(['Étude de cas demo', 'Les alertes météo', 'Architecture', 'Le cache des tuiles', 'Chiffres']);
    expect(articleHeadings('<h2 class="x">Les <em>alertes</em></h2>\n<h3>Détail</h3>').map((h) => h.text)).toEqual(['Les alertes', 'Détail']);
  });
  it('retient les sections qui partagent un mot avec les titres livrés', () => {
    expect(articleSections(ARTICLE, ['Alertes météo plus claires', 'Cache des tuiles'])).toEqual(['Les alertes météo', 'Le cache des tuiles']);
  });
  it('sans recoupement : les sections de premier niveau, toutes', () => {
    expect(articleSections(ARTICLE, ['Zzzzzz yyyyyy'])).toEqual(['Les alertes météo', 'Architecture', 'Chiffres']);
  });
});

/** Projet « demo » + dépôt voisin portant l'article ; L1 et L2 terminés avec un titre public, L3 sans. */
function project(rules = [{ repo: '../codex', file: 'src/cas/demo.md' }]) {
  const parent = tempDir();
  const dir = join(parent, 'demo');
  mkdirSync(dir);
  git(dir, 'init', '-q', '-b', 'main');
  const plan = Plan.create(join(dir, 'docs/plan/raf.yaml'), 'demo', 'L', '2026-10-01');
  plan.add('Alertes', '2026-10-01', { public: 'Alertes météo plus claires' });
  plan.add('Cache interne', '2026-10-01', { public: 'Cache des tuiles' });
  plan.add('Refactor', '2026-10-01');
  for (const id of ['L1', 'L2', 'L3']) plan.setStatus(id, 'done', '2026-10-09');
  plan.save();
  write(parent, 'codex/src/cas/demo.md', ARTICLE);
  return { parent, dir, rules };
}

describe('openArticleLots', () => {
  it('ouvre un lot « Article demo à rafraîchir » avec titres, article et sections en note, dépôt voisin déclaré', () => {
    const { dir, rules } = project();
    const plan = Plan.load(join(dir, 'docs/plan/raf.yaml'));
    const r = openArticleLots({ plan, root: dir, rules, delivered: plan.lots(), publicTitle: (l) => l.public, sha: 'abcdef0123', today: '2026-10-09' });
    expect(r.opened).toEqual(['L4']);
    plan.save();
    const lot = Plan.load(join(dir, 'docs/plan/raf.yaml')).lot('L4');
    expect(lot.title).toBe('Article demo à rafraîchir');
    expect(lot.status).toBe('todo');
    expect(lot.visible).toBe(false);
    expect(lot.repos).toEqual([{ path: '../codex', cite: 'demo' }]);
    const note = lot.notes[0].text;
    expect(note).toContain('abcdef0');
    expect(note).toContain('« Alertes météo plus claires »');
    expect(note).toContain('« Cache des tuiles »');
    expect(note).not.toContain('Refactor');
    expect(note).toContain('../codex/src/cas/demo.md');
    expect(note).toContain('Les alertes météo ; Le cache des tuiles');
  });

  it('sans titre public livré : rien à ouvrir', () => {
    const { dir, rules } = project();
    const plan = Plan.load(join(dir, 'docs/plan/raf.yaml'));
    expect(openArticleLots({ plan, root: dir, rules, delivered: [plan.lot('L3')], publicTitle: (l) => l.public, sha: 'abcdef0', today: '2026-10-09' }).opened).toEqual([]);
  });

  it('un lot de ce titre encore ouvert reçoit une note au lieu d\'un doublon', () => {
    const { dir, rules } = project();
    const plan = Plan.load(join(dir, 'docs/plan/raf.yaml'));
    const args = { plan, root: dir, rules, publicTitle: (l: { public?: string }) => l.public, sha: 'abcdef0', today: '2026-10-09' };
    openArticleLots({ ...args, delivered: [plan.lot('L1')] });
    const r = openArticleLots({ ...args, delivered: [plan.lot('L2')] });
    expect(r.opened).toEqual([]);
    expect(r.noted).toEqual(['L4']);
    expect(plan.lot('L4').notes).toHaveLength(2);
    expect(plan.lots().filter((l) => l.title === 'Article demo à rafraîchir')).toHaveLength(1);
  });

  it('le nom déclaré remplace le projet ; un fichier introuvable ouvre quand même le lot, avec le constat', () => {
    const { dir } = project();
    const plan = Plan.load(join(dir, 'docs/plan/raf.yaml'));
    const r = openArticleLots({
      plan, root: dir, rules: [{ repo: '../codex', file: 'absent.md', name: 'Demo Pro' }], delivered: [plan.lot('L1')], publicTitle: (l) => l.public, sha: 'abcdef0', today: '2026-10-09',
    });
    expect(plan.lot(r.opened[0]).title).toBe('Article Demo Pro à rafraîchir');
    expect(plan.lot(r.opened[0]).notes[0].text).toContain('introuvable');
  });

  it('plan en lecture seule : aucune écriture, la consigne est rendue', () => {
    const { dir, rules } = project();
    const plan = Plan.load(join(dir, 'docs/plan/raf.yaml'), {
      format: { lots: 'lots', fields: {}, statuses: { done: 'done', todo: 'todo' }, estimates: {} },
    });
    const r = openArticleLots({ plan, root: dir, rules, delivered: [plan.lot('L1')], publicTitle: (l) => l.public, sha: 'abcdef0', today: '2026-10-09' });
    expect(r.opened).toEqual([]);
    expect(r.manual.join('\n')).toContain('Article demo à rafraîchir');
    expect(r.manual.join('\n')).toContain('Alertes météo plus claires');
  });
});

function fakeDeps(): DeliverDeps {
  let clock = 0;
  return {
    exec: (cmd) => (cmd === 'false' ? 1 : 0),
    gh: () => [{ name: 'ci', status: 'completed', conclusion: 'success' }],
    ghReady: () => null,
    fetch: async () => ({ status: 200, text: 'ok' }),
    sleep: async (ms) => { clock += ms; },
    now: () => clock,
  };
}

describe('deliver : articles à rafraîchir', () => {
  const CONFIG = parseDeliverConfig('deliver:\n  ci: none\n  verify:\n    - command: "true"\n', 'cadence.yaml');

  /** Dépôt poussé, livré une fois (point de départ), puis un commit qui cite L1 et L3. */
  async function delivered(articles: { repo: string; file: string }[] | undefined, over: Record<string, unknown> = {}) {
    const { dir } = project();
    const origin = tempDir();
    git(origin, 'init', '-q', '--bare', '-b', 'main');
    git(dir, 'config', 'user.email', 't@e.x');
    git(dir, 'config', 'user.name', 'T');
    git(dir, 'config', 'commit.gpgsign', 'false');
    git(dir, 'add', '.');
    commit(dir, 'chore: plan');
    git(dir, 'remote', 'add', 'origin', origin);
    git(dir, 'push', '-q', '-u', 'origin', 'main');
    const out: string[] = [];
    const err: string[] = [];
    const base = { root: dir, state: stateDir(dir), plan: Plan.load(join(dir, 'docs/plan/raf.yaml')), config: CONFIG, today: '2026-10-09', dryRun: false, args: [] as string[], out: (l: string) => out.push(l), err: (l: string) => err.push(l), articles, publicTitle: (l: { public?: string }) => l.public };
    expect(await deliver(base, fakeDeps())).toBe(0);
    write(dir, 'src/a.ts', 'x');
    git(dir, 'add', '--', 'src/a.ts');
    commit(dir, 'feat(L1): alertes\n\nL3 aussi');
    git(dir, 'push', '-q');
    out.length = 0;
    const code = await deliver({ ...base, plan: Plan.load(join(dir, 'docs/plan/raf.yaml')), ...over }, fakeDeps());
    return { dir, code, out: out.join('\n'), err: err.join('\n') };
  }

  it('après une livraison verte, ouvre le lot de l\'article et le dit', async () => {
    const { dir, code, out } = await delivered([{ repo: '../codex', file: 'src/cas/demo.md' }]);
    expect(code).toBe(0);
    expect(out).toContain('livré : L1');
    expect(out).toContain('article à rafraîchir : L4 « Article demo à rafraîchir »');
    const lot = Plan.load(join(dir, 'docs/plan/raf.yaml')).lot('L4');
    expect(lot.notes[0].text).toContain('« Alertes météo plus claires »');
    expect(lot.notes[0].text).not.toContain('Refactor');
  });

  it('sans docs.articles, ne touche pas au plan', async () => {
    const { dir, out } = await delivered(undefined);
    expect(out).not.toContain('article');
    expect(Plan.load(join(dir, 'docs/plan/raf.yaml')).lots()).toHaveLength(3);
  });

  it('une livraison rouge n\'ouvre rien', async () => {
    const { dir, code } = await delivered([{ repo: '../codex', file: 'src/cas/demo.md' }], {
      config: parseDeliverConfig('deliver:\n  ci: none\n  verify:\n    - command: "false"\n  verifyTimeout: 1\n', 'cadence.yaml'),
    });
    expect(code).toBe(1);
    expect(Plan.load(join(dir, 'docs/plan/raf.yaml')).lots()).toHaveLength(3);
  });

  it('simulation : annonce, n\'écrit rien', async () => {
    const { dir, out } = await delivered([{ repo: '../codex', file: 'src/cas/demo.md' }], { dryRun: true });
    expect(out).toContain('Articles rafraîchis après une livraison verte');
    expect(out).toContain('../codex/src/cas/demo.md');
    expect(Plan.load(join(dir, 'docs/plan/raf.yaml')).lots()).toHaveLength(3);
    expect(headSha(dir)).toBeTruthy();
  });
});
