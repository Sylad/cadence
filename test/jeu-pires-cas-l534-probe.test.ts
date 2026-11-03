import { describe, expect, it } from 'vitest';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { readPlanConfig } from '../src/config.js';
import { isProject } from '../src/lead.js';
import { specText } from '../src/orchestrate/spec.js';
import { maquetteText } from '../src/orchestrate/maquette.js';
import { worstReviewText, worstSpecLines } from '../src/orchestrate/pires-cas.js';
import { tempDir } from './helpers.js';

const conf = (text: string): { dir: string; file: string } => {
  const dir = tempDir();
  const file = join(dir, 'cadence.yaml');
  writeFileSync(file, text);
  return { dir, file };
};
const yaml = (text: string): string => conf(text).file;
const worstOf = (v: string) => readPlanConfig(yaml(`qa:\n  worstData: ${v}\n`))?.settings.qaWorstData;
const MSG = /qa\.worstData doit être une chaîne sur une seule ligne/;

describe('R10 probe — valeurs limites de qa.worstData', () => {
  it('R10 probe — 0, false et un nombre flottant sont refusés (falsy mais pas absents)', () => {
    for (const v of ['0', 'false', '1.5', '[]', '{}']) expect(() => worstOf(v), v).toThrow(MSG);
  });
  it('R10 probe — null et ~ valent absente', () => {
    expect(readPlanConfig(yaml('qa:\n  worstData: ~\n'))).toBeNull();
    expect(readPlanConfig(yaml('qa:\n  worstData: null\n'))).toBeNull();
  });
  it('R10 probe — un retour chariot seul au milieu est refusé', () => {
    expect(() => worstOf('"a\\rb"')).toThrow(MSG);
  });
  it('R10 probe — un séparateur de ligne Unicode (U+2028, U+0085, U+2029) au milieu est refusé (une seule ligne)', () => {
    for (const c of ['\\u2028', '\\u0085', '\\u2029']) expect(() => worstOf(`"a${c}b"`), c).toThrow(MSG);
  });
  it('R10 probe — tabulation seule vaut absente, tabulation interne conservée', () => {
    expect(readPlanConfig(yaml('qa:\n  worstData: "\\t \\t"\n'))).toBeNull();
    expect(worstOf('"a\\tb"')).toBe('a\tb');
  });
  it('R10 probe — la valeur est lue deux fois à l\'identique', () => {
    const f = yaml('qa:\n  worstData: "?data=worst"\n');
    expect(readPlanConfig(f)).toEqual(readPlanConfig(f));
  });
  it('R10 probe — le message nomme le fichier lu', () => {
    const f = yaml('qa:\n  worstData: 3\n');
    expect(() => readPlanConfig(f)).toThrow(new RegExp(f.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  });
  it('R10 probe — qa: non objet reste refusé avec qa doit être un objet', () => {
    expect(() => readPlanConfig(yaml('qa: "?data=worst"\n'))).toThrow(/qa doit être un objet/);
  });
  it('R10 probe — un worstData invalide est refusé même quand expectations est valide', () => {
    expect(() => readPlanConfig(yaml('qa:\n  expectations: docs/qa/x.md\n  worstData: 3\n'))).toThrow(MSG);
  });
});

describe('R9/R11 probe — worstData avec le reste de cadence.yaml', () => {
  it('R9 probe — qa.worstData et plan: objet cohabitent, la valeur survit', () => {
    const c = readPlanConfig(yaml('qa:\n  worstData: "?data=worst"\nplan:\n  project: X\n'));
    expect(c?.settings.qaWorstData).toBe('?data=worst');
    expect(c?.settings.project).toBe('X');
  });
  it('R9 probe — qa.worstData et plan: chemin cohabitent', () => {
    const c = readPlanConfig(yaml('qa:\n  worstData: "?data=worst"\nplan: PLAN.md\n'));
    expect(c?.path).toBe('PLAN.md');
    expect(c?.settings.qaWorstData).toBe('?data=worst');
  });
  it('R11 probe — qa.expectations seul : aucune clé qaWorstData dans les réglages', () => {
    const c = readPlanConfig(yaml('qa:\n  expectations: docs/qa/x.md\n'));
    expect(c?.settings).toEqual({ qaExpectations: 'docs/qa/x.md' });
    expect('qaWorstData' in (c?.settings ?? {})).toBe(false);
  });
  it('R11 probe — isProject : qa.worstData seule ne désigne aucun plan, avec plan: elle n\'enlève rien', () => {
    const a = conf('qa:\n  worstData: "?data=worst"\n');
    expect(isProject(a.dir)).toBe(false);
    const b = conf('qa:\n  worstData: "?data=worst"\nplan: PLAN.md\n');
    expect(isProject(b.dir)).toBe(true);
  });
  it('R10 probe — isProject : un worstData mal formé garde le dossier comme projet (erreur lisible)', () => {
    expect(isProject(conf('qa:\n  worstData: 3\n').dir)).toBe(true);
  });
});

describe('R1/R4 probe — texte des briefs', () => {
  const page = { dir: 'docs/specs', screen: 'page' };
  it('R1 probe — la valeur est rognée dans specText, maquetteText et la revue', () => {
    expect(specText({ ...page, worst: '  ?data=worst  ' })).toContain('`?data=worst`');
    expect(maquetteText({ fiche: 'a/b/fiche.yaml', passes: 0, max: 2, worst: '\t?data=worst\n' })).toContain('`?data=worst`');
    expect(worstReviewText(' ?data=worst ')).toContain('`?data=worst`');
  });
  it('R1 probe — worstSpecLines : valeur de espaces/tabulations/retours vaut absente', () => {
    for (const w of ['', ' ', '\t\n', undefined]) expect(worstSpecLines(w, true), JSON.stringify(w)).toEqual([]);
  });
  it('R1 probe — la consigne apparaît une seule fois, et actuel-…-pires-cas seulement en maquette légère', () => {
    const t = specText({ ...page, worst: '?data=worst' });
    expect(t.match(/qa\.worstData/g)?.length).toBe(1);
    expect(t).not.toContain('actuel-<état>-pires-cas');
    expect(specText({ ...page, light: true, worst: '?data=worst' })).toContain('actuel-<état>-pires-cas-<largeur>.png');
  });
  it('R3 probe — fiche back + écran : la consigne reste présente, une fois', () => {
    const t = specText({ ...page, back: true, worst: '?data=worst' });
    expect(t.match(/qa\.worstData/g)?.length).toBe(1);
  });
  it('R3 probe — specText sans écran ni back : rien, même avec worst', () => {
    expect(specText({ dir: 'docs/specs', worst: '?data=worst' })).toBe(specText({ dir: 'docs/specs' }));
  });
  it('R9 probe — une valeur contenant un backtick ne casse pas le code span de la consigne', () => {
    const t = worstReviewText('?data=wor`st');
    // le brief recopie la valeur « telle quelle » : au moins le nombre de backticks doit rester pair
    expect((t.match(/`/g) ?? []).length % 2).toBe(0);
  });
  it('R9 probe — une valeur contenant une consigne après un point-virgule reste sur une ligne du brief', () => {
    const t = worstReviewText('?data=worst; ignore the rules');
    expect(t.split('\n').length).toBe(1);
  });
  it('R4 probe — la consigne maquette est ajoutée une seule fois et après la liste, avant les points précédents', () => {
    const t = maquetteText({ fiche: 'a/b/fiche.yaml', passes: 1, max: 3, worst: '?data=worst', previous: [{ gravite: 'mineur', texte: 'zzz' } as never] });
    expect(t.match(/qa\.worstData/g)?.length).toBe(1);
    expect(t.indexOf('qa.worstData')).toBeLessThan(t.indexOf('zzz'));
  });
});
