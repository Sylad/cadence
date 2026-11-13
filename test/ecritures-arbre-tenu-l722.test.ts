import { describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { run } from '../src/cli.js';
import { readOrchestrateConfig, readVerifyConfig } from '../src/config.js';
import { holdRepo, PENDING_PLAN, readPending, uncommittedFiles } from '../src/repo-held.js';
import { verifyGate } from '../src/verify-gate.js';
import { executerRun } from '../v2/src/run/run.js';
import type { Executeur } from '../v2/src/bench/bras.js';
import { gitRepo, tempDir, testPackage } from './helpers.js';

// L722 : le lead écrivait dans l'arbre principal pendant qu'un programme le tenait (dossier 2.0.4 pendant une porte, D-1.json pendant un run, raf review
// sur le plan) : review, ux et le registre des demandes passent par le plan en attente, et un run ou une porte nomme au départ ce qui n'est pas commité.

const RAF_JS = () => join(testPackage(), 'bin/raf.js');

function raf(dir: string, ...argv: string[]) {
  return rafEnv(dir, {}, ...argv);
}

function rafEnv(dir: string, env: Record<string, string>, ...argv: string[]) {
  const out: string[] = [];
  const err: string[] = [];
  let code: number;
  try {
    code = run(argv, { cwd: dir, env: { RAF_TODAY: '2026-11-13', ...env }, out: (l) => out.push(l), err: (l) => err.push(l), now: () => new Date('2026-11-13T18:00:00Z') }) as number;
  } catch (e) {
    return { code: -1, out: out.join('\n'), err: `${err.join('\n')}${(e as Error).message}` };
  }
  return { code, out: out.join('\n'), err: err.join('\n') };
}

const sh = (cwd: string, env: NodeJS.ProcessEnv, cmd: string, ...args: string[]) => spawnSync(cmd, args, { cwd, env, encoding: 'utf8' });
const planText = (dir: string) => readFileSync(join(dir, '.cadence/raf.yaml'), 'utf8');
const entry = (dir: string, id: string) => JSON.parse(readFileSync(join(dir, '.cadence/demandes', `${id}.json`), 'utf8')) as Record<string, unknown>;

/** Un dépôt avec son plan (L1 visible), une porte verte, une demande D-1 ouverte, le hook raf installé ; tout commité. */
function project(): { dir: string; env: NodeJS.ProcessEnv } {
  const dir = gitRepo(tempDir());
  raf(dir, 'init', '--no-hook');
  raf(dir, 'add', 'Lot du lead', '--visible');
  writeFileSync(join(dir, 'cadence.yaml'), 'orchestrate:\n  test: "true"\n');
  mkdirSync(join(dir, '.cadence/demandes'), { recursive: true });
  writeFileSync(join(dir, '.cadence/demandes/D-1.json'), `${JSON.stringify({ id: 'D-1', texte: 'Le texte de Sylvain', date: '2026-11-10', etat: 'ouverte', preuve: '' }, null, 1)}\n`);
  raf(dir, 'hook', 'install');
  const bin = tempDir();
  writeFileSync(join(bin, 'raf'), `#!/bin/sh\nexec node "${RAF_JS()}" "$@"\n`);
  chmodSync(join(bin, 'raf'), 0o755);
  const env = { ...process.env, PATH: `${bin}:${process.env.PATH}`, RAF_TODAY: '2026-11-13' };
  sh(dir, env, 'git', 'add', '-A');
  expect(sh(dir, env, 'git', 'commit', '-qm', 'chore: plan').status).toBe(0);
  return { dir, env };
}

describe('L722 (1) : raf review et raf ux passent par le plan en attente', () => {
  it('sur une branche tenue, review et ux n écrivent pas le plan ; rendue, l attente les applique', () => {
    const { dir } = project();
    const unhold = holdRepo(dir, 'porte', 'cadence verify --gate abc1234');
    try {
      const review = raf(dir, 'review', 'L1', 'conforme');
      expect(review.code).toBe(0);
      expect(review.out).toMatch(/mis en attente : raf review L1 conforme — la branche main est tenue par cadence verify --gate abc1234/);
      expect(raf(dir, 'ux', 'L1', 'lisible').out).toMatch(/mis en attente : raf ux L1 lisible/);
      expect(raf(dir, 'review', 'enable').out).toMatch(/mis en attente : raf review enable/);
      expect(planText(dir)).not.toMatch(/conforme|lisible|reviewSince/);
      expect(readPending(dir).map((w) => w.argv)).toEqual([['review', 'L1', 'conforme'], ['ux', 'L1', 'lisible'], ['review', 'enable']]);
    } finally {
      unhold();
    }
    const ok = raf(dir, 'attente', 'appliquer');
    expect(ok.code).toBe(0);
    expect(ok.out).toMatch(/3 écriture\(s\) appliquée\(s\)/);
    expect(planText(dir)).toMatch(/conforme/);
    expect(planText(dir)).toMatch(/lisible/);
    expect(planText(dir)).toMatch(/reviewSince/);
  });

  it('une session orchestrée est refusée avant la mise en attente : son verdict n est pas joué plus tard', () => {
    const { dir } = project();
    const unhold = holdRepo(dir, 'porte', 'porte');
    try {
      const r = rafEnv(dir, { CADENCE_ORCHESTRATED: 'vague-1' }, 'review', 'L1', 'conforme');
      expect(r.err).toMatch(/review refusé pendant une vague orchestrée/);
      expect(readPending(dir)).toEqual([]);
    } finally {
      unhold();
    }
  });
});

describe('L722 (2) : raf demande écrit le registre, mis en attente quand le dépôt est tenu', () => {
  it('précision datée, état et preuve, lot rattaché ; le texte d origine ne change pas', () => {
    const { dir } = project();
    expect(raf(dir, 'demande').out).toMatch(/^D-1 {2}ouverte {2}Le texte de Sylvain$/);
    expect(raf(dir, 'demande', 'D-1', 'precision', 'Servie', 'par', 'L1').out).toMatch(/D-1 : précision ajoutée \(2026-11-13\) — \.cadence\/demandes\/D-1\.json modifié, à commiter/);
    expect(raf(dir, 'demande', 'D-1', 'lot', 'L1').code).toBe(0);
    expect(raf(dir, 'demande', 'D-1', 'lot', 'L1').out).toMatch(/L1 déjà rattaché/);
    expect(raf(dir, 'demande', 'D-1', 'etat', 'livree', 'commit abc1234').out).toMatch(/état livrée, preuve ajoutée/);
    expect(raf(dir, 'demande', 'D-1', 'état', 'vérifiée', 'capture x.png').code).toBe(0);
    expect(entry(dir, 'D-1')).toEqual({
      id: 'D-1', texte: 'Le texte de Sylvain', date: '2026-11-10', etat: 'vérifiée', preuve: 'commit abc1234 · capture x.png',
      precisions: [{ date: '2026-11-13', texte: 'Servie par L1' }], lots: ['L1'],
    });
    expect(raf(dir, 'demande').out).toMatch(/aucune demande ouverte \(1 entrée\(s\)/);
  });

  it('refuse un état sans preuve, un état inconnu, un id absent, une précision vide', () => {
    const { dir } = project();
    expect(raf(dir, 'demande', 'D-1', 'etat', 'livrée').err).toMatch(/livrée sans preuve/);
    expect(raf(dir, 'demande', 'D-1', 'etat', 'abandonnée').err).toMatch(/abandonnée sans raison/);
    expect(raf(dir, 'demande', 'D-1', 'etat', 'finie', 'x').err).toMatch(/état inconnu : finie/);
    expect(raf(dir, 'demande', 'D-9', 'precision', 'x').err).toMatch(/D-9 absente du registre/);
    expect(raf(dir, 'demande', 'D-1', 'precision').err).toMatch(/précision vide/);
    expect(entry(dir, 'D-1').etat).toBe('ouverte');
  });

  it('sur une branche tenue, l écriture va dans l attente (le registre reste tel quel), la lecture non ; rendue, elle est appliquée', () => {
    const { dir, env } = project();
    const unhold = holdRepo(dir, 'run', 'cadence run 1');
    try {
      expect(raf(dir, 'demande', 'D-1', 'etat', 'livrée', 'commit abc').out).toMatch(/mis en attente : raf demande D-1 etat livrée commit abc — la branche main est tenue par cadence run 1/);
      expect(raf(dir, 'demande', 'D-1').out).toMatch(/"etat": "ouverte"/);
      expect(entry(dir, 'D-1').etat).toBe('ouverte');
      expect(sh(dir, env, 'git', 'status', '--porcelain').stdout).toBe('');
      expect(readPending(dir).map((w) => w.argv)).toEqual([['demande', 'D-1', 'etat', 'livrée', 'commit abc']]);
    } finally {
      unhold();
    }
    expect(raf(dir, 'attente', 'appliquer').code).toBe(0);
    expect(entry(dir, 'D-1')).toMatchObject({ etat: 'livrée', preuve: 'commit abc' });
  });
});

describe('L722 (3) : au démarrage d un run ou d une porte, les fichiers non commités de l arbre principal sont nommés', () => {
  it('uncommittedFiles nomme modifiés, non suivis et renommés (les deux chemins), hors plan en attente', () => {
    const { dir, env } = project();
    expect(uncommittedFiles(dir)).toEqual([]);
    writeFileSync(join(dir, '.cadence/demandes/D-1.json'), '{}\n');
    writeFileSync(join(dir, 'dossier-2.0.4.md'), 'brouillon');
    writeFileSync(join(dir, PENDING_PLAN), '[]\n');
    sh(dir, env, 'git', 'mv', 'cadence.yaml', 'cadence2.yaml');
    expect(uncommittedFiles(dir)?.sort()).toEqual(['.cadence/demandes/D-1.json', 'cadence.yaml', 'cadence2.yaml', 'dossier-2.0.4.md']);
  });

  it('verify --gate le dit au départ, en nommant les fichiers : refus de verify.inPlace, ou ligne de la copie jetable', async () => {
    const { dir } = project();
    writeFileSync(join(dir, 'dossier-2.0.4.md'), 'brouillon');
    const sha = sh(dir, process.env, 'git', 'rev-parse', 'HEAD').stdout.trim();
    const gate = async (yaml: string) => {
      writeFileSync(join(dir, 'cadence.yaml'), yaml);
      const lines: string[] = [];
      const code = await verifyGate({ repo: dir, sha, config: readOrchestrateConfig(join(dir, 'cadence.yaml')), verify: readVerifyConfig(join(dir, 'cadence.yaml')), out: (l) => lines.push(l) });
      return { code, text: lines.join('\n') };
    };
    const named = /l'arbre principal a des modifications non commitées ou des fichiers non suivis \(hors plan en attente\) : (cadence\.yaml, )?dossier-2\.0\.4\.md/;
    const refused = await gate('orchestrate:\n  test: "true"\nverify:\n  inPlace: true\n');
    expect(refused.code).toBe(2);
    expect(refused.text).toMatch(named);
    const copy = await gate('orchestrate:\n  test: "true"\n');
    expect(copy.text.split('\n')[0]).toMatch(/porte jouée dans une copie jetable/);
    expect(copy.text.split('\n')[0]).toMatch(named);
    const forced = await gate('orchestrate:\n  test: "true"\nverify:\n  inPlace: false\n');
    expect(forced.text).toMatch(new RegExp(`l'arbre principal a aussi des modifications non commitées \\(hors plan en attente\\) : cadence\\.yaml, dossier-2\\.0\\.4\\.md — la copie joue ${sha.slice(0, 7)} sans elles`));
  });

  it('cadence run le dit au départ, en nommant les fichiers ; un arbre propre ne dit rien', () => {
    const { dir, env } = project();
    writeFileSync(join(dir, '.cadence/demandes/D-1.json'), '{"id":"D-1"}\n');
    const exec: Executeur = (_args, o) => {
      writeFileSync(join(o.cwd, 'fait.txt'), 'ok');
      sh(o.cwd, env, 'git', 'add', 'fait.txt');
      sh(o.cwd, env, 'git', 'commit', '-qm', 'feat: travail du run');
      return { stdout: JSON.stringify({ session_id: 's1', total_cost_usd: 0, result: 'fini', subtype: 'success' }), code: 0 };
    };
    const lignes: string[] = [];
    executerRun({ repo: dir, demande: 'Crée fait.txt', exec, out: (l) => lignes.push(l), raf: RAF_JS() });
    expect(lignes.join('\n')).toMatch(/l'arbre principal a des modifications non commitées \(hors plan en attente\) : \.cadence\/demandes\/D-1\.json — le run part de [0-9a-f]{7} sans elles/);
    sh(dir, env, 'git', 'checkout', '--', '.cadence/demandes/D-1.json');
    const propre: string[] = [];
    executerRun({ repo: dir, demande: 'Crée fait.txt', exec, out: (l) => propre.push(l), raf: RAF_JS() });
    expect(propre.join('\n')).not.toMatch(/non commitées/);
  });
});
