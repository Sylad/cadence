// L786 : après un cadence run intégré, le push du sha intégré était refusé « aucun verdict de la porte pour ce sha » (cluster-sante a3cc356, 19-11), alors que
// le run venait de jouer la porte complète sur ce sha. La porte du run note désormais son verdict là où le hook pre-push le lit (scripts/verdicts-porte.mjs,
// le fichier de verify --gate), et un commit de plan seul posé ensuite n'exige pas de nouvelle porte.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { run } from '../../src/cli.js';
import { verdictPour } from '../../scripts/verdicts-porte.mjs';
import { executerRun } from '../src/run/run.js';
import { commite, depot, fauxClaude, git, io } from './run-outils.js';

const ID = ['-c', 'user.email=t@t', '-c', 'user.name=t'];
const ZERO = '0'.repeat(40);

/** Le hook pre-push de raf sur le dépôt, pour un push de `sha` sur une branche neuve du distant. */
async function prePush(repo: string, sha: string) {
  const err: string[] = [];
  const code = await run(['hook', 'pre-push', 'origin'], { cwd: repo, env: { RAF_TODAY: '2026-11-19' }, out: () => {}, err: (l) => err.push(l), now: () => new Date('2026-11-19T10:00:00'), stdin: () => `refs/heads/main ${sha} refs/heads/main ${ZERO}\n` });
  return { code, err: err.join('\n') };
}

describe('cadence run : la porte du run note son verdict pour le hook pre-push (L786)', () => {
  it('run intégré : le sha intégré a un verdict vert, son push passe ; un commit de plan seul posé ensuite (plan + demande) passe aussi', async () => {
    const repo = depot(), { out } = io();
    const e = executerRun({ repo, demande: 'Fais-le', lot: 'L9', exec: fauxClaude([commite('fait.txt')]), out });
    expect(e.etat).toBe('integre');
    const integre = git(repo, 'rev-parse', 'main');
    expect(verdictPour(repo, integre)?.code).toBe(0);
    expect(await prePush(repo, integre)).toEqual({ code: 0, err: '' });
    mkdirSync(join(repo, '.cadence', 'demandes'), { recursive: true });
    writeFileSync(join(repo, '.cadence', 'raf.yaml'), 'lots: []\n');
    writeFileSync(join(repo, '.cadence', 'demandes', 'D-1.json'), '{}\n');
    git(repo, 'add', '-A'); git(repo, ...ID, 'commit', '-qm', 'plan: L9 terminé (D-1)');
    expect(await prePush(repo, git(repo, 'rev-parse', 'HEAD'))).toEqual({ code: 0, err: '' });
  });

  it('porte rouge rendue au lead : le sha jugé a un verdict rouge, son push est refusé comme tel', async () => {
    const repo = depot('test -f jamais.txt'), { out } = io();
    const e = executerRun({ repo, demande: 'Fais-le', lot: 'L9', exec: fauxClaude([commite('fait.txt'), commite('encore.txt')]), out });
    expect(e.etat).toBe('porte-rouge');
    const tete = git(e.worktree, 'rev-parse', 'HEAD');
    expect(verdictPour(repo, tete)?.code).toBe(1);
    const r = await prePush(repo, tete);
    expect(r.code).toBe(3);
    expect(r.err).toContain('sa porte est rouge');
  });

  it('--sans-porte sans commande de porte : aucun verdict noté (aucune porte n\'a jugé), le push exige toujours la porte si le projet en déclare une', () => {
    const repo = depot(), { out } = io();
    writeFileSync(join(repo, 'cadence.yaml'), 'verify:\n  inPlace: false\n');
    git(repo, 'add', '-A'); git(repo, ...ID, 'commit', '-qm', 'sans porte');
    const e = executerRun({ repo, demande: 'Fais-le', lot: 'L9', exec: fauxClaude([commite('fait.txt')]), out, sansPorte: true });
    expect(e.etat).toBe('integre');
    expect(verdictPour(repo, git(repo, 'rev-parse', 'main'))).toBeNull();
  });
});

/** Un dépôt dont cadence.yaml est `yaml` (commité sur main), avec les dossiers `dossiers` (suivis grâce à un .gitkeep). */
function depotYaml(yaml: string, dossiers: string[] = []): string {
  const repo = depot();
  for (const d of dossiers) { mkdirSync(join(repo, d), { recursive: true }); writeFileSync(join(repo, d, '.gitkeep'), ''); }
  writeFileSync(join(repo, 'cadence.yaml'), yaml);
  git(repo, 'add', '-A'); git(repo, ...ID, 'commit', '-qm', 'porte');
  return repo;
}

describe('revue r1 de L786 (M1) : la porte du run joue les étapes de verify --gate, test en parties compris', () => {
  it('test en parties rouge + build vert (warhammer40k) : la partie est jouée, aucun verdict vert n\'est noté', () => {
    const repo = depotYaml('orchestrate:\n  test:\n    - dir: x\n      run: "false"\n  build: "true"\n', ['x']), { out } = io();
    const e = executerRun({ repo, demande: 'Fais-le', lot: 'L9', exec: fauxClaude([commite('fait.txt')]), out });
    expect(e.etat).toBe('porte-rouge');
    expect(e.detail).toContain('$ cd x && false');
    const tete = git(e.worktree, 'rev-parse', 'HEAD');
    expect(verdictPour(repo, tete)?.code).toBe(1);
  });

  it('build puis chaque partie, dans son dossier et dans l\'ordre de verify --gate : verte, le sha intégré a son verdict vert', () => {
    const trace = join(depot(), '..', 'trace.txt');
    const repo = depotYaml(`orchestrate:\n  test:\n    - dir: front\n      run: "test -f ../fait.txt && echo front >> ${trace}"\n    - dir: back\n      run: "pwd | grep -q /back$ && echo back >> ${trace}"\n  build: "echo build >> ${trace}"\n`, ['front', 'back']), { out } = io();
    const e = executerRun({ repo, demande: 'Fais-le', lot: 'L9', exec: fauxClaude([commite('fait.txt')]), out });
    expect(e.etat).toBe('integre');
    expect(readFileSync(trace, 'utf8').split('\n').filter(Boolean)).toEqual(['build', 'front', 'back']);
    expect(verdictPour(repo, git(repo, 'rev-parse', 'main'))?.code).toBe(0);
  });

  it('une partie que verify --gate refuserait (dir hors du dépôt) : rien n\'est joué à moitié, aucun verdict, le run le dit', () => {
    const repo = depotYaml('orchestrate:\n  test:\n    - dir: ../x\n      run: "true"\n  build: "true"\n'), { out } = io();
    const e = executerRun({ repo, demande: 'Fais-le', lot: 'L9', exec: fauxClaude([commite('fait.txt')]), out });
    expect(e.etat).toBe('sans-porte');
    expect(e.detail).toContain('orchestrate.test : dir invalide « ../x »');
    expect(verdictPour(repo, git(e.worktree, 'rev-parse', 'HEAD'))).toBeNull();
  });
});

describe('revue r1 de L786 (M2) : un verdict n\'est noté que pour un arbre égal au commit, avant et après la porte, au même HEAD', () => {
  it('la session commite fait.txt et laisse un fichier non suivi dont dépend la porte : porte verte, intégré, mais aucun verdict noté', () => {
    const repo = depot('test -f fait.txt && test -f nonsuivi.txt'), { l, out } = io();
    const travail = (cwd: string) => { commite('fait.txt')(cwd); writeFileSync(join(cwd, 'nonsuivi.txt'), 'x'); };
    const e = executerRun({ repo, demande: 'Fais-le', lot: 'L9', exec: fauxClaude([travail]), out });
    expect(e.etat).toBe('integre');
    const integre = git(repo, 'rev-parse', 'main');
    expect(verdictPour(repo, integre)).toBeNull();
    expect(l.join('\n')).toContain(`porte du run : aucun verdict noté pour ${integre.slice(0, 7)} — avant la porte, l'arbre portait des fichiers hors du commit (1)`);
  });

  it('un fichier non suivi caché par status.showUntrackedFiles=no reste vu : aucun verdict', () => {
    const repo = depot('test -f fait.txt && test -f nonsuivi.txt'), { out } = io();
    git(repo, 'config', 'status.showUntrackedFiles', 'no');
    const travail = (cwd: string) => { commite('fait.txt')(cwd); writeFileSync(join(cwd, 'nonsuivi.txt'), 'x'); };
    const e = executerRun({ repo, demande: 'Fais-le', lot: 'L9', exec: fauxClaude([travail]), out });
    expect(e.etat).toBe('integre');
    expect(verdictPour(repo, git(repo, 'rev-parse', 'main'))).toBeNull();
  });

  it('une modification non commitée d\'un fichier suivi : aucun verdict', () => {
    const repo = depot('test -f fait.txt'), { out } = io();
    const travail = (cwd: string) => { commite('fait.txt')(cwd); writeFileSync(join(cwd, 'fait.txt'), 'modifié'); };
    const e = executerRun({ repo, demande: 'Fais-le', lot: 'L9', exec: fauxClaude([travail]), out });
    expect(e.etat).toBe('integre');
    expect(verdictPour(repo, git(repo, 'rev-parse', 'main'))).toBeNull();
  });

  it('la porte écrit un fichier non suivi : aucun verdict (l\'arbre jugé n\'est plus celui du commit)', () => {
    const repo = depot('test -f fait.txt && echo x > sortie-de-porte.txt'), { l, out } = io();
    const e = executerRun({ repo, demande: 'Fais-le', lot: 'L9', exec: fauxClaude([commite('fait.txt')]), out });
    expect(e.etat).toBe('integre');
    expect(verdictPour(repo, git(repo, 'rev-parse', 'main'))).toBeNull();
    expect(l.join('\n')).toContain('après la porte, l\'arbre porte des fichiers hors du commit (1)');
  });

  it('HEAD bouge pendant la porte : ni l\'ancien ni le nouveau sha n\'ont de verdict', () => {
    const repo = depot(`test -f fait.txt && git ${ID.join(' ')} commit -q --allow-empty -m pendant`), { l, out } = io();
    const e = executerRun({ repo, demande: 'Fais-le', lot: 'L9', exec: fauxClaude([commite('fait.txt')]), out });
    expect(e.etat).toBe('integre');
    expect(git(repo, 'log', '--format=%s', '-2', 'main')).toBe('pendant\najoute fait.txt');
    expect(verdictPour(repo, git(repo, 'rev-parse', 'main'))).toBeNull();
    expect(verdictPour(repo, git(repo, 'rev-parse', 'main~1'))).toBeNull();
    expect(l.join('\n')).toMatch(/aucun verdict noté pour [0-9a-f]{7} — HEAD est passé à/);
  });
});

describe('revue r1 de L786 (m5) : la cible avance pendant la porte, seul le sha rebasé et intégré vaut', () => {
  it('rebase et porte rejouée : le sha intégré a son verdict vert, distinct du sha jugé avant le rebase', () => {
    const repo = depot(), compte = join(repo, '..', 'porte.compte');
    // Pendant la première porte, un autre commit arrive sur main (comme un autre run qui s'intègre) ; la seconde porte ne fait rien de plus.
    writeFileSync(join(repo, 'cadence.yaml'), `orchestrate:\n  test: test -f fait.txt && echo x >> ${compte} && (test "$(wc -l < ${compte})" -gt 1 || (cd ${repo} && echo y > autre.txt && git add autre.txt && git ${ID.join(' ')} commit -qm autre))\n`);
    git(repo, 'add', '.'); git(repo, ...ID, 'commit', '-qm', 'porte');
    const { l, out } = io();
    const e = executerRun({ repo, demande: 'Fais-le', lot: 'L9', exec: fauxClaude([commite('fait.txt')]), out });
    expect(e.etat).toBe('integre');
    expect(l.join('\n')).toMatch(/main a avancé pendant la porte : rebase et porte rejouée/);
    expect(existsSync(compte) && readFileSync(compte, 'utf8').split('\n').filter(Boolean).length).toBe(2);
    const integre = git(repo, 'rev-parse', 'main');
    expect(git(repo, 'log', '--format=%s', '-1', 'main~1')).toBe('autre');
    expect(verdictPour(repo, integre)?.code).toBe(0);
  });
});

