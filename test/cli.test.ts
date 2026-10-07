import { describe, expect, it } from 'vitest';
import { existsSync, mkdirSync, readFileSync, writeFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { ensureGitignore, run } from '../src/cli.js';
import { commit, gitRepo, tempDir } from './helpers.js';
import { projectEnv } from '../src/orchestrate/command.js';

function raf(dir: string, ...argv: string[]) {
  const out: string[] = [];
  const err: string[] = [];
  const code = run(argv, {
    cwd: dir,
    env: { RAF_TODAY: '2026-09-28' },
    out: (l) => out.push(l),
    err: (l) => err.push(l),
    now: () => new Date('2026-09-28T09:30:00'),
  });
  return { code, out: out.join('\n'), err: err.join('\n') };
}

describe('raf public', () => {
  it('add --public pose le titre public ; raf public le change et --clear l\'efface', () => {
    const dir = gitRepo();
    raf(dir, 'init', '--project', 'demo');
    expect(raf(dir, 'add', 'Titre', 'technique', '--visible', '--public', 'Une nouveauté').out).toBe('L1');
    expect(readFileSync(join(dir, 'docs/plan/raf.yaml'), 'utf8')).toContain('public: Une nouveauté');
    expect(raf(dir, 'public', 'L1', 'Autre', 'titre').code).toBe(0);
    expect(readFileSync(join(dir, 'docs/plan/raf.yaml'), 'utf8')).toContain('public: Autre titre');
    expect(raf(dir, 'public', 'L1', '--clear').code).toBe(0);
    expect(readFileSync(join(dir, 'docs/plan/raf.yaml'), 'utf8')).not.toContain('public:');
  });

  it('raf public refuse sans titre ni --clear, et un lot inconnu', () => {
    const dir = gitRepo();
    raf(dir, 'init', '--project', 'demo');
    raf(dir, 'add', 'A');
    expect(raf(dir, 'public', 'L1').code).not.toBe(0);
    expect(raf(dir, 'public', 'L9', 'x').code).not.toBe(0);
    expect(raf(dir, 'add', 'B', '--parent', 'L1', '--public', 'x').code).not.toBe(0);
  });
});

describe('raf public --clear', () => {
  it('refuse --clear accompagné d\'un titre sans toucher au titre public existant', () => {
    const dir = gitRepo();
    raf(dir, 'init', '--project', 'demo');
    raf(dir, 'add', 'A', '--public', 'Existant');
    const avant = readFileSync(join(dir, 'docs/plan/raf.yaml'), 'utf8');
    const r = raf(dir, 'public', 'L1', 'Titre', '--clear');
    expect(r.code).not.toBe(0);
    expect(r.err).toContain('--clear');
    expect(readFileSync(join(dir, 'docs/plan/raf.yaml'), 'utf8')).toBe(avant);
  });
});

describe('raf init : .gitignore', () => {
  it('init crée le .gitignore avec .playwright-mcp/ et sort en 0', () => {
    const dir = gitRepo();
    expect(raf(dir, 'init', '--no-hook').code).toBe(0);
    expect(readFileSync(join(dir, '.gitignore'), 'utf8')).toBe('.playwright-mcp/\n');
  });

  it('ensureGitignore : ajoute sans perdre le contenu, sans doublon, quelle que soit la variante déjà posée', () => {
    const cas: Array<[string, string | null, string, boolean]> = [
      ['fichier absent', null, '.playwright-mcp/\n', true],
      ['sans retour final', 'node_modules', 'node_modules\n.playwright-mcp/\n', true],
      ['avec retour final', 'node_modules\n', 'node_modules\n.playwright-mcp/\n', true],
      ['.playwright-mcp', '.playwright-mcp', '.playwright-mcp', false],
      ['/.playwright-mcp', '/.playwright-mcp\n', '/.playwright-mcp\n', false],
      ['.playwright-mcp/', '.playwright-mcp/\n', '.playwright-mcp/\n', false],
      ['variante sans retour final', 'a\n/.playwright-mcp', 'a\n/.playwright-mcp', false],
    ];
    for (const [nom, avant, apres, ecrit] of cas) {
      const dir = gitRepo();
      if (avant !== null) writeFileSync(join(dir, '.gitignore'), avant);
      expect(ensureGitignore(dir, '.playwright-mcp/'), nom).toBe(ecrit);
      expect(readFileSync(join(dir, '.gitignore'), 'utf8'), nom).toBe(apres);
      expect(ensureGitignore(dir, '.playwright-mcp/'), `${nom} (2e appel)`).toBe(false);
      expect(readFileSync(join(dir, '.gitignore'), 'utf8'), `${nom} (2e appel)`).toBe(apres);
    }
  });
});

describe('raf CLI', () => {
  it('runs a full lot lifecycle', () => {
    const dir = gitRepo();
    expect(raf(dir, 'init', '--project', 'demo').code).toBe(0);
    expect(existsSync(join(dir, 'docs/plan/raf.yaml'))).toBe(true);
    expect(raf(dir, 'add', 'Cache', 'des', 'prêts', '--estimate', '2').out).toBe('L1');
    expect(raf(dir, 'add', 'Petit', 'correctif', '--quickwin').out).toBe('L2');
    expect(raf(dir, 'add', 'Après', 'le', 'cache', '--after', 'L1').out).toBe('L3');
    expect(raf(dir, 'add', 'sous-tâche', '--parent', 'L1').out).toBe('L1/t1');
    expect(raf(dir, 'start', 'L1').code).toBe(0);
    commit(dir, 'feat(L1): cache', '2026-09-28T10:00:00');

    const now = raf(dir, 'now').out;
    expect(now).toMatch(/En cours\n {2}L1 {2}Cache des prêts {2}\(2 j, 1 commit\(s\), sous-tâches 0\/1\)/);
    expect(now.indexOf('⚡ L2')).toBeLessThan(now.indexOf('en attente'));
    expect(now).toContain('en attente de dépendances : L3');

    expect(raf(dir, 'done', 'L1').code).toBe(2);
    raf(dir, 'done', 'L1/t1');
    expect(raf(dir, 'done', 'L1').code).toBe(0);
    raf(dir, 'drop', 'L2', '--reason', 'plus utile');
    raf(dir, 'note', 'L3', 'à', 'découper');
    const yaml = readFileSync(join(dir, 'docs/plan/raf.yaml'), 'utf8');
    expect(yaml).toContain('text: "abandonné : plus utile"');
    expect(yaml).toContain('text: à découper');
    expect(raf(dir, 'list', '--status', 'todo').out).toMatch(/^L3 +todo +Après le cache$/);
  });

  it('check exits 1 on drift and 0 when clean', () => {
    const dir = gitRepo();
    raf(dir, 'init', '--no-hook');
    raf(dir, 'add', 'A');
    commit(dir, 'feat(L1): a');
    expect(raf(dir, 'check').code).toBe(1);
    raf(dir, 'start', 'L1');
    const ok = raf(dir, 'check');
    expect(ok.out).toContain('cohérents');
    expect(ok.code).toBe(0);
  });

  it('reports usage errors with code 2', () => {
    const dir = gitRepo();
    expect(raf(dir, 'now').err).toMatch(/raf init/);
    raf(dir, 'init', '--no-hook');
    expect(raf(dir, 'add', 'x', '--estimate', 'abc').code).toBe(2);
    expect(raf(dir, 'frobnicate').err).toMatch(/commande inconnue/);
  });

  it('post-commit only talks, never writes', () => {
    const dir = gitRepo();
    raf(dir, 'init', '--no-hook');
    raf(dir, 'add', 'A');
    const before = readFileSync(join(dir, 'docs/plan/raf.yaml'), 'utf8');
    commit(dir, 'feat(L1): a');
    expect(raf(dir, 'hook', 'post-commit').err).toContain('L1 est encore todo');
    commit(dir, 'wip');
    expect(raf(dir, 'hook', 'post-commit').err).toContain('commit sans lot');
    expect(readFileSync(join(dir, 'docs/plan/raf.yaml'), 'utf8')).toBe(before);
  });

  it('(L15/t2) post-commit : seule la portée décide des lots annoncés, pas les mentions en passage', () => {
    const dir = gitRepo();
    raf(dir, 'init', '--no-hook');
    for (let i = 0; i < 30; i++) raf(dir, 'add', `lot ${i + 1}`);
    raf(dir, 'start', 'L24');
    commit(dir, 'chore(L24): lot terminé — (L27) et (L28–L30) planifiés — voir L99');
    const { err } = raf(dir, 'hook', 'post-commit');
    expect(err).toContain('L24 (doing)');
    for (const id of ['L27', 'L28', 'L30', 'L99']) expect(err).not.toContain(id);
  });

  it('hook install keeps an existing hook and is idempotent', () => {
    const dir = gitRepo();
    const hook = join(dir, '.git/hooks/post-commit');
    writeFileSync(hook, '#!/bin/sh\necho existing\n');
    raf(dir, 'hook', 'install');
    expect(raf(dir, 'hook', 'install').out).toContain('déjà présent');
    const text = readFileSync(hook, 'utf8');
    expect(text.startsWith('#!/bin/sh\necho existing\n# >>> raf')).toBe(true);
    expect(text.match(/>>> raf/g)).toHaveLength(1);
    expect(statSync(hook).mode & 0o111).not.toBe(0);
  });

  it('gantt writes a self-contained page with escaped data', () => {
    const dir = gitRepo();
    raf(dir, 'init', '--no-hook', '--project', 'demo');
    raf(dir, 'add', '</script><img src=x onerror=alert(1)>');
    const path = raf(dir, 'gantt').out;
    const html = readFileSync(path, 'utf8');
    expect(path).toBe(join(dir, 'docs/plan/gantt.html'));
    expect(html).not.toMatch(/<script[^>]+src=|<link[^>]+href=|https?:\/\/(?!www\.w3\.org)/);
    expect(html.match(/<\/script>/g)).toHaveLength(2);
    const json = /<script type="application\/json" id="raf-data">(.*?)<\/script>/s.exec(html)![1];
    const data = JSON.parse(json);
    expect(data.bars[0]).toMatchObject({ id: 'L1', start: '2026-09-28', end: '2026-09-28', projected: true });
    expect(data.generated).toBe('2026-09-28 09:30');
  });
});

describe('adoption date', () => {
  it('check ignores commits made before raf init', () => {
    const dir = gitRepo();
    commit(dir, 'feat: ancien travail', '2026-09-20T10:00:00');
    raf(dir, 'init', '--no-hook');
    expect(readFileSync(join(dir, 'docs/plan/raf.yaml'), 'utf8')).toContain('since: 2026-09-28');
    expect(raf(dir, 'check').code).toBe(0);
    commit(dir, 'feat: nouveau travail sans lot', '2026-09-28T08:00:00');
    expect(raf(dir, 'check').out).toContain('commit sans lot');
  });
});

describe('plan-only commits', () => {
  it('do not need to cite a lot', () => {
    const dir = gitRepo();
    raf(dir, 'init', '--no-hook');
    raf(dir, 'add', 'A');
    execFileSync('git', ['add', 'docs/plan/raf.yaml'], { cwd: dir });
    commit(dir, 'chore: plan raf');
    expect(raf(dir, 'check').code).toBe(0);
    expect(raf(dir, 'hook', 'post-commit').err).toBe('');
    writeFileSync(join(dir, 'x.txt'), 'x');
    execFileSync('git', ['add', 'x.txt'], { cwd: dir });
    commit(dir, 'chore: autre chose');
    expect(raf(dir, 'check').out).toContain('commit sans lot : ');
  });
});

describe('(L94) --config hors du dépôt, qa.expectations absolu dans le dépôt', () => {
  it('raf check accepte le chemin absolu, lu depuis la racine du dépôt de travail, et le fichier est tenu avec le plan', () => {
    const dir = gitRepo();
    raf(dir, 'init', '--no-hook');
    raf(dir, 'add', 'A');
    execFileSync('git', ['add', 'docs/plan/raf.yaml'], { cwd: dir });
    commit(dir, 'chore: plan raf');
    mkdirSync(join(dir, 'docs/quality'), { recursive: true });
    writeFileSync(join(dir, 'docs/quality/pages.md'), 'attendus\n');
    execFileSync('git', ['add', 'docs/quality/pages.md'], { cwd: dir });
    commit(dir, 'docs(qa): attendus');
    const outside = tempDir();
    const config = join(outside, 'cadence.yaml');
    writeFileSync(config, `qa:\n  expectations: ${join(dir, 'docs/quality/pages.md')}\n`);
    const r = raf(dir, 'check', '--config', config);
    expect(r.err).toBe('');
    expect(r.code).toBe(0);
    expect(r.out).not.toContain('commit sans lot');
    // sans la config, le même fichier est un fichier comme un autre : le commit est sans lot
    expect(raf(dir, 'check').out).toContain('commit sans lot');
  });

  it('un chemin absolu hors du dépôt de travail reste refusé', () => {
    const dir = gitRepo();
    raf(dir, 'init', '--no-hook');
    const outside = tempDir();
    const config = join(outside, 'cadence.yaml');
    writeFileSync(config, `qa:\n  expectations: ${join(outside, 'pages.md')}\n`);
    const r = raf(dir, 'check', '--config', config);
    expect(r.code).not.toBe(0);
    expect(r.err).toContain('hors du dépôt');
  });

  it('projectEnv (orchestrate) passe la racine du projet : qa.expectations absolu dans le dépôt est accepté', () => {
    const dir = gitRepo();
    raf(dir, 'init', '--no-hook');
    writeFileSync(join(dir, 'cadence.yaml'), `qa:\n  expectations: ${join(dir, 'docs/quality/pages.md')}\n`);
    const env = projectEnv(dir);
    expect(env.loadPlan().qaExpectations).toBe('docs/quality/pages.md');
  });
});
