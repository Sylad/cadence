import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { listerBancs } from '../src/bench/banc.js';
import { bench, numerosARemesurer, SOUS } from '../src/bench/cli.js';
import { BANCS_COURT, LIBELLE_COURT, PUBLIE, statut } from '../src/bench/verdict.js';
import { ioTest } from './cli.test.js';
import { dossierTemp } from './temp.js';

// L739 (15-11) : la demande du banc 6 (ol-companion L167) dit « il faudrait rajouter au plan… » ; cadence run l'ajoute au plan, lecture littérale
// correcte, A implémente, et depuis L733 le passage est non mesurable à chaque fois (15-11 17 h 49 et 20 h 45) : aucune publication possible.
// Le banc 7 (ol-companion L160, grosse, pièce image) le remplace dans le court et le mécanique ; le banc 6 reste dans l'hebdo.
const now = new Date('2026-11-15T22:00:00Z');
const meca = (bancs: string[]) => JSON.stringify({ date: '2026-11-15T21:00:00Z', empreinte: 'e1', candidat: 'cadence-run', reference: 'A', modele_candidat: 'opus',
  bancs, hebdo: false, frais: 0, vert: true, rouges: [], niveau: 'mecanique' });
const racine = (h: string[] = []) => {
  const r = dossierTemp('banc7-l739-');
  for (const id of ['1-ol-companion-L239', '2-ol-companion-L248', '3-ol-companion-L241', '6-ol-companion-L167', '7-ol-companion-L160', '8-maritime-atlas-B68'])
    mkdirSync(join(r, 'bancs', id), { recursive: true });
  writeFileSync(join(r, 'bras.yaml'), 'A:\n  modele: opus\n  brief: b\ncadence-run:\n  modele: opus\n  brief: b\n');
  writeFileSync(join(r, 'historique.jsonl'), h.map((x) => `${x}\n`).join(''));
  return r;
};

describe('L739 : le banc 7 remplace le banc 6 dans le court et le mécanique', () => {
  it('les bancs du court sont 1, 3 et 7, et leur libellé suit la constante', () => {
    expect(BANCS_COURT).toEqual(['1', '3', '7']);
    expect(LIBELLE_COURT).toBe('1, 3 et 7');
  });
  it('mécanique et court jouent 1, 3 et 7 ; l\'hebdo garde le banc 6 ; micro et éclair, le banc 1', () => {
    const r = racine();
    expect(listerBancs(r, SOUS.mecanique.numeros)).toEqual(['1-ol-companion-L239', '3-ol-companion-L241', '7-ol-companion-L160']);
    expect(listerBancs(r, SOUS.court.numeros)).toEqual(['1-ol-companion-L239', '3-ol-companion-L241', '7-ol-companion-L160']);
    expect(listerBancs(r, SOUS.hebdo.numeros)).toContain('6-ol-companion-L167');
    expect(SOUS.micro.numeros).toEqual(['1']);
    expect(SOUS.eclair.numeros).toEqual(['1']);
  });
  it('le banc complet ne remesure le bruit que parmi 1, 3 et 7', () => {
    expect(numerosARemesurer(racine(), now).every((n) => BANCS_COURT.includes(n))).toBe(true);
  });
  it('la garde : un mécanique vert sur 1, 3 et 7 permet la publication, un mécanique sur 1, 3 et 6 non', () => {
    const st = (h: string[]) => statut(h, now, 'e1', { 'cadence-run': 'opus', A: 'opus' }, PUBLIE).publication_ok;
    expect(st([meca(['1-a', '3-b', '7-c'])])).toBe(true);
    expect(st([meca(['1-a', '3-b', '6-c'])])).toBe(false);
  });
  it('verifier-publication nomme les bancs 1, 3 et 7 quand il refuse', async () => {
    const r = racine([meca(['1-a', '3-b', '6-c'])]), io = { ...ioTest({ BENCH_ROOT: r, HOME: r }), now: () => now };
    expect(await bench(['verifier-publication'], io, '/depot')).toBe(1);
    expect(io.sortie.join('\n')).toMatch(/il faut le dernier banc mécanique \(1, 3 et 7\) vert/);
  });
  it('docs/v2/banc.md donne 1, 3 et 7 pour le mécanique et le court, et le banc 6 dans l\'hebdo seulement', () => {
    const doc = readFileSync(join(import.meta.dirname, '..', '..', 'docs', 'v2', 'banc.md'), 'utf8');
    expect(doc).toMatch(/\| mécanique \| `cadence2 bench mecanique` \| 1, 3 et 7, en parallèle \|/);
    expect(doc).toMatch(/`cadence2 bench court` \| bancs 1, 3 et 7 l'un après l'autre/);
    expect(doc).not.toMatch(/1, 3 et 6/);
  });
});
