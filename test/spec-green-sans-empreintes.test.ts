import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { run } from '../src/cli.js';
import { lockViolations, sealAcceptation } from '../src/orchestrate/accept.js';
import { git } from './orchestrate-harness.js';
import { DIR, ecritAcceptation } from './accept-helpers.js';
import { gitRepo, tempDir } from './helpers.js';

// L526 (issue #20) : un lot clos avec vert: true mais SANS empreintes (clos avant le scellement) : spec green rejoue l'acceptation et, verte, pose les empreintes.

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

/** L1 clos à la main, acceptation à vert: true commitée sans empreintes (sauf `scelle` : un fichier listé déjà scellé). */
function depot(accept: string, o: { extra?: string[]; scelle?: boolean } = {}) {
  const repo = gitRepo();
  const a = ecritAcceptation(repo, { vert: true, ...(o.extra ? { extra: o.extra } : {}) });
  if (o.scelle) {
    sealAcceptation(repo, a.json);
    const doc = lire(repo, a.json);
    delete doc.empreintes[o.extra![0]!];
    writeFileSync(join(repo, a.json), `${JSON.stringify(doc, null, 2)}\n`);
    commitPaths(repo, 'test(L1): scellé à moitié', a.json);
  }
  cli(repo, 'init', '--project', 'demo');
  cli(repo, 'add', 'Lot un');
  cli(repo, 'start', 'L1');
  cli(repo, 'done', 'L1', '--force');
  writeFileSync(join(repo, 'cadence.yaml'), `orchestrate:\n  precheck: false\n  accept: ${JSON.stringify(accept)}\n`);
  commitPaths(repo, 'plan: L1', '.cadence/raf.yaml', '.cadence/notes/.gitkeep', '.gitignore', 'cadence.yaml');
  return { repo, a };
}

describe('cadence spec green sur un lot vert: true sans empreintes (L526, issue #20)', () => {
  it('R1 — acceptation rejouée verte : les empreintes sont posées dans un commit du seul fichier qui cite le lot, vert reste true, sans entrée resceaux, verrou muet', () => {
    const { repo, a } = depot('true');
    const r = cli(repo, 'spec', 'green', 'L1');
    expect(r.err).toBe('');
    expect(r.code).toBe(0);
    const doc = lire(repo, a.json);
    expect(doc.vert).toBe(true);
    expect(doc.empreintes[a.test]).toBe(git(repo, 'hash-object', '--', a.test).trim());
    expect(doc.resceaux).toBeUndefined();
    expect(git(repo, 'log', '-1', '--format=%s')).toBe('chore(L1): empreintes de l\'acceptation posées par cadence spec green');
    expect(git(repo, 'show', '--name-only', '--format=', 'HEAD').split('\n').filter(Boolean)).toEqual([a.json]);
    expect(git(repo, 'status', '--porcelain')).toBe('');
    expect(r.out).toContain('empreintes posées');
    const head = git(repo, 'rev-parse', 'HEAD');
    expect(lockViolations(repo, DIR, head, { lot: 'L2', lotBase: head })).toEqual([]);
  });

  it('R2 — acceptation rejouée rouge : code 1, la sortie est montrée, fichier et HEAD inchangés, le message ne parle pas de « vert: false »', () => {
    const { repo, a } = depot('echo "boom visible"; exit 3');
    const avant = git(repo, 'rev-parse', 'HEAD');
    const r = cli(repo, 'spec', 'green', 'L1');
    expect(r.code).toBe(1);
    expect(r.err).toContain('code 3');
    expect(r.err).toContain('boom visible');
    expect(r.err).toContain('sans empreintes');
    expect(r.err).not.toContain('reste à vert: false');
    expect(lire(repo, a.json).empreintes).toBeUndefined();
    expect(git(repo, 'rev-parse', 'HEAD')).toBe(avant);
    expect(git(repo, 'status', '--porcelain')).toBe('');
  });

  it('R3 — lot vert ET scellé : toujours « déjà vert », la commande n\'est pas lancée, aucun commit', () => {
    const { repo, a } = depot('exit 9');
    sealAcceptation(repo, a.json);
    commitPaths(repo, 'chore(L1): scellé', a.json);
    const avant = git(repo, 'rev-parse', 'HEAD');
    const r = cli(repo, 'spec', 'green', 'L1');
    expect(r.code).toBe(0);
    expect(r.out).toContain('déjà vert');
    expect(git(repo, 'rev-parse', 'HEAD')).toBe(avant);
  });

  it('R4 — un seul fichier listé sans empreinte : celui-là est scellé, l\'empreinte déjà posée de l\'autre est gardée', () => {
    const extra = 'test/autre.acceptation.test.ts';
    const { repo, a } = depot('true', { extra: [extra], scelle: true });
    const gardee = lire(repo, a.json).empreintes[a.test] as string;
    const r = cli(repo, 'spec', 'green', 'L1');
    expect(r.err).toBe('');
    expect(r.code).toBe(0);
    const doc = lire(repo, a.json);
    expect(doc.empreintes[a.test]).toBe(gardee);
    expect(doc.empreintes[extra]).toBe(git(repo, 'hash-object', '--', extra).trim());
  });

  it('R5 — un test listé modifié sans être commité : refus avant de rejouer, rien n\'est changé', () => {
    const { repo, a } = depot('true');
    writeFileSync(join(repo, a.test), '// modifié\n');
    const avant = git(repo, 'rev-parse', 'HEAD');
    const r = cli(repo, 'spec', 'green', 'L1');
    expect(r.code).toBe(2);
    expect(r.err).toContain('modifié(s) sans être commités');
    expect(lire(repo, a.json).empreintes).toBeUndefined();
    expect(git(repo, 'rev-parse', 'HEAD')).toBe(avant);
  });

  it('R6 — sans orchestrate.accept : refus qui nomme la clé, comme pour un lot rouge', () => {
    const { repo, a } = depot('true');
    writeFileSync(join(repo, 'cadence.yaml'), 'orchestrate:\n  precheck: false\n');
    commitPaths(repo, 'chore: sans accept', 'cadence.yaml');
    const r = cli(repo, 'spec', 'green', 'L1');
    expect(r.code).toBe(2);
    expect(r.err).toContain('orchestrate.accept');
    expect(lire(repo, a.json).empreintes).toBeUndefined();
  });
});
