import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { run } from '../src/cli.js';
import { sealAcceptation } from '../src/orchestrate/accept.js';
import { git } from './orchestrate-harness.js';
import { ecritAcceptation } from './accept-helpers.js';
import { gitRepo, tempDir } from './helpers.js';

// Sonde L526 (issue #20) : les bords de `cadence spec green` sur un lot vert: true sans empreintes.

const fileHome = process.env.CADENCE_HOME;
beforeEach(() => {
  process.env.CADENCE_HOME = tempDir();
});
afterEach(() => {
  process.env.CADENCE_HOME = fileHome;
});

const commitPaths = (repo: string, message: string, ...paths: string[]) => {
  git(repo, 'add', '--', ...paths);
  git(repo, 'commit', '-q', '-m', message, '--', ...paths);
};

function cli(repo: string, ...argv: string[]) {
  const out: string[] = [];
  const err: string[] = [];
  const code = run(argv, { cwd: repo, env: { RAF_TODAY: '2026-11-02' }, out: (l) => out.push(l), err: (l) => err.push(l), now: () => new Date('2026-11-02T10:00:00') });
  return { code, out: out.join('\n'), err: err.join('\n') };
}

const lire = (repo: string, json: string) => JSON.parse(readFileSync(join(repo, json), 'utf8'));
const ecrire = (repo: string, json: string, doc: unknown) => writeFileSync(join(repo, json), `${JSON.stringify(doc, null, 2)}\n`);

function depot(o: { vert?: boolean; extra?: string[]; yaml?: string; mute?: (repo: string, json: string, test: string) => void } = {}) {
  const repo = gitRepo();
  const a = ecritAcceptation(repo, { vert: o.vert ?? true, ...(o.extra ? { extra: o.extra } : {}) });
  if (o.mute) {
    o.mute(repo, a.json, a.test);
    commitPaths(repo, 'test(L1): acceptation retouchée', a.json);
  }
  cli(repo, 'init', '--project', 'demo');
  cli(repo, 'add', 'Lot un');
  cli(repo, 'start', 'L1');
  cli(repo, 'done', 'L1', '--force');
  writeFileSync(join(repo, 'cadence.yaml'), o.yaml ?? 'orchestrate:\n  precheck: false\n  accept: "true"\n');
  commitPaths(repo, 'plan: L1', '.cadence/raf.yaml', '.cadence/notes/.gitkeep', '.gitignore', 'cadence.yaml');
  return { repo, a };
}

const hash = (repo: string, f: string) => git(repo, 'hash-object', '--', f).trim();

describe('spec green sans empreintes — bords (L526)', () => {
  it('empreintes: {} (objet vide) sur un lot vert : traité comme sans empreintes, scellé', () => {
    const { repo, a } = depot({ mute: (r, j) => ecrire(r, j, { ...lire(r, j), empreintes: {} }) });
    const r = cli(repo, 'spec', 'green', 'L1');
    expect(r.err).toBe('');
    expect(r.code).toBe(0);
    expect(lire(repo, a.json).empreintes[a.test]).toBe(hash(repo, a.test));
  });

  it('empreinte égale à "" (chaîne vide) : comptée comme absente, scellée', () => {
    const { repo, a } = depot({ mute: (r, j, t) => ecrire(r, j, { ...lire(r, j), empreintes: { [t]: '' } }) });
    const r = cli(repo, 'spec', 'green', 'L1');
    expect(r.code).toBe(0);
    expect(lire(repo, a.json).empreintes[a.test]).toBe(hash(repo, a.test));
  });

  it('empreintes du mauvais type (tableau) : ne plante pas, le lot est scellé', () => {
    const { repo, a } = depot({ mute: (r, j) => ecrire(r, j, { ...lire(r, j), empreintes: ['x'] }) });
    const r = cli(repo, 'spec', 'green', 'L1');
    expect(r.err).not.toContain('TypeError');
    expect(r.code).toBe(0);
    expect(lire(repo, a.json).empreintes[a.test]).toBe(hash(repo, a.test));
  });

  it('mixte : un test à empreinte périmée + un sans empreinte : un resceau journalisé, un scellé sans journal, le corps ne liste que le rescellé', () => {
    const extra = 'test/autre.acceptation.test.ts';
    const { repo, a } = depot({
      extra: [extra],
      mute: (r, j, t) => {
        ecrire(r, j, { ...lire(r, j), empreintes: { [t]: '0'.repeat(40) } });
      },
    });
    const r = cli(repo, 'spec', 'green', 'L1');
    expect(r.err).toBe('');
    expect(r.code).toBe(0);
    const doc = lire(repo, a.json);
    expect(doc.empreintes[a.test]).toBe(hash(repo, a.test));
    expect(doc.empreintes[extra]).toBe(hash(repo, extra));
    expect(doc.resceaux).toHaveLength(1);
    expect(doc.resceaux[0].test).toBe(a.test);
    const corps = git(repo, 'log', '-1', '--format=%b');
    expect(corps).toContain(a.test);
    expect(corps).not.toContain(extra);
  });

  it('le même fichier listé deux fois : une seule empreinte, le chemin n\'est pas répété dans la sortie', () => {
    const { repo, a } = depot({ mute: (r, j, t) => ecrire(r, j, { ...lire(r, j), fichiers: [t, t] }) });
    const r = cli(repo, 'spec', 'green', 'L1');
    expect(r.code).toBe(0);
    const n = r.out.split(a.test).length - 1;
    expect(n).toBeLessThanOrEqual(1);
  });

  it('chemin listé sous la forme ./test/… : l\'empreinte est posée sous la clé normalisée, puis « déjà vert » au second appel', () => {
    const { repo, a } = depot({ mute: (r, j, t) => ecrire(r, j, { ...lire(r, j), fichiers: [`./${t}`] }) });
    const r = cli(repo, 'spec', 'green', 'L1');
    expect(r.err).toBe('');
    expect(r.code).toBe(0);
    const avant = git(repo, 'rev-parse', 'HEAD');
    const r2 = cli(repo, 'spec', 'green', 'L1');
    expect(r2.out).toContain('déjà vert');
    expect(git(repo, 'rev-parse', 'HEAD')).toBe(avant);
    expect(Object.keys(lire(repo, a.json).empreintes)).toHaveLength(1);
  });

  it('deux appels de suite : le second répond « déjà vert », sans nouveau commit', () => {
    const { repo } = depot();
    expect(cli(repo, 'spec', 'green', 'L1').code).toBe(0);
    const avant = git(repo, 'rev-parse', 'HEAD');
    const r = cli(repo, 'spec', 'green', 'L1');
    expect(r.code).toBe(0);
    expect(r.out).toContain('déjà vert');
    expect(git(repo, 'rev-parse', 'HEAD')).toBe(avant);
  });

  it('test listé supprimé (lot vert sans empreintes) : refus, rien n\'est écrit ni commité', () => {
    const { repo, a } = depot();
    git(repo, 'rm', '-q', '--', a.test);
    git(repo, 'commit', '-q', '-m', 'test: suppression', '--', a.test);
    const avant = git(repo, 'rev-parse', 'HEAD');
    const r = cli(repo, 'spec', 'green', 'L1');
    expect(r.code).not.toBe(0);
    expect(lire(repo, a.json).empreintes).toBeUndefined();
    expect(git(repo, 'rev-parse', 'HEAD')).toBe(avant);
    expect(git(repo, 'status', '--porcelain')).toBe('');
  });

  it('test listé supprimé seulement dans l\'arbre de travail : refus et fichier JSON intact', () => {
    const { repo, a } = depot();
    rmSync(join(repo, a.test));
    const avant = git(repo, 'rev-parse', 'HEAD');
    const r = cli(repo, 'spec', 'green', 'L1');
    expect(r.code).not.toBe(0);
    expect(lire(repo, a.json).empreintes).toBeUndefined();
    expect(git(repo, 'rev-parse', 'HEAD')).toBe(avant);
  });

  it('gabarit plan.commit du projet : le sujet cite le lot et porte l\'action « empreintes »', () => {
    const { repo } = depot({ yaml: 'orchestrate:\n  precheck: false\n  accept: "true"\nplan:\n  commit: "ci({lot}): {action}"\n' });
    const r = cli(repo, 'spec', 'green', 'L1');
    expect(r.code).toBe(0);
    expect(git(repo, 'log', '-1', '--format=%s')).toBe('ci(L1): empreintes de l\'acceptation posées par cadence spec green');
  });

  it('lot rouge (vert: false) sans empreintes : passe toujours à vert: true et reçoit ses empreintes', () => {
    const { repo, a } = depot({ vert: false });
    const r = cli(repo, 'spec', 'green', 'L1');
    expect(r.err).toBe('');
    expect(r.code).toBe(0);
    const doc = lire(repo, a.json);
    expect(doc.vert).toBe(true);
    expect(doc.empreintes[a.test]).toBe(hash(repo, a.test));
    expect(git(repo, 'log', '-1', '--format=%s')).toContain('vert: true posé');
  });

  it('lot vert déjà scellé mais test dérivé depuis : reste « déjà vert » (pas de rescellé silencieux)', () => {
    const { repo, a } = depot();
    sealAcceptation(repo, a.json);
    commitPaths(repo, 'chore(L1): scellé', a.json);
    writeFileSync(join(repo, a.test), '// dérive\n');
    commitPaths(repo, 'test: dérive', a.test);
    const avant = git(repo, 'rev-parse', 'HEAD');
    const r = cli(repo, 'spec', 'green', 'L1');
    expect(r.out).toContain('déjà vert');
    expect(git(repo, 'rev-parse', 'HEAD')).toBe(avant);
  });

  it('acceptation rouge sur un lot vert sans empreintes : la sortie du test est donnée et le fichier reste identique octet pour octet', () => {
    const { repo, a } = depot({ yaml: 'orchestrate:\n  precheck: false\n  accept: "echo ROUGE; exit 1"\n' });
    const avant = readFileSync(join(repo, a.json), 'utf8');
    const r = cli(repo, 'spec', 'green', 'L1');
    expect(r.code).toBe(1);
    expect(r.err).toContain('ROUGE');
    expect(readFileSync(join(repo, a.json), 'utf8')).toBe(avant);
  });
});
