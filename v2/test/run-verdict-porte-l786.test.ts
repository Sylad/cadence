// L786 : après un cadence run intégré, le push du sha intégré était refusé « aucun verdict de la porte pour ce sha » (cluster-sante a3cc356, 19-11), alors que
// le run venait de jouer la porte complète sur ce sha. La porte du run note désormais son verdict là où le hook pre-push le lit (scripts/verdicts-porte.mjs,
// le fichier de verify --gate), et un commit de plan seul posé ensuite n'exige pas de nouvelle porte.
import { mkdirSync, writeFileSync } from 'node:fs';
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
