import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { Executeur } from '../src/bench/bras.js';
import { lignesCharge, occupants, refusCharge } from '../src/bench/charge.js';
import { bench, passage } from '../src/bench/cli.js';
import { debutProcessus } from '../src/verrou.js';
import { ioTest } from './cli.test.js';
import { dossierTemp } from './temp.js';

// L762 : deux bancs mécaniques perdus par la charge que le lead ajoutait (16 et 17-11 : ROUGE en temps, 2269 s contre 1490 s, cinq cadence run en parallèle).
// Le banc mécanique refuse de partir (code 2, en nommant runs et sessions) tant qu'un cadence run ou une session du lead (cadence lead hold) vit ;
// --malgre-charge le force, et le rapport le note ; chaque rapport note la charge (load average) au départ et à la fin.

const MAINTENANT = new Date('2026-11-17T09:00:00Z');

/** Un registre commun : un run vivant (verrou tenu par ce processus) du lot L9, un run mort, un run vivant en attente, une session du lead active et une échue. */
function registre(): string {
  const h = dossierTemp('creneaux-l762-'), etats = join(h, 'etats');
  mkdirSync(join(h, 'runs'), { recursive: true }); mkdirSync(join(h, 'holds'), { recursive: true }); mkdirSync(etats);
  const run = (id: string, etat: string, pid: number, lot?: string) => {
    const f = join(etats, `${id}.json`);
    writeFileSync(f, JSON.stringify({ id, etat, ...(lot && { lot }) }));
    writeFileSync(join(etats, `${id}.verrou`), JSON.stringify({ pid, start: pid === process.pid ? debutProcessus(pid) : 'x', role: 'session', depuis: '' }));
    writeFileSync(join(h, 'runs', `${id}.json`), JSON.stringify({ id, repo: `/depots/${id}-depot`, fichier: f }));
  };
  run('run-vivant', 'en-cours', process.pid, 'L9');
  run('run-mort', 'en-cours', 2 ** 22 + 7);
  run('run-attente', 'attente', process.pid);
  const hold = (label: string, expires: string) => writeFileSync(join(h, 'holds', `${encodeURIComponent(label)}.json`), JSON.stringify({ label, since: '2026-11-17T08:00:00Z', expires }));
  hold('revue L700', '2026-11-17T09:30:00Z');
  hold('qa oubliée', '2026-11-17T08:30:00Z');
  return h;
}

describe('ce qui charge la machine du côté du lead', () => {
  it('runs en cours tenus par un processus vivant et sessions du lead non échues, rien d\'autre', () => {
    const o = occupants(registre(), MAINTENANT);
    expect(o.runs).toEqual([{ id: 'run-vivant', repo: '/depots/run-vivant-depot', lot: 'L9' }]);
    expect(o.sessions).toEqual([{ label: 'revue L700', expires: '2026-11-17T09:30:00Z' }]);
    expect(refusCharge(o)).toMatch(/cadence run run-vivant \(lot L9, run-vivant-depot\) ; session du lead « revue L700 » \(jusqu'à 2026-11-17T09:30:00Z\).*--malgre-charge/);
  });
  it('registre absent ou vide : aucun refus', () => {
    expect(refusCharge(occupants(join(dossierTemp('vide-l762-'), 'absent'), MAINTENANT))).toBeNull();
  });
});

describe('cadence2 bench mecanique sous la charge du lead', () => {
  it('refuse de partir, code 2, en nommant le run et la session, sans rien jouer', async () => {
    const racine = dossierTemp('banc-l762-'), io = ioTest({ BENCH_ROOT: racine, CADENCE_HOME: registre() });
    io.now = () => MAINTENANT;
    expect(await bench(['mecanique'], io, '/d')).toBe(2);
    expect(io.erreurs.join('\n')).toMatch(/^bench refusé : le banc mécanique mesure des temps et le lead charge la machine : cadence run run-vivant \(lot L9, run-vivant-depot\) ; session du lead « revue L700 »/);
    expect(existsSync(join(racine, 'runs'))).toBe(false);
  });
  it('--malgre-charge passe ce refus et nomme ce qui tourne (refus suivant : celui de l\'empreinte)', async () => {
    const io = ioTest({ BENCH_ROOT: dossierTemp('banc-l762-'), CADENCE_HOME: registre() });
    io.now = () => MAINTENANT;
    expect(await bench(['mecanique', '--malgre-charge'], io, '/d')).toBe(2);
    expect(io.sortie).toEqual(['banc mécanique forcé malgré la charge (--malgre-charge) : cadence run run-vivant (lot L9, run-vivant-depot) ; session du lead « revue L700 » (jusqu\'à 2026-11-17T09:30:00Z) ; noté au rapport']);
    expect(io.erreurs.join('\n')).not.toMatch(/charge la machine/);
  });
  it('--malgre-charge ne va qu\'avec mecanique ; les autres bancs ne regardent pas la charge', async () => {
    const io = ioTest({ BENCH_ROOT: dossierTemp('banc-l762-'), CADENCE_HOME: registre() });
    expect(await bench(['court', '--malgre-charge'], io, '/d')).toBe(2);
    expect(io.erreurs).toEqual(['bench refusé : --malgre-charge ne va qu\'avec mecanique']);
    const court = ioTest({ BENCH_ROOT: dossierTemp('banc-l762-'), CADENCE_HOME: registre() });
    await bench(['court'], court, '/d');
    expect(court.erreurs.join('\n')).not.toMatch(/charge la machine/);
  });
});

describe('le rapport note la charge', () => {
  const BRIEF = join(import.meta.dirname, '..', 'briefs', 'bras-A.md');
  function racine(): string {
    const r = dossierTemp('bench-l762-');
    mkdirSync(join(r, 'bancs', '1-a'), { recursive: true }); mkdirSync(join(r, 'secrets', '1-a'), { recursive: true });
    writeFileSync(join(r, 'bancs', '1-a', 'banc.yaml'), 'projet: p\nsource: /s\nbase: HEAD\ninstall: "true"\ntests: "true"\ntaille: fonction\n');
    writeFileSync(join(r, 'bancs', '1-a', 'demande.md'), 'd');
    writeFileSync(join(r, 'bras.yaml'), `A:\n  modele: opus\n  brief: ${BRIEF}\ncadence-run:\n  modele: opus\n  brief: ${BRIEF}\n`);
    return r;
  }
  const prep = (_b: unknown, cible: string) => {
    mkdirSync(cible, { recursive: true });
    execFileSync('bash', ['-c', 'git init -q -b main && git -c user.email=t@t -c user.name=t commit -q --allow-empty -m base'], { cwd: cible });
    return { testsBase: 0 };
  };
  const exec: Executeur = (_a, o) => {
    writeFileSync(join(o.cwd, 'f.ts'), 'x');
    execFileSync('bash', ['-c', 'git add -A && git -c user.email=t@t -c user.name=t commit -q -m bras'], { cwd: o.cwd });
    return { stdout: JSON.stringify({ session_id: 's', total_cost_usd: 0, modelUsage: {} }), code: 0 };
  };
  const jouer = (r: string, malgreCharge?: string[]) => {
    const lectures = [[1.5, 1.2, 0.8], [9.25, 6, 3.1]];
    return passage({ racine: r, ref: 'A', cand: 'cadence-run', hebdo: false, juge: 'opus', niveau: 'mecanique', exec, prep: prep as never, maintenant: MAINTENANT,
      empreinte: 'e1', home: r, out: () => {}, version: () => '2.1.325', charge: () => lectures.shift()!, reglagesCharge: { coeurs: 32 }, ...(malgreCharge && { malgreCharge }) });
  };

  it('au départ et à la fin, dans le .md et le .json ; pas de ligne de forçage sans --malgre-charge', async () => {
    const r = racine();
    await jouer(r);
    const md = readFileSync(join(r, 'rapports', '2026-11-17-1000-e1.md'), 'utf8');
    expect(md).toMatch(/^Charge de la machine \(load average 1 · 5 · 15 min, \d+ cœurs\) : départ 1,50 · 1,20 · 0,80 ; fin 9,25 · 6,00 · 3,10 ; pic à 1 min 9,25 \(seuil 16,00\)$/m);
    expect(md).not.toMatch(/Forcé malgré la charge/);
    expect(JSON.parse(readFileSync(join(r, 'rapports', '2026-11-17-1000-e1.json'), 'utf8')).charge).toMatchObject({ depart: [1.5, 1.2, 0.8], fin: [9.25, 6, 3.1] });
    expect(JSON.parse(readFileSync(join(r, 'historique.jsonl'), 'utf8')).malgre_charge).toBeUndefined();
  });
  it('forcé : le rapport, son JSON et l\'historique le disent, avec ce qui tournait', async () => {
    const r = racine();
    await jouer(r, ['cadence run run-1 (lot L9, cadence)']);
    const md = readFileSync(join(r, 'rapports', '2026-11-17-1000-e1.md'), 'utf8');
    expect(md).toContain('⚠ Forcé malgré la charge (--malgre-charge) : cadence run run-1 (lot L9, cadence) ; les temps de ce passage ne valent pas une mesure au calme');
    expect(JSON.parse(readFileSync(join(r, 'rapports', '2026-11-17-1000-e1.json'), 'utf8')).charge.malgre_charge).toEqual(['cadence run run-1 (lot L9, cadence)']);
    expect(JSON.parse(readFileSync(join(r, 'historique.jsonl'), 'utf8')).malgre_charge).toBe(true);
  });
  it('forcé sans rien qui tourne : dit tel quel', () => {
    expect(lignesCharge({ coeurs: 24, depart: [0], fin: [0], malgre_charge: [] })[1]).toMatch(/: aucun run ni session du lead au départ ;/);
  });
});
