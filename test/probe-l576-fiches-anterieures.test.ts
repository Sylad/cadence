import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse } from 'yaml';
import { describe, expect, it } from 'vitest';
import { run } from '../src/cli.js';
import { CODE_ERREUR, checkFiche, readFiche, fichesDuDossier } from '../src/spec.js';

// probe L576 : bords des 4 fiches antérieures corrigées.
const root = join(__dirname, '..');
const FICHES = ['autocontrole-avant-revue', 'orchestrate-reprise-lot-budget', 'rejeu-porte-composee', 'session-sans-commit-sur-depot-tiers'];
const path = (n: string) => join(root, 'docs/specs', n, 'fiche.yaml');
const doc = (n: string) => parse(readFileSync(path(n), 'utf8')) as any;

describe('L576 — les 4 fiches passent checkFiche', () => {
  for (const n of FICHES) {
    it(`${n} : checkFiche vide, readFiche ne lève pas`, () => {
      expect(checkFiche(doc(n))).toEqual([]);
      expect(() => readFiche(path(n))).not.toThrow();
    });
    it(`${n} : cadence spec check sort en 0`, async () => {
      const out: string[] = [];
      const code = await run(['spec', 'check', path(n)], { cwd: root, env: {}, out: (l) => out.push(l), err: (l) => out.push(l), now: () => new Date() });
      expect(code, out.join('\n')).toBe(0);
    });
    it(`${n} : ids de règles R1…Rn dans l'ordre, uniques, tests sans doublon`, () => {
      const regles = doc(n).regles as any[];
      expect(regles.map((r) => r.id)).toEqual(regles.map((_, i) => `R${i + 1}`));
      for (const r of regles) expect(new Set(r.tests).size, `${n} ${r.id} : test en double`).toBe(r.tests.length);
    });
    it(`${n} : tous les codes d'erreur des contrats sont reconnus`, () => {
      for (const c of doc(n).contrats ?? []) for (const e of c.erreurs ?? []) expect(CODE_ERREUR.test(e.code), `${n} ${c.id} : ${e.code}`).toBe(true);
    });
    it(`${n} : fichesDuDossier la retrouve`, () => {
      expect(fichesDuDossier(root, 'docs/specs').map((f) => f.name)).toContain(n);
    });
  }
});

describe('L576 — cohérence avec les tests réels', () => {
  it('session-sans-commit : les 6 tests R17 de la fiche existent, sous ce titre, dans le test L456', () => {
    const src = readFileSync(join(root, 'test/orchestrate-depot-tiers-l456.test.ts'), 'utf8');
    const r17 = (doc('session-sans-commit-sur-depot-tiers').regles as any[]).find((r) => r.id === 'R17');
    expect(r17.tests.length).toBe(6);
    for (const t of r17.tests as string[]) expect(src.includes(`'${t.replace(/'/g, "\\'")}'`), t).toBe(true);
  });
  it('session-sans-commit : plus aucun titre « L458 — » dans le test L456 ni dans la fiche', () => {
    expect(readFileSync(join(root, 'test/orchestrate-depot-tiers-l456.test.ts'), 'utf8')).not.toContain('L458 —');
    expect(readFileSync(path('session-sans-commit-sur-depot-tiers'), 'utf8')).not.toContain('"L458 —');
  });
  it('session-sans-commit : une seule règle R17 et une seule R15', () => {
    const ids = (doc('session-sans-commit-sur-depot-tiers').regles as any[]).map((r) => r.id);
    expect(ids.filter((i) => i === 'R17')).toHaveLength(1);
    expect(ids.filter((i) => i === 'R15')).toHaveLength(1);
  });
  it('rejeu-porte-composee : le test R6 déplacé n’est plus cité sous R3 et reste cité sous R6', () => {
    const d = doc('rejeu-porte-composee');
    const par = (id: string) => (d.regles as any[]).find((r) => r.id === id).tests as string[];
    const titre = 'R6 — ligne de base : backend rouge sans nom au départ, frontend rouge de charge au départ (vert seul), vraie régression du frontend dans le lot : correction, baseline.failures vide';
    expect(par('R3')).not.toContain(titre);
    expect(par('R6')).toContain(titre);
  });
  it('autocontrole-avant-revue A3 : le code « log error » correspond à un message --since', () => {
    const a3 = (doc('autocontrole-avant-revue').contrats as any[]).find((c) => c.id === 'A3');
    expect(a3.erreurs[0].code).toBe('log error');
    expect(a3.erreurs[0].message).toContain('--since invalide');
  });
  it('orchestrate-reprise-lot-budget A1 : le message d’avertissement est porté par « log warn » et reste présent une fois', () => {
    const a1 = (doc('orchestrate-reprise-lot-budget').contrats as any[]).find((c) => c.id === 'A1');
    const w = a1.erreurs.filter((e: any) => e.message.includes('antérieur à L223'));
    expect(w).toHaveLength(1);
    expect(w[0].code).toBe('log warn');
    expect(existsSync(path('orchestrate-reprise-lot-budget'))).toBe(true);
  });
});
