import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';

// L166 : la fiche d'écran donnée en exemple dans la spec de l'étape spec doit respecter les invariants que la spec énonce.
const SPECS = join(__dirname, '..', 'docs', 'superpowers', 'specs');
const fiche = parse(readFileSync(join(SPECS, '2026-10-10-etape-spec-fiche-exemple.yaml'), 'utf8')) as any;
const spec = readFileSync(join(SPECS, '2026-10-10-etape-spec-design.md'), 'utf8');

describe('fiche d\'écran de l\'exemple (L166)', () => {
  it('déclare l\'écran, ses largeurs de rendu et ses états', () => {
    expect(fiche.ecran.route).toMatch(/^\//);
    expect(fiche.ecran.largeurs).toEqual([1440, 390]);
    expect(fiche.etats).toEqual(expect.arrayContaining(['vide', 'chargement', 'erreur']));
  });

  it('donne à chaque champ un id unique, un libellé, un type, une source et un caractère obligatoire', () => {
    const ids = fiche.champs.map((c: any) => c.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const c of fiche.champs) {
      expect(c.id).toMatch(/^[a-z][a-z0-9-]*$/);
      for (const k of ['libelle', 'type', 'source']) expect(typeof c[k]).toBe('string');
      expect(typeof c.obligatoire).toBe('boolean');
    }
  });

  it('numérote les règles R1… dans l\'ordre, chacune avec un message et un statut sourcée ou hypothèse', () => {
    fiche.regles.forEach((r: any, i: number) => {
      expect(r.id).toBe(`R${i + 1}`);
      expect(typeof r.enonce).toBe('string');
      expect(r.message === null || typeof r.message === 'string').toBe(true); // null : la règle n'a aucun texte à l'écran
      expect(['sourcee', 'hypothese']).toContain(r.statut);
      // une règle sourcée dit d'où elle vient ; une hypothèse dit ce qui la ferait changer
      expect(typeof (r.statut === 'sourcee' ? r.source : r.si_faux)).toBe('string');
    });
  });

  it('ne cite dans les règles et les actions que des champs et des règles qui existent', () => {
    const champs = new Set(fiche.champs.map((c: any) => c.id));
    const regles = new Set(fiche.regles.map((r: any) => r.id));
    for (const r of fiche.regles) for (const c of r.champs ?? []) expect(champs.has(c)).toBe(true);
    for (const a of fiche.actions) {
      expect(a.appel).toMatch(/^(GET|POST|PUT|PATCH|DELETE) \/\S+/);
      if (a.declencheur) expect(champs.has(a.declencheur)).toBe(true);
      for (const r of a.regles ?? []) expect(regles.has(r)).toBe(true);
    }
  });

  it('couvre chaque règle par au moins un test d\'acceptation prévu, nommé d\'après elle', () => {
    for (const r of fiche.regles) expect(r.tests?.length).toBeGreaterThan(0);
    for (const r of fiche.regles) for (const t of r.tests) expect(t).toMatch(new RegExp(`^${r.id} — `));
  });

  it('contient au moins une hypothèse, que la spec fait remonter dans l\'entrée Nouveautés', () => {
    expect(fiche.regles.some((r: any) => r.statut === 'hypothese')).toBe(true);
    expect(spec).toMatch(/Hypothèses/);
  });
});
