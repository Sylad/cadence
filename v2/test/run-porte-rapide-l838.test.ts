// L838 (D-33, étude L835) : avec run.fastGate, la porte de cadence run ne joue que les tests touchés par le diff du lot ; la suite complète reste à la
// porte de livraison (cadence verify --gate) : aucun verdict n'est noté pour le sha, le hook pre-push exigera donc la porte complète.
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { verdictPour } from '../../scripts/verdicts-porte.mjs';
import { executerRun } from '../src/run/run.js';
import { commite, depot, fauxClaude, git, io } from './run-outils.js';

const ID = ['-c', 'user.email=t@t', '-c', 'user.name=t'];

/** Un dépôt dont la suite complète et la commande liée écrivent dans une trace ; `liee` : le corps de la commande liée (avec {files}). */
function depotRapide(liee = 'echo liee {files} >> TRACE'): { repo: string; trace: string } {
  const repo = depot(), trace = join(repo, '..', 'trace.txt');
  writeFileSync(join(repo, 'a.txt'), 'a');
  writeFileSync(join(repo, 'cadence.yaml'), `orchestrate:\n  test: "echo complete >> ${trace}"\nrun:\n  fastGate:\n    command: "${liee.replace('TRACE', trace)}"\n`);
  git(repo, 'add', '-A'); git(repo, ...ID, 'commit', '-qm', 'porte rapide');
  return { repo, trace };
}
const lire = (f: string) => (existsSync(f) ? readFileSync(f, 'utf8') : '');

describe('cadence run : porte rapide déclarée (run.fastGate, L838)', () => {
  it('les tests touchés seulement : la commande liée reçoit les fichiers du lot, la suite complète ne joue pas, aucun verdict noté, le détail le dit', () => {
    const { repo, trace } = depotRapide(), { l, out } = io();
    const e = executerRun({ repo, demande: 'Fais-le', lot: 'L9', exec: fauxClaude([commite('fait.txt')]), out });
    expect(e.etat).toBe('integre');
    expect(lire(trace)).toBe('liee fait.txt\n');
    expect(verdictPour(repo, git(repo, 'rev-parse', 'main'))).toBeNull();
    const ligne = 'porte rapide (run.fastGate) : tests touchés par 1 fichier(s) du lot ; la suite complète se joue à la porte de livraison (cadence verify --gate)';
    expect(l).toContain(ligne);
    expect(e.detail).toContain(ligne);
    expect(l.join('\n')).toContain('aucun verdict noté');
    expect(e.portes?.at(-1)).toMatchObject({ ciblee: true, ok: true });
    expect(typeof e.portes?.at(-1)?.duree_s).toBe('number');
  });

  it('sélection incertaine (fichier supprimé) : la suite complète joue, la ligne dit pourquoi, le verdict est noté', () => {
    const { repo, trace } = depotRapide(), { l, out } = io();
    const supprime = (cwd: string) => { rmSync(join(cwd, 'a.txt')); commite('fait.txt')(cwd); };
    const e = executerRun({ repo, demande: 'Fais-le', lot: 'L9', exec: fauxClaude([supprime]), out });
    expect(e.etat).toBe('integre');
    expect(lire(trace)).toBe('complete\n');
    expect(l.join('\n')).toContain('porte rapide (run.fastGate) : suite complète jouée — fichier supprimé ou déplacé (a.txt)');
    expect(verdictPour(repo, git(repo, 'rev-parse', 'main'))?.code).toBe(0);
    expect(e.portes?.at(-1)).toMatchObject({ ciblee: false, ok: true });
  });

  it('commande liée qui ne trouve aucun test : la suite complète joue ensuite', () => {
    const { repo, trace } = depotRapide('echo No test files found, exiting with code 1 {files}; exit 1'), { out } = io();
    const e = executerRun({ repo, demande: 'Fais-le', lot: 'L9', exec: fauxClaude([commite('fait.txt')]), out });
    expect(e.etat).toBe('integre');
    expect(lire(trace)).toBe('complete\n');
  });

  it('tests touchés rouges : porte rouge, la session corrige, la porte rapide est rejouée', () => {
    const { repo, trace } = depotRapide('echo liee {files} >> TRACE; test -f corrige.txt'), { l, out } = io();
    const e = executerRun({ repo, demande: 'Fais-le', lot: 'L9', exec: fauxClaude([commite('fait.txt'), commite('corrige.txt')]), out });
    expect(e.etat).toBe('integre');
    expect(lire(trace)).toBe('liee fait.txt\nliee corrige.txt fait.txt\n');
    expect(l.join('\n')).toContain('porte rouge : reprise de la session pour corriger');
    expect(e.portes?.map((p) => p.ok)).toEqual([false, true]);
  });

  it('revue L838 (M1) : un rouge nommé de la porte rapide, vert rejoué seul, est sensible à la charge (L842) : aucune correction, aucun verdict noté', () => {
    // faux lanceur : « --lie » imprime un rouge nommé (la porte rapide) ; un fichier seul (le rejeu de testReplay) est vert ; sans argument (suite complète) : trace
    const repo = depot(), trace = join(repo, '..', 'trace.txt'), { l, out } = io(), appels: unknown[] = [];
    writeFileSync(join(repo, 'lanceur.sh'), `if [ $# -eq 0 ]; then echo complete >> ${trace}; exit 0; fi
if [ "$1" = --lie ]; then echo ' FAIL  a.test.ts > s > charge'; exit 1; fi
echo " ✓ $1 (2 tests)"; echo ' Tests  2 passed (2)'; exit 0\n`);
    writeFileSync(join(repo, 'cadence.yaml'), 'orchestrate:\n  test: bash lanceur.sh\n  testReplay: bash lanceur.sh {files}\nrun:\n  fastGate:\n    command: bash lanceur.sh --lie {files}\n');
    git(repo, 'add', '-A'); git(repo, ...ID, 'commit', '-qm', 'porte rapide');
    const e = executerRun({ repo, demande: 'Fais-le', lot: 'L9', exec: fauxClaude([commite('fait.txt')], appels as never), out });
    expect(e.etat).toBe('integre');
    expect(appels).toHaveLength(1); // la session du travail seule, aucune passe de correction
    expect(e.corrections).toBeUndefined();
    expect(lire(trace)).toBe(''); // ni la suite complète, ni « commande de test inconnue de la porte »
    expect(l.join('\n')).not.toContain('rouges non rejoués seuls');
    expect(e.sensibles_charge).toEqual([expect.objectContaining({ test: 'a.test.ts > s > charge' })]);
    expect(l.join('\n')).toMatch(/test sensible à la charge : a\.test\.ts > s > charge — rouge dans la suite, vert rejoué seul/);
    expect(e.portes?.at(-1)).toMatchObject({ ciblee: true, ok: true });
    const integre = git(repo, 'rev-parse', 'main');
    expect(verdictPour(repo, integre)).toBeNull();
    expect(l.join('\n')).toContain(`porte du run : aucun verdict noté pour ${integre.slice(0, 7)} — la porte rapide (run.fastGate, L838) n'a joué que les tests touchés ; des rouges de la suite ont été excusés`);
  });

  it('cadence.yaml sans run.fastGate : la suite complète, comme avant, et son verdict', () => {
    const repo = depot(), { l, out } = io();
    const e = executerRun({ repo, demande: 'Fais-le', lot: 'L9', exec: fauxClaude([commite('fait.txt')]), out });
    expect(e.etat).toBe('integre');
    expect(l.join('\n')).not.toContain('porte rapide');
    expect(verdictPour(repo, git(repo, 'rev-parse', 'main'))?.code).toBe(0);
  });

  it('run.fastGate mal formé : sans-porte, rien n\'est joué', () => {
    const repo = depot(), { out } = io();
    writeFileSync(join(repo, 'cadence.yaml'), 'orchestrate:\n  test: npm test\nrun:\n  fastGate: true\n');
    git(repo, 'add', '-A'); git(repo, ...ID, 'commit', '-qm', 'porte');
    const e = executerRun({ repo, demande: 'Fais-le', lot: 'L9', exec: fauxClaude([commite('fait.txt')]), out });
    expect(e.etat).toBe('sans-porte');
    expect(e.detail).toContain('run.fastGate.command : à déclarer');
  });
});
