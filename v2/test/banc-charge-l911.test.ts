import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { Executeur, Mesure } from '../src/bench/bras.js';
import { chargeHaute, lignesCharge, occupants, refusCharge, refusChargeMachine, seuilCharge } from '../src/bench/charge.js';
import { bench, passage } from '../src/bench/cli.js';
import { BARRE_SPEC, ligneHistorique, rapport, statut, titreVerdict, verdict, verdictSansJuge, type ResultatBanc } from '../src/bench/verdict.js';
import { debutProcessus } from '../src/verrou.js';
import { ioTest } from './cli.test.js';
import { dossierTemp } from './temp.js';

// L911 (D-40) : le banc mécanique devenait rouge en « temps des retouches » quand d'autres travaux chargeaient la machine — 27-11 08:01,
// charge de fin 23,6, 247 s contre 188 ; 26-11 11:21, 38,7, 296 contre 180 ; verts à 10,7 et 14,3 le 26-11 (Big-Blue, 32 cœurs).
// Avant de lancer : refus (ou attente avec --attendre) si un run, une session du lead, une vague d'orchestrate vit, ou si la charge dépasse cœurs ÷ 2.
// Un passage dont la charge a dépassé cœurs ÷ 2 : critères de temps hors seuil « non mesurable », pas rouge ; le rapport le dit.

const MAINTENANT = new Date('2026-11-27T07:01:00Z');

describe('avant de lancer : ce qui tourne, tous dépôts, et la charge', () => {
  it('une vague d\'orchestrate vivante compte (pid vivant, même heure de démarrage) ; une vague morte, non', () => {
    const h = dossierTemp('creneaux-l911-');
    mkdirSync(join(h, 'waves'), { recursive: true });
    writeFileSync(join(h, 'waves', 'vivante.json'), JSON.stringify({ pid: process.pid, start: debutProcessus(process.pid), wave: 'w-27-11', repos: ['/p/maritime-atlas', '/p/ol-companion'] }));
    writeFileSync(join(h, 'waves', 'morte.json'), JSON.stringify({ pid: 2 ** 22 + 9, wave: 'w-morte', repos: [] }));
    const o = occupants(h, MAINTENANT);
    expect(o.vagues).toEqual([{ wave: 'w-27-11', repos: ['/p/maritime-atlas', '/p/ol-companion'] }]);
    expect(refusCharge(o)).toMatch(/lead charge la machine : vague orchestrate w-27-11 \(maritime-atlas, ol-companion\)\..*--attendre/);
  });
  it('seuil : cœurs ÷ 2, remplaçable par CADENCE_BANC_CHARGE_MAX ; refus de départ au-delà seulement', () => {
    expect(seuilCharge(32, {})).toBe(16);
    expect(seuilCharge(20, { CADENCE_BANC_CHARGE_MAX: '14' })).toBe(14);
    expect(seuilCharge(20, { CADENCE_BANC_CHARGE_MAX: 'x' })).toBe(10);
    expect(refusChargeMachine(16, 32, 16)).toBeNull();
    expect(refusChargeMachine(23.6, 32, 16)).toMatch(/^la machine est chargée \(load average à 1 min 23,60, au-dessus de 16,00 pour 32 cœurs\).*--attendre.*--malgre-charge/);
  });

  const io = (charges: number[][], env: NodeJS.ProcessEnv = {}) => {
    const x = ioTest({ BENCH_ROOT: dossierTemp('banc-l911-'), CADENCE_HOME: join(dossierTemp('vide-l911-'), 'absent'), ...env });
    x.now = () => MAINTENANT;
    const lectures = [...charges]; const dormis: number[] = [];
    return { x, dormis, machine: { coeurs: 32, charge: () => lectures.shift() ?? charges.at(-1)!, dormir: async (ms: number) => { dormis.push(ms); } } };
  };
  it('machine chargée sans aucun run inscrit : refus, code 2, avec la charge et le seuil', async () => {
    const { x, machine } = io([[23.6, 20, 15]]);
    expect(await bench(['mecanique'], x, '/d', machine)).toBe(2);
    expect(x.erreurs).toHaveLength(1);
    expect(x.erreurs[0]).toMatch(/^bench refusé : la machine est chargée \(load average à 1 min 23,60, au-dessus de 16,00 pour 32 cœurs\)/);
  });
  it('--attendre : relit chaque minute, part quand la machine est libre (le refus suivant est celui de l\'empreinte)', async () => {
    const { x, dormis, machine } = io([[23.6], [18], [9.5]]);
    expect(await bench(['mecanique', '--attendre', '10'], x, '/d', machine)).toBe(2);
    expect(dormis).toEqual([60_000, 60_000]);
    expect(x.sortie).toEqual(['banc mécanique en attente (--attendre 10 min) : la machine est chargée (load average à 1 min 23,60, au-dessus de 16,00 pour 32 cœurs)',
      'banc mécanique : la machine est libre, départ']);
    expect(x.erreurs.join('\n')).not.toMatch(/chargée|charge la machine/);
  });
  it('--attendre N : toujours occupée au bout de N minutes, refus qui le dit', async () => {
    const { x, dormis, machine } = io([[30]]);
    expect(await bench(['mecanique', '--attendre', '3'], x, '/d', machine)).toBe(2);
    expect(dormis).toHaveLength(3);
    expect(x.erreurs[0]).toMatch(/^bench refusé : toujours occupée après 3 min d'attente : la machine est chargée/);
  });
  it('--attendre sans nombre : 60 min ; ne va qu\'avec mecanique et pas avec --malgre-charge', async () => {
    const { x, dormis, machine } = io([[30]]);
    expect(await bench(['mecanique', '--attendre'], x, '/d', machine)).toBe(2);
    expect(dormis).toHaveLength(60);
    for (const a of [['court', '--attendre'], ['mecanique', '--attendre', '--malgre-charge']]) {
      const y = io([[1]]);
      expect(await bench(a, y.x, '/d', y.machine)).toBe(2);
      expect(y.x.erreurs).toEqual(['bench refusé : --attendre ne va qu\'avec mecanique, et pas avec --malgre-charge']);
    }
  });
  it('--malgre-charge passe aussi le refus de charge machine', async () => {
    const { x, machine } = io([[40]]);
    expect(await bench(['mecanique', '--malgre-charge'], x, '/d', machine)).toBe(2);
    expect(x.erreurs.join('\n')).not.toMatch(/chargée/);
  });
});

// Les durées du 27-11 08:01 : retouche (banc 1) 188 s pour A, 247 s pour le candidat ; deux bancs de fonction dans le seuil.
const mes = (bras: string, duree_s: number): Mesure => ({ bras, banc: 'b', debut: '', fin: '', duree_s, tokens: 1, cout_usd: 0, questions: 0, questions_texte: [], sessions: [], echec: null });
const banc = (id: string, a: number, c: number, taille: 'retouche' | 'fonction'): ResultatBanc => ({ banc: id, taille, visible: false, reponses: false, frais: false,
  mesures: { A: mes('A', a), C: mes('C', c) }, jugement: null, fuites: { A: [], C: [] }, sans_juge: { A: { suite_ok: true, caches_ok: null }, C: { suite_ok: true, caches_ok: null } } });
const DU_27 = [banc('1-ol-companion-L239', 188, 247, 'retouche'), banc('3-ol-companion-L241', 400, 420, 'fonction'), banc('7-x', 300, 310, 'fonction')];
const SOUS_CHARGE = 'charge 23,60 au-dessus de 16,00 (32 cœurs ÷ 2)';

describe('verdict : un temps hors seuil sous la charge est non mesurable, pas rouge', () => {
  it('au calme, le passage du 27-11 08:01 est ROUGE sur « temps des retouches »', () => {
    const v = verdictSansJuge(DU_27, 'A', 'C', BARRE_SPEC);
    expect(titreVerdict(v)).toBe('ROUGE');
    expect(v.criteres.filter((x) => x.bloquant && !x.ok).map((x) => x.nom)).toEqual(['temps des retouches']);
  });
  it('sous la charge : NON MESURABLE, le critère dit pourquoi, il n\'est pas bloquant ; le temps total dans le seuil reste ok', () => {
    const v = verdictSansJuge(DU_27, 'A', 'C', { ...BARRE_SPEC, charge_haute: SOUS_CHARGE });
    expect(titreVerdict(v)).toBe('NON MESURABLE (à rejouer)');
    expect(v.vert).toBe(false);
    expect(v.non_mesurable).toEqual([`temps sous la charge (${SOUS_CHARGE} ; temps des retouches)`]);
    const ret = v.criteres.find((x) => x.nom === 'temps des retouches')!;
    expect(ret).toMatchObject({ ok: false, bloquant: false, non_mesurable: SOUS_CHARGE });
    expect(v.criteres.find((x) => x.nom === 'temps total')).toMatchObject({ ok: true, bloquant: true });
    expect(v.criteres.find((x) => x.nom === 'temps total')!.non_mesurable).toBeUndefined();
  });
  it('sous la charge, un autre rouge (suite du projet) reste ROUGE', () => {
    const rouge = DU_27.map((r, i) => (i ? r : { ...r, sans_juge: { A: { suite_ok: true, caches_ok: null }, C: { suite_ok: false, caches_ok: null } } }));
    const v = verdictSansJuge(rouge, 'A', 'C', { ...BARRE_SPEC, charge_haute: SOUS_CHARGE });
    expect(titreVerdict(v)).toBe('ROUGE');
    expect(v.non_mesurable).toBeUndefined();
  });
  it('sous la charge, des temps dans le seuil : VERT', () => {
    const v = verdictSansJuge([banc('1-a', 188, 200, 'retouche')], 'A', 'C', { ...BARRE_SPEC, charge_haute: SOUS_CHARGE });
    expect(titreVerdict(v)).toBe('VERT');
  });
  it('le verdict avec juges suit la même règle', () => {
    const meca = { caches_passes: 1, mutations_tuees: 1, mutations_total: 1, suite_ok: true, attendu: 'oui' };
    const jug = { prefere: 'egal', ui: 'egal', meca: { A: meca, C: meca }, defauts: { A: { bloquants: 0, majeurs: 0 }, C: { bloquants: 0, majeurs: 0 } } };
    const res = DU_27.map((r) => ({ ...r, jugement: jug as never }));
    const barre = { ...BARRE_SPEC, reference_absolue: { caches: 0, mutations: 0 } };
    expect(titreVerdict(verdict(res, 'A', 'C', barre))).toBe('ROUGE');
    expect(titreVerdict(verdict(res, 'A', 'C', { ...barre, charge_haute: SOUS_CHARGE }))).toBe('NON MESURABLE (à rejouer)');
  });
  it('le rapport le dit : cellule « non mesurable », section qui nomme la charge ; l\'historique le garde, la garde ne le compte ni vert ni rouge', () => {
    const v = verdictSansJuge(DU_27, 'A', 'C', { ...BARRE_SPEC, charge_haute: SOUS_CHARGE });
    const md = rapport(DU_27, 'A', 'C', v, { date: '2026-11-27', empreinte: 'e1', niveau: 'mecanique' });
    expect(md).toMatch(/^\| temps des retouches \| 247 s contre 188 s \| ≤ 1\.2 × A \| \*\*non mesurable\*\* \(charge\) \|$/m);
    expect(md).not.toMatch(/\*\*ROUGE\*\*/);
    expect(md).toContain('## Temps non mesurables (charge)');
    expect(md).toContain(`(${SOUS_CHARGE})`);
    expect(md).toContain('- temps des retouches : 247 s contre 188 s (seuil ≤ 1.2 × A)');
    const ligne = ligneHistorique(v, { date: MAINTENANT.toISOString(), empreinte: 'e1', candidat: 'C', reference: 'A', modele_candidat: 'opus', bancs: [], hebdo: false, frais: 0, niveau: 'mecanique', charge_haute: SOUS_CHARGE });
    expect(JSON.parse(ligne)).toMatchObject({ vert: false, rouges: [], charge_haute: SOUS_CHARGE, non_mesurable: [expect.stringMatching(/^temps sous la charge/)] });
    expect(statut([ligne], MAINTENANT, 'e1').dernier).toMatch(/non mesurable/);
  });
});

describe('le passage relève la charge et la passe au verdict', () => {
  const BRIEF = join(import.meta.dirname, '..', 'briefs', 'bras-A.md');
  function racine(): string {
    const r = dossierTemp('bench-l911-');
    mkdirSync(join(r, 'bancs', '1-a'), { recursive: true }); mkdirSync(join(r, 'secrets', '1-a'), { recursive: true });
    writeFileSync(join(r, 'bancs', '1-a', 'banc.yaml'), 'projet: p\nsource: /s\nbase: HEAD\ninstall: "true"\ntests: "true"\ntaille: retouche\n');
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
  const jouer = (r: string, lectures: number[][], out: string[] = []) => passage({ racine: r, ref: 'A', cand: 'cadence-run', hebdo: false, juge: 'opus', niveau: 'mecanique', exec,
    prep: prep as never, maintenant: MAINTENANT, empreinte: 'e1', home: r, out: (l) => out.push(l), version: () => '2.1.325', charge: () => lectures.shift()!, reglagesCharge: { coeurs: 32 } });

  it('fin à 23,6 sur 32 cœurs : le rapport, son JSON et l\'historique le disent', async () => {
    const r = racine(), out: string[] = [];
    await jouer(r, [[3.1, 2, 1], [23.6, 19, 12]], out);
    const md = readFileSync(join(r, 'rapports', '2026-11-27-0801-e1.md'), 'utf8');
    expect(md).toMatch(/^Charge de la machine \(load average 1 · 5 · 15 min, 32 cœurs\) : départ 3,10 · 2,00 · 1,00 ; fin 23,60 · 19,00 · 12,00 ; pic à 1 min 23,60 \(seuil 16,00\)$/m);
    expect(md).toContain('⚠ Temps non mesurables : charge 23,60 au-dessus de 16,00 (32 cœurs ÷ 2) pendant le passage');
    expect(out).toContain('⚠ charge 23,60 au-dessus de 16,00 (32 cœurs ÷ 2) pendant le passage : critères de temps non mesurables au lieu de rouges (L911)');
    expect(JSON.parse(readFileSync(join(r, 'rapports', '2026-11-27-0801-e1.json'), 'utf8')).charge).toMatchObject({ pic: 23.6, seuil: 16 });
    expect(JSON.parse(readFileSync(join(r, 'historique.jsonl'), 'utf8')).charge_haute).toBe('charge 23,60 au-dessus de 16,00 (32 cœurs ÷ 2)');
  });
  it('au calme (14,3) : aucune mention, aucun champ charge_haute', async () => {
    const r = racine();
    await jouer(r, [[3, 2, 1], [14.3, 12, 9]]);
    expect(readFileSync(join(r, 'rapports', '2026-11-27-0801-e1.md'), 'utf8')).not.toMatch(/non mesurable/i);
    expect(JSON.parse(readFileSync(join(r, 'historique.jsonl'), 'utf8')).charge_haute).toBeUndefined();
  });
  it('lignesCharge : le seuil remplacé est nommé', () => {
    expect(chargeHaute({ coeurs: 20, depart: [1], fin: [12], pic: 12, seuil: 11 })).toBe('charge 12,00 au-dessus de 11,00 (CADENCE_BANC_CHARGE_MAX)');
    expect(lignesCharge({ coeurs: 20, depart: [1], fin: [9], pic: 9, seuil: 10 })).toHaveLength(1);
  });
});
