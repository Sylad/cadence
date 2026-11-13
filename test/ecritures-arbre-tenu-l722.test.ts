import { describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { run } from '../src/cli.js';
import { readOrchestrateConfig, readVerifyConfig } from '../src/config.js';
import { holdRepo, PENDING_PLAN, readPending, uncommittedFiles } from '../src/repo-held.js';
import { Plan } from '../src/plan.js';
import { verifyGate } from '../src/verify-gate.js';
import { executerRun } from '../v2/src/run/run.js';
import type { Executeur } from '../v2/src/bench/bras.js';
import { commit, gitRepo, tempDir, testPackage } from './helpers.js';

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
      expect(review.out).toMatch(/mis en attente : raf review L1 conforme --vu aucun — la branche main est tenue par cadence verify --gate abc1234/);
      expect(raf(dir, 'ux', 'L1', 'lisible').out).toMatch(/mis en attente : raf ux L1 lisible/);
      expect(raf(dir, 'review', 'enable').out).toMatch(/mis en attente : raf review enable/);
      expect(planText(dir)).not.toMatch(/conforme|lisible|reviewSince/);
      expect(readPending(dir).map((w) => w.argv)).toEqual([['review', 'L1', 'conforme', '--vu', 'aucun'], ['ux', 'L1', 'lisible'], ['review', 'enable']]);
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

// Revue L722 r1 : une revue mise en attente ne gardait que la commande ; appliquée plus tard, elle retenait le dernier commit du lot À CE MOMENT-LÀ et
// couvrait des commits arrivés entre-temps (intégration d'un run, correctif commité après une porte), que raf done laissait passer sans revue.
describe('L722 (4) : une revue mise en attente porte sur le dernier commit du lot au moment où elle est tapée', () => {
  /** Le projet, revue de code exigée, L1 démarré avec un premier commit de travail. */
  function reviewed(): { dir: string; env: NodeJS.ProcessEnv; first: string } {
    const { dir, env } = project();
    raf(dir, 'review', 'enable');
    raf(dir, 'start', 'L1');
    writeFileSync(join(dir, 'a.txt'), 'a');
    sh(dir, env, 'git', 'add', '-A');
    expect(sh(dir, env, 'git', 'commit', '-qm', 'feat(L1): premier').status).toBe(0);
    return { dir, env, first: sh(dir, env, 'git', 'rev-parse', 'HEAD').stdout.trim() };
  }

  const second = (dir: string, env: NodeJS.ProcessEnv) => {
    writeFileSync(join(dir, 'b.txt'), 'b');
    sh(dir, env, 'git', 'add', 'b.txt');
    expect(sh(dir, env, 'git', 'commit', '-qm', 'fix(L1): second').status).toBe(0);
  };

  it('porte : un correctif du lot commité après la porte, avant l application, n est pas couvert ; raf done refuse', () => {
    const { dir, env, first } = reviewed();
    const unhold = holdRepo(dir, 'porte', 'cadence verify --gate');
    try {
      expect(raf(dir, 'review', 'L1', 'conforme').out).toMatch(new RegExp(`mis en attente : raf review L1 conforme --vu ${first}`));
    } finally {
      unhold();
    }
    second(dir, env);
    expect(raf(dir, 'attente', 'appliquer').code).toBe(0);
    expect(planText(dir)).toMatch(new RegExp(`commit: ${first}`));
    const done = raf(dir, 'done', 'L1');
    expect(done.err).toMatch(/la revue de code précède 1 commit\(s\) du lot, elle est à refaire/);
  });

  it('run : un commit du lot intégré pendant que la branche est tenue n est pas couvert ; sans commit postérieur, raf done passe', () => {
    const { dir, env, first } = reviewed();
    const unhold = holdRepo(dir, 'run', 'cadence run 1');
    try {
      raf(dir, 'review', 'L1', 'conforme');
      second(dir, { ...env, CADENCE_COMMIT_PROGRAMME: '1' });
    } finally {
      unhold();
    }
    expect(raf(dir, 'attente', 'appliquer').code).toBe(0);
    expect(planText(dir)).toMatch(new RegExp(`commit: ${first}`));
    expect(raf(dir, 'done', 'L1').err).toMatch(/la revue de code précède 1 commit\(s\) du lot/);
    // Revue refaite sur le second commit : rien après, done passe.
    expect(raf(dir, 'review', 'L1', 'conforme').code).toBe(0);
    expect(raf(dir, 'done', 'L1').code).toBe(0);
  });

  it('un lot sans commit au moment de la revue : la revue ne couvre aucun commit venu après', () => {
    const { dir, env } = project();
    raf(dir, 'review', 'enable');
    raf(dir, 'start', 'L1');
    const unhold = holdRepo(dir, 'porte', 'porte');
    try {
      expect(raf(dir, 'review', 'L1', 'conforme').out).toMatch(/raf review L1 conforme --vu aucun/);
    } finally {
      unhold();
    }
    second(dir, env);
    raf(dir, 'attente', 'appliquer');
    expect(planText(dir)).toMatch(/commit: null/);
    expect(raf(dir, 'done', 'L1').err).toMatch(/la revue de code précède 1 commit\(s\) du lot/);
  });

  it('--vu tapé à la main, hors application de l attente, est refusé', () => {
    const { dir } = reviewed();
    expect(raf(dir, 'review', 'L1', 'conforme', '--vu', 'aucun').err).toMatch(/--vu .*réservé/);
  });
});

describe('L722 (5) : une écriture invalide est refusée avant la mise en attente, elle ne bloque plus celles qui la suivent', () => {
  it('demande inconnue, état sans preuve, revue d un lot inconnu : refusés, rien en attente ; la note suivante est appliquée', () => {
    const { dir } = project();
    const unhold = holdRepo(dir, 'run', 'cadence run 1');
    try {
      expect(raf(dir, 'demande', 'D-99', 'etat', 'livrée', 'x').err).toMatch(/D-99 absente du registre/);
      expect(raf(dir, 'demande', 'D-1', 'etat', 'livrée').err).toMatch(/livrée sans preuve/);
      expect(raf(dir, 'demande', 'D-1', 'etat', 'finie', 'x').err).toMatch(/état inconnu : finie/);
      expect(raf(dir, 'review', 'L9', 'conforme')).toMatchObject({ code: 2, err: expect.stringMatching(/L9/) });
      expect(raf(dir, 'ux', 'L9', 'lisible')).toMatchObject({ code: 2, err: expect.stringMatching(/L9/) });
      expect(readPending(dir)).toEqual([]);
      expect(raf(dir, 'note', 'L1', 'après').code).toBe(0);
    } finally {
      unhold();
    }
    expect(raf(dir, 'attente', 'appliquer').out).toMatch(/1 écriture\(s\) appliquée\(s\) —/);
    expect(planText(dir)).toMatch(/après/);
  });
});

// Revue L722 r2 (L725) : `raf review L1` ou `raf ux L1` sans verdict était mis en attente sans contrôle ; à l'application, il échouait (usage) et
// toutes les écritures mises en attente derrière lui restaient bloquées jusqu'à une correction à la main de .cadence/plan-en-attente.yaml.
describe('L725 (1) : review et ux sans verdict, ou sans lot, sont refusés avant la mise en attente, comme hors attente', () => {
  it('refusés avec l usage, rien en attente ; enable reste mis en attente ; la note suivante est appliquée', () => {
    const { dir } = project();
    const unhold = holdRepo(dir, 'run', 'cadence run 1');
    try {
      expect(raf(dir, 'review', 'L1')).toMatchObject({ code: 2, err: expect.stringMatching(/usage : raf review <lot> "verdict"/) });
      expect(raf(dir, 'ux', 'L1')).toMatchObject({ code: 2, err: expect.stringMatching(/usage : raf ux <lot> "verdict"/) });
      expect(raf(dir, 'review')).toMatchObject({ code: 2, err: expect.stringMatching(/usage : raf review enable \| review <lot> "verdict"/) });
      expect(raf(dir, 'ux')).toMatchObject({ code: 2, err: expect.stringMatching(/usage : raf ux enable \| ux <lot> "verdict"/) });
      expect(readPending(dir)).toEqual([]);
      expect(raf(dir, 'ux', 'enable').out).toMatch(/mis en attente : raf ux enable/);
      expect(raf(dir, 'note', 'L1', 'après').code).toBe(0);
    } finally {
      unhold();
    }
    const applied = raf(dir, 'attente', 'appliquer');
    expect(applied.code).toBe(0);
    expect(applied.out).toMatch(/2 écriture\(s\) appliquée\(s\) —/);
    expect(planText(dir)).toMatch(/après/);
    expect(planText(dir)).toMatch(/uxSince/);
  });
});

// Revue L722 r2 (L725) : le sha figé d'un dépôt voisin (`--vu-depot <dépôt>=<sha|aucun>`) n'avait aucun test.
describe('L725 (2) : une revue mise en attente fige aussi le dernier commit du lot de chaque dépôt voisin', () => {
  /** Le projet avec L1 démarré qui déclare deux dépôts voisins : l'un a un commit du lot, l'autre aucun. */
  function withNeighbours(): { dir: string; env: NodeJS.ProcessEnv; voisin: string; vide: string; relVoisin: string; relVide: string; first: string } {
    const { dir, env } = project();
    raf(dir, 'review', 'enable');
    raf(dir, 'start', 'L1');
    const voisin = gitRepo(tempDir());
    const vide = gitRepo(tempDir());
    commit(voisin, 'fix(L1): côté voisin', '2026-11-13T10:00:00');
    commit(vide, 'chore: sans rapport', '2026-11-13T10:00:00');
    const [relVoisin, relVide] = [relative(dir, voisin), relative(dir, vide)];
    const file = join(dir, '.cadence/raf.yaml');
    writeFileSync(file, planText(dir).replace(/- id: L1\n/, `- id: L1\n    repos: [${JSON.stringify(relVoisin)}, ${JSON.stringify(relVide)}]\n`));
    sh(dir, env, 'git', 'add', '-A');
    expect(sh(dir, env, 'git', 'commit', '-qm', 'chore: dépôts voisins de L1').status).toBe(0);
    return { dir, env, voisin, vide, relVoisin, relVide, first: sh(voisin, env, 'git', 'rev-parse', 'HEAD').stdout.trim() };
  }

  it('la ligne mise en attente porte --vu-depot pour chaque voisin ; un commit voisin venu avant l application ne change pas le sha retenu', () => {
    const { dir, env, voisin, vide, relVoisin, relVide, first } = withNeighbours();
    const unhold = holdRepo(dir, 'run', 'cadence run 1');
    try {
      expect(raf(dir, 'review', 'L1', 'conforme').code).toBe(0);
    } finally {
      unhold();
    }
    expect(readPending(dir).map((w) => w.argv)).toEqual([['review', 'L1', 'conforme', '--vu', 'aucun', '--vu-depot', `${relVoisin}=${first}`, '--vu-depot', `${relVide}=aucun`]]);
    commit(voisin, 'fix(L1): second côté voisin', '2026-11-13T11:00:00');
    commit(vide, 'feat(L1): premier côté vide', '2026-11-13T11:00:00');
    expect(sh(voisin, env, 'git', 'rev-parse', 'HEAD').stdout.trim()).not.toBe(first);
    expect(raf(dir, 'attente', 'appliquer').code).toBe(0);
    const review = Plan.load(join(dir, '.cadence/raf.yaml')).lots().find((l) => l.id === 'L1')?.review;
    expect(review).toMatchObject({ commit: null, repos: { [relVoisin]: first, [relVide]: null } });
  });
});

describe('L722 (6) : la raison d un abandon va dans les champs du registre, jamais dans la preuve', () => {
  it('raison, date de l abandon et état d avant ; la preuve de la livraison reste telle quelle', () => {
    const { dir } = project();
    raf(dir, 'demande', 'D-1', 'etat', 'livrée', 'commit abc1234');
    expect(raf(dir, 'demande', 'D-1', 'etat', 'abandonnee', 'consigne', 'du', 'lead').out).toMatch(/état abandonnée, raison ajoutée/);
    expect(entry(dir, 'D-1')).toEqual({
      id: 'D-1', texte: 'Le texte de Sylvain', date: '2026-11-10', etat: 'abandonnée', preuve: 'commit abc1234',
      etat_avant_abandon: 'livrée', raison: 'consigne du lead', abandon: '2026-11-13',
    });
  });
});

// Revue L722 r1 : v2/src/run/run.ts recopiait uncommittedFiles et namedFiles de src/repo-held.ts ; un changement du filtre fait d'un seul côté aurait divergé.
describe('L722 (7) : cadence run et la porte lisent l arbre non commité avec le même code', () => {
  const source = (f: string) => readFileSync(join(import.meta.dirname, '..', f), 'utf8');

  it('src/repo-held.ts et v2/src/run/run.ts importent scripts/arbre-non-commite.mjs, aucun ne relit git status lui-même', () => {
    expect(source('src/repo-held.ts')).toMatch(/from '\.\.\/scripts\/arbre-non-commite\.mjs'/);
    expect(source('v2/src/run/run.ts')).toMatch(/from '\.\.\/\.\.\/\.\.\/scripts\/arbre-non-commite\.mjs'/);
    for (const f of ['src/repo-held.ts', 'v2/src/run/run.ts']) expect(source(f)).not.toMatch(/'status', '--porcelain'/);
  });

  it('le module partagé est publié avec le paquet (dist et v2/dist l importent à l exécution)', () => {
    const files = (JSON.parse(source('package.json')) as { files: string[] }).files;
    expect(files).toEqual(expect.arrayContaining(['scripts/arbre-non-commite.mjs', 'scripts/arbre-non-commite.d.mts']));
    expect(readFileSync(join(testPackage(), 'scripts/arbre-non-commite.mjs'), 'utf8')).toMatch(/export function fichiersNonCommites/);
  });
});
