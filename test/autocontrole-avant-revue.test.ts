import { describe, expect, it } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { renderBrief } from '../src/orchestrate/briefs.js';
import { WORK_SCHEMA } from '../src/orchestrate/schemas.js';

const read = (p: string) => readFileSync(fileURLToPath(new URL(p, import.meta.url)), 'utf8');
const vars = { chemin: '/r/p', lot: 'L9', titre: 'Un titre', objectif: 'faire X', commits: 'c1', reponse: '', constats: 'un constat', ux: '', choix: '', checks: '', news: '', captures: '', fiche: '', repos: '' };
const LISTE = 'Self-check before handing back';
/** La liste d'auto-contrôle : de son titre à la fin de la ligne vide qui la suit. */
const liste = (kind: 'implement' | 'fix'): string => {
  const out = renderBrief(kind, vars);
  const i = out.indexOf(LISTE);
  expect(i, `${kind} porte la liste`).toBeGreaterThanOrEqual(0);
  return out.slice(i).split('\n\n')[0]!;
};

describe('auto-contrôle avant revue (L222)', () => {
  it('R1 — le brief implement cite README et la documentation d\'architecture dans la liste d\'auto-contrôle', () => {
    const l = liste('implement');
    expect(l).toContain('README');
    expect(l).toContain('architecture');
    expect(l).toContain('same commits');
  });

  it('R2 — le brief implement demande un test nommé Rn par règle de la fiche', () => {
    const l = liste('implement');
    expect(l).toContain('« Rn — … »');
    expect(l).toContain('one test per rule of the fiche');
    expect(l).toContain('no fiche');
    expect(l).toContain('one test per business rule of the lot');
  });

  it('R3 — le brief implement interdit le code mort et le test qui ne peut pas échouer', () => {
    const l = liste('implement');
    expect(l).toContain('no dead code');
    expect(l).toContain('no test that cannot fail');
    expect(l).toContain('always true');
  });

  it('R4 — le brief implement demande la capture d\'un écran modifié, nom de fichier relatif', () => {
    const l = liste('implement');
    expect(l).toContain('modified screen');
    expect(l).toContain('1440 and 390 px');
    expect(l).toContain('relative file name');
    expect(l).toContain('no modified screen');
  });

  it('R5 — le brief implement interdit le commentaire faux', () => {
    const l = liste('implement');
    expect(l).toContain('no false comment');
    expect(l).toContain('docstring');
    expect(l).toContain('no longer has');
  });

  it('R6 — le brief implement demande de vérifier la liste avant de rendre et d\'écrire les points non tenus', () => {
    const l = liste('implement');
    expect(l).toContain('Go through this list point by point on your own commits before you report');
    expect(l).toContain('"choix" or "nonVerifie"');
  });

  it('R6 — le schéma du rapport implement n\'a pas de nouveau champ', () => {
    // liste des champs de schemas.ts avant L222 (comparaison explicite à celle d'avant le lot)
    const avant = ['commits', 'tests', 'build', 'nonVerifie', 'questions', 'choix', 'echecsDeBase', 'nouveauxEchecs', 'resume'];
    expect(Object.keys(WORK_SCHEMA.properties).sort()).toEqual([...avant].sort());
  });

  it('R7 — le brief fix porte la liste d\'auto-contrôle et garde « nothing else »', () => {
    const out = renderBrief('fix', vars);
    const l = liste('fix');
    for (const mot of ['README', 'no dead code', 'no test that cannot fail', 'no false comment', 'modified screen']) expect(l, mot).toContain(mot);
    expect(l).toContain('only what you changed');
    expect(out).toContain('fix them, and nothing else');
  });

  it('R8 — implement et fix se rendent sans accolade restante avec les variables existantes', () => {
    for (const kind of ['implement', 'fix'] as const) {
      const out = renderBrief(kind, vars);
      expect(out, kind).not.toMatch(/\{\{|\}\}/);
      expect(liste(kind), kind).not.toContain('{');
    }
  });

  it('R8 — fix-minors, spec, spec-back, accept et review-small n\'ont pas la liste', () => {
    for (const kind of ['fix-minors', 'spec', 'spec-back', 'accept', 'review-small'] as const) {
      let out = '';
      try { out = renderBrief(kind, vars); } catch { /* variable propre au gabarit absente : le gabarit lui-même est lu ci-dessous */ }
      expect(out, kind).not.toContain(LISTE);
      const fichier = kind;
      expect(read(`../templates/orchestrate/${fichier}.md`), kind).not.toContain(LISTE);
    }
  });

  it('R9 — le README renvoie au document de mesure avant/après de L222', () => {
    const doc = 'docs/mesures/autocontrole-avant-revue-2026-10-15.md';
    expect(read('../README.md')).toContain(doc);
    expect(existsSync(fileURLToPath(new URL(`../${doc}`, import.meta.url)))).toBe(true);
  });

  it('R9 — le document de mesure borne l\'avant à la mise en service de la liste et calcule l\'après par différence', () => {
    const doc = read('../docs/mesures/autocontrole-avant-revue-2026-10-15.md');
    expect(doc).toContain('--until <borne>');
    expect(doc).toContain('npm run service');
    expect(doc).not.toMatch(/--until 2026-10-15T17:19Z/);
    expect(doc).not.toMatch(/en service à partir du/);
    expect(doc).not.toContain('--until 2026-10-15T00:00Z');
    expect(doc).not.toMatch(/sans borne\)/);
    expect(doc).toMatch(/différence/);
    expect(doc).not.toMatch(/lot par lot/);
    expect(doc).not.toMatch(/« doc »/);
    expect(doc).toContain("dérive d'architecture");
    expect(doc).not.toContain('263 lots');
  });

  it('R9 — l\'aide de cadence corrections (src/cli.ts:65) et son message d\'usage (src/cli.ts:851) ne citent pas --since, la commande reste inchangée', () => {
    const cli = read('../src/cli.ts').split('\n');
    const aide = cli.find((l) => /^\s*cadence corrections \[dossier\]/.test(l));
    const usage = cli.find((l) => l.includes("'usage : cadence corrections"));
    expect(aide, 'ligne d\'aide trouvée').toBeDefined();
    expect(usage, 'message d\'usage trouvé').toBeDefined();
    expect(aide).not.toContain('--since');
    expect(usage).not.toContain('--since');
    expect(aide).toContain('--until date');
  });
});
