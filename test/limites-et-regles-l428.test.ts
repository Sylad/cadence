import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { renderBrief } from '../src/orchestrate/briefs.js';

const vars = { chemin: '/r/p', lot: 'L9', titre: 'Un titre', objectif: 'faire X', commits: 'c1', reponse: '', constats: 'un constat', ux: '', choix: '', checks: '', news: '', captures: '', fiche: '', repos: '' };
const TITRE = 'Limits and rules, before the walkthrough';
/** Le bloc : de son titre à la ligne vide qui le suit. */
const bloc = (kind: 'implement' | 'fix' = 'implement'): string => {
  const out = renderBrief(kind, vars);
  const i = out.indexOf(TITRE);
  expect(i, `${kind} porte le bloc`).toBeGreaterThanOrEqual(0);
  return out.slice(i).split('\n\n')[0]!;
};

describe('goulot « bug de code » : relecture contre la fiche et les règles, cas limites testés (L428)', () => {
  it('R1 — le brief implement porte le bloc, après la liste d\'auto-contrôle et avant le parcours réel', () => {
    const out = renderBrief('implement', vars);
    expect(out.indexOf('Self-check before handing back')).toBeLessThan(out.indexOf(TITRE));
    expect(out.indexOf(TITRE)).toBeLessThan(out.indexOf('Real walkthrough'));
  });

  it('R2 — chaque règle de la fiche ou du lot a un test qui échoue si le code la casse, et la ligne qui la tient', () => {
    const b = bloc();
    expect(b).toContain('each rule of the fiche');
    expect(b).toContain('fails if the code breaks it');
    expect(b).toContain('a rule with no such pair is not done');
  });

  it('R3 — les cas limites de tout code ajouté ou changé sont énumérés puis testés avant de rendre', () => {
    const b = bloc();
    for (const mot of ['empty', 'absent', 'twice', 'wrong order', 'wrong type', 'refused', 'real shape of the data', 'the other callers']) expect(b, mot).toContain(mot);
    expect(b).toContain('a test that fails without your code');
    expect(b).toContain('"nonVerifie"');
  });

  it('R4 — chaque chiffre, « all », « never » ou « always » écrit en README, docs, commentaire ou test se vérifie contre le code', () => {
    const b = bloc();
    expect(b).toContain('« all », « never » or « always »');
    expect(b).toContain('by running it');
  });

  it('R5 — le bloc est propre à implement : les briefs fix et review ne le portent pas', () => {
    const fix = renderBrief('fix', vars);
    expect(fix).not.toContain(TITRE);
    expect(renderBrief('review', vars)).not.toContain(TITRE);
  });
});

describe('cas limites et fiche (L428, correction)', () => {
  it('R3 — avec une fiche, un cas limite que la fiche ne couvre pas est noté (nonVerifie ou choix), pas codé', () => {
    const fiche = 'a case the sheet does not cover is noted in your report (under "nonVerifie" or "choix"), not coded.';
    const out = renderBrief('implement', { ...vars, fiche });
    expect(out).toContain(fiche);
    const b = bloc();
    expect(b).toContain('except a case the fiche does not cover');
    expect(b).toContain('you do not code a rule it does not state');
    expect(b).toContain('neither coded nor tested');
  });
});

describe('documentation du point « cas limites » (L428, correction)', () => {
  const read = (p: string) => readFileSync(fileURLToPath(new URL(p, import.meta.url)), 'utf8');
  it('R6 — docs/orchestrate.md, la page de mesure et le CHANGELOG disent qu\'avec une fiche un cas limite qu\'elle ne couvre pas n\'est ni codé ni testé', () => {
    const orch = read('../docs/orchestrate.md');
    const l428 = orch.split('\n').find((l) => l.includes('Limits and rules before the walkthrough (L428)'));
    expect(l428, 'puce L428 de docs/orchestrate.md').toBeDefined();
    expect(l428).toContain('neither coded nor tested');
    expect(l428).toMatch(/except .*the fiche does not cover/);
    const regle = orch.split('\n').find((l) => l.includes('a case the sheet does not cover is written in the report'));
    expect(regle, 'règle « does not invent a rule » de docs/orchestrate.md').toBeDefined();
    expect(regle).toContain('not coded nor tested');
    const mesure = read('../docs/mesures/bug-code-2026-10-29.md');
    expect(mesure).toContain('ni codé ni testé');
    expect(mesure).toMatch(/sauf un cas que la fiche ne couvre pas/);
    const changelog = read('../CHANGELOG.md').split('\n').find((l) => l.includes('Limits and rules, before the walkthrough') && l.includes('L428'));
    expect(changelog, 'entrée L428 du CHANGELOG').toBeDefined();
    expect(changelog).toContain('neither coded nor tested');
  });
});
