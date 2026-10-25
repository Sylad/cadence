import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { renderBrief } from '../src/orchestrate/briefs.js';
import { WORK_SCHEMA } from '../src/orchestrate/schemas.js';

const read = (p: string) => readFileSync(fileURLToPath(new URL(p, import.meta.url)), 'utf8');
const vars = { chemin: '/r/p', lot: 'L9', titre: 'Un titre', objectif: 'faire X', commits: 'c1', reponse: '', constats: 'un constat', ux: '', choix: '', checks: '', news: '', captures: '', fiche: '', repos: '' };
const TITRE = 'Auto-verification once the tests are green';
/** Le bloc d'auto-vérification : de son titre à la fin de la ligne vide qui le suit. */
const bloc = (kind: 'implement' | 'fix'): string => {
  const out = renderBrief(kind, vars);
  const i = out.indexOf(TITRE);
  expect(i, `${kind} porte le bloc`).toBeGreaterThanOrEqual(0);
  return out.slice(i).split('\n\n')[0]!;
};

describe('auto-vérification en fin de session (L236)', () => {
  it('R1 — le brief implement impose, une fois les tests verts, la relecture du diff complet du lot', () => {
    const b = bloc('implement');
    expect(b).toContain('full test suite');
    expect(b).toContain('complete diff of the lot');
    expect(b).toContain('before the review');
  });

  it('R1b — le diff du lot se relit commit par commit (raf commits + git show), jamais par une plage git diff qui avale les autres lots', () => {
    const b = bloc('implement');
    expect(b).toContain('raf commits L9');
    expect(b).toContain('git show');
    expect(b).not.toContain('git diff <parent');
  });

  it('R2 — le bloc nomme la grille du code-reviewer : bug de code, dérive d\'architecture, docs/architecture.md, cas limites, un test par comportement changé', () => {
    const b = bloc('implement');
    expect(b).toContain('code-reviewer');
    for (const mot of ['code bug', 'architecture drift', 'docs/architecture.md', 'edge cases', 'one test per changed behaviour']) expect(b, mot).toContain(mot);
  });

  it('R3 — le bloc impose la correction immédiate, puis de rejouer la suite', () => {
    const b = bloc('implement');
    expect(b).toContain('fix it at once');
    expect(b).toContain('rerun');
  });

  it('R4 — le bloc demande un paragraphe « auto-vérification » dans le résumé du rapport, sans nouveau champ', () => {
    const b = bloc('implement');
    expect(b).toContain('« auto-vérification »');
    expect(b).toContain('"resume"');
    const avant = ['commits', 'tests', 'build', 'nonVerifie', 'questions', 'choix', 'echecsDeBase', 'nouveauxEchecs', 'resume'];
    expect(Object.keys(WORK_SCHEMA.properties).sort()).toEqual([...avant].sort());
  });

  it('R5 — l\'auto-vérification ne coûte pas une passe de revue : une seule lecture du diff, pas de sous-agent ni de relecture de fichiers hors diff', () => {
    const b = bloc('implement');
    expect(b).toContain('one reading of the diff');
    expect(b).toContain('not a second review');
    expect(b).toContain('files the diff does not touch');
  });

  it('R6 — le brief fix porte le bloc, borné à ses propres commits de correction, et garde « nothing else »', () => {
    const b = bloc('fix');
    for (const mot of ['complete diff', 'code-reviewer', '« auto-vérification »', 'one reading of the diff']) expect(b, mot).toContain(mot);
    expect(b).toContain('fix commits');
    expect(renderBrief('fix', vars)).toContain('fix them, and nothing else');
  });

  it('R6b — le brief fix relit aussi les commits de correction faits dans un dépôt voisin, avec la même plage', () => {
    const b = bloc('fix');
    expect(b).toContain('each repository where you committed a fix');
    expect(b).toContain('neighbouring');
  });

  it('R7 — les autres briefs (fix-minors, spec, spec-back, accept, review-small) n\'ont pas le bloc', () => {
    for (const kind of ['fix-minors', 'spec', 'spec-back', 'accept', 'review-small']) {
      expect(read(`../templates/orchestrate/${kind}.md`), kind).not.toContain(TITRE);
    }
  });

  it('R8 — docs/orchestrate.md, le README et le CHANGELOG décrivent l\'auto-vérification (L236)', () => {
    expect(read('../docs/orchestrate.md')).toMatch(/Auto-verification once the tests are green \(L236\)/);
    expect(read('../docs/overview.md')).toContain('L236'); // le détail est parti du README (L326)
    expect(read('../CHANGELOG.md')).toMatch(/auto-verification[^\n]*\(L236[,)]/i);
  });

  it('R9 — le README et le CHANGELOG disent que fix ne relit que ses commits de correction', () => {
    const readme = read('../docs/overview.md').split('\n').find((l) => l.includes('**auto-verification**'))!;
    expect(readme).toContain('of its fix commits, in `fix`');
    const log = read('../CHANGELOG.md').split('\n').find((l) => /^- Auto-verification at the end/.test(l))!;
    expect(log).toContain('of its fix commits, in `fix`');
  });
});
