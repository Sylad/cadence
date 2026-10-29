import { describe, expect, it } from 'vitest';
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
