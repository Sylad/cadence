import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { executerRun } from '../src/run/run.js';
import { commite, depot, fauxClaude } from './run-outils.js';

// L710 (issue #55 du compte pro) : un run vivant prend un créneau de sessions. Il s'inscrit dans le registre commun (CADENCE_HOME/runs/<id>.json,
// lu par liveRuns de src/orchestrate/registry.ts) pendant sa session, sa porte et son intégration, et s'en retire à la fin.
const inscrits = () => { const d = join(process.env.CADENCE_HOME!, 'runs'); return existsSync(d) ? readdirSync(d) : []; };

describe('cadence run dans le registre des créneaux (L710)', () => {
  it('inscrit pendant sa session, sous son verrou et en-cours ; retiré à la fin', () => {
    const repo = depot();
    let vu: { inscription: { id: string; repo: string; fichier: string }; etat: string; verrou: number } | undefined;
    const exec = fauxClaude([(cwd) => {
      const [f] = inscrits();
      const inscription = JSON.parse(readFileSync(join(process.env.CADENCE_HOME!, 'runs', f), 'utf8'));
      vu = { inscription, etat: JSON.parse(readFileSync(inscription.fichier, 'utf8')).etat, verrou: JSON.parse(readFileSync(inscription.fichier.replace(/\.json$/, '.verrou'), 'utf8')).pid };
      commite('fait.txt')(cwd);
    }]);
    const e = executerRun({ repo, demande: 'Crée fait.txt', exec, out: () => {} });
    expect(e.etat).toBe('integre');
    expect(vu).toEqual({ inscription: { id: e.id, repo: e.repo, fichier: e.fichier }, etat: 'en-cours', verrou: process.pid });
    expect(inscrits()).toEqual([]);
  });

  it('un run qui finit en échec se retire aussi', () => {
    const repo = depot();
    const e = executerRun({ repo, demande: 'x', exec: () => { throw new Error('claude absent'); }, out: () => {} });
    expect(e.etat).toBe('echec');
    expect(inscrits()).toEqual([]);
  });
});
