import { mkdirSync, readdirSync, readFileSync, existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse } from 'yaml';
import { describe, expect, it } from 'vitest';
import { run } from '../src/cli.js';
import { checkFiche } from '../src/spec.js';
import { checkShape, REVIEW_SCHEMA } from '../src/orchestrate/schemas.js';
import { tempDir } from './helpers.js';

// probe L574 : bords des tests de comportement qui remplacent les empreintes.
const root = join(__dirname, '..');
const read = (f: string) => readFileSync(join(root, f), 'utf8');
const cli = async (args: string[], cwd = root) => {
  const out: string[] = [];
  const code = await run(args, { cwd, env: {}, out: (l) => out.push(l), err: (l) => out.push(l), now: () => new Date() });
  return { code, out: out.join('\n') };
};

describe('L574 — gabarit fiche.yaml', () => {
  it('le gabarit tel quel, copié dans docs/specs/<id>/, passe cadence spec check (code 0)', async () => {
    const d = tempDir();
    mkdirSync(join(d, 'docs/specs/mon-ecran'), { recursive: true });
    writeFileSync(join(d, 'docs/specs/mon-ecran/fiche.yaml'), read('templates/fiche.yaml'));
    writeFileSync(join(d, 'docs/specs/mon-ecran/maquette.html'), '<html></html>');
    const r = await cli(['spec', 'check', join(d, 'docs/specs/mon-ecran/fiche.yaml')], d);
    expect(r.out).not.toMatch(/ecran\.id|clé/);
  });
  it('checkFiche refuse null, vide, tableau, chaîne', () => {
    for (const v of [null, undefined, {}, [], 'x', 3]) expect(checkFiche(v).length, JSON.stringify(v)).toBeGreaterThan(0);
  });
  it('checkFiche refuse le gabarit privé d’une clé (chacune des cinq)', () => {
    for (const k of ['ecran', 'etats', 'champs', 'regles', 'actions']) {
      const doc = parse(read('templates/fiche.yaml')) as Record<string, unknown>;
      delete doc[k];
      expect(checkFiche(doc).length, k).toBeGreaterThan(0);
    }
  });
  it('le gabarit parse en un seul document, sans clé en double', () => {
    const t = read('templates/fiche.yaml');
    expect(() => parse(t, { uniqueKeys: true })).not.toThrow();
    expect(Object.keys(parse(t)).length).toBe(5);
  });
  it('le gabarit garde largeurs [1440, 390] et les trois états requis', () => {
    const doc = parse(read('templates/fiche.yaml'));
    expect(doc.ecran.largeurs).toEqual([1440, 390]);
    for (const e of ['vide', 'chargement', 'erreur']) expect(doc.etats).toContain(e);
  });
});

describe('L574 — fiches réelles du dépôt', () => {
  it('toutes les fiches de docs/specs passent checkFiche (forme réelle)', () => {
    const bad: string[] = [];
    for (const d of readdirSync(join(root, 'docs/specs'))) {
      const f = join(root, 'docs/specs', d, 'fiche.yaml');
      if (!existsSync(f)) continue;
      const e = checkFiche(parse(readFileSync(f, 'utf8')));
      if (e.length) bad.push(`${d}: ${e[0]}`);
    }
    expect(bad).toEqual([]);
  });
  it('une fiche valide, une règle supprimée du milieu (trou R1, R3) est refusée', () => {
    const doc = parse(read('templates/fiche.yaml')) as any;
    doc.regles[1].id = 'R3';
    expect(checkFiche(doc).length).toBeGreaterThan(0);
  });
  it('cadence spec check sur un fichier absent : code non nul, pas d’exception', async () => {
    const r = await cli(['spec', 'check', join(root, 'docs/specs/nope/fiche.yaml')]);
    expect(r.code).not.toBe(0);
  });
});

describe('L574 — REVIEW_SCHEMA / checkShape', () => {
  const ok = { bloquants: 0, majeurs: 0, mineurs: 0, constats: [], sousTaches: [], nonVerifie: [], verdict: 'conforme' };
  it('accepte un rapport vide valide', () => expect(() => checkShape(ok, REVIEW_SCHEMA)).not.toThrow());
  it('refuse null, tableau, chaîne', () => {
    for (const v of [null, [], 'x', 0]) expect(() => checkShape(v, REVIEW_SCHEMA), JSON.stringify(v)).toThrow(/objet attendu/);
  });
  it('refuse chaque champ requis absent', () => {
    for (const k of REVIEW_SCHEMA.required) {
      const o: any = { ...ok };
      delete o[k];
      expect(() => checkShape(o, REVIEW_SCHEMA), k).toThrow(new RegExp(k));
    }
  });
  it('refuse un type faux : bloquants chaîne, constats objet, verdict nombre', () => {
    expect(() => checkShape({ ...ok, bloquants: '0' }, REVIEW_SCHEMA)).toThrow(/mal typé/);
    expect(() => checkShape({ ...ok, constats: {} }, REVIEW_SCHEMA)).toThrow(/mal typé/);
    expect(() => checkShape({ ...ok, verdict: 1 }, REVIEW_SCHEMA)).toThrow(/mal typé/);
  });
  it('le schéma garde ses sept clés requises', () => {
    expect([...REVIEW_SCHEMA.required].sort()).toEqual(['bloquants', 'constats', 'majeurs', 'mineurs', 'nonVerifie', 'sousTaches', 'verdict']);
  });
});

describe('L574 — gabarits orchestrate', () => {
  it('ux.md et spec-back.md : aucun marqueur {{x}} dupliqué en forme cassée ({{ x }}, {x})', () => {
    for (const f of ['templates/orchestrate/ux.md', 'templates/orchestrate/spec-back.md']) {
      const t = read(f);
      expect(t, f).not.toMatch(/\{\{\s+\w+\s*\}\}|\{\{\w+\s+\}\}/);
      expect((t.match(/\{\{/g) ?? []).length, f).toBe((t.match(/\}\}/g) ?? []).length);
    }
  });
});
