import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { TEMPLATES_DIR, objective, renderBrief } from '../src/orchestrate/briefs.js';
import { WORK_SCHEMA, REVIEW_SCHEMA, checkShape } from '../src/orchestrate/schemas.js';
import type { Lot } from '../src/plan.js';

const read = (p: string) => readFileSync(fileURLToPath(new URL(p, import.meta.url)), 'utf8');
const lot = (extra: Partial<Lot> = {}): Lot => ({
  id: 'L9', title: 'Un titre', status: 'doing', estimate: 1, quickwin: false, visible: false, after: [], notes: [{ date: '2026-10-04', text: 'décision A' }], tasks: [{ id: 'L9/t1', title: 'sous-tâche', status: 'todo' }], problems: [], ...extra,
});

describe('gabarits', () => {
  const vars = { chemin: '/r/p', lot: 'L9', titre: 'Un titre', objectif: 'faire X', commits: '', reponse: '', constats: '', ux: '' };

  it('implement.md est le brief du lead (§2) plus deux lignes, rendu sans accolades restantes', () => {
    const out = renderBrief('implement', vars);
    expect(out).toContain('Work in `/r/p` on lot `L9` — "Un titre" — of its plan');
    expect(out).toContain('read the lot, its notes and sub-tasks, and the project\'s CLAUDE.md first');
    expect(out).toContain('Goal: faire X');
    expect(out).toContain('test first; commit each sub-part as soon as its tests pass, with explicit paths (never');
    expect(out).toContain('`git add -A` or `commit -a`), and a message that cites the lot (`feat(L9): …`)');
    expect(out).toContain('do not push, deliver, run `raf done`, `raf ux` or');
    expect(out).toContain('If something is ambiguous or needs a decision, stop and report the question instead of guessing.');
    expect(out).toContain('Report: commits (sha + subject), tests and build results with their numbers, what you could not');
    expect(out).toContain('do not launch subagents');
    expect(out).toContain('structured output');
    expect(out).not.toMatch(/\{\{/);
    expect(out).not.toMatch(/\n{3,}/);
  });

  it('les revues ne reçoivent ni rapport d\'auteur ni liste de commits : dépôt et lot seulement', () => {
    const out = renderBrief('review', { ...vars, commits: 'abc1234 feat(L9): x', reponse: 'une réponse' });
    expect(out).toContain('`/r/p`');
    expect(out).toContain('lot `L9`');
    expect(out).not.toContain('abc1234');
    expect(out).not.toContain('une réponse');
    expect(out).toContain('read-only');
  });

  it('le brief de passe unique porte la grille UX et la consigne d\'URL', () => {
    const out = renderBrief('review-small', { ...vars, ux: 'App: http://localhost:4200' });
    expect(out).toContain('single pass');
    expect(out).toContain('http://localhost:4200');
  });

  it('fix.md liste les constats et les commits du lot', () => {
    const out = renderBrief('fix', { ...vars, constats: '- [majeur] a.ts:3 — bug', commits: '- abc1234 feat(L9): x' });
    expect(out).toContain('- [majeur] a.ts:3 — bug');
    expect(out).toContain('- abc1234 feat(L9): x');
    expect(out).toContain('fix(L9): …');
  });

  it('reprise et réponse sont ajoutées à l\'implémentation quand elles existent', () => {
    const out = renderBrief('implement', { ...vars, commits: 'A previous session was interrupted.', reponse: 'Answer: oui' });
    expect(out).toContain('A previous session was interrupted.');
    expect(out).toContain('Answer: oui');
  });

  it('l\'objectif vient du titre et des notes du lot', () => {
    const o = objective(lot());
    expect(o).toContain('Un titre');
    expect(o).toContain('2026-10-04: décision A');
    expect(o).toContain('L9/t1');
  });

  it('un marqueur inconnu est une erreur, jamais un trou silencieux', () => {
    expect(() => renderBrief('implement', { ...vars, chemin: undefined as unknown as string })).toThrow(/chemin/);
  });
});

describe('skill lead : source unique', () => {
  it('renvoie au gabarit au lieu d\'en garder une copie', () => {
    const skill = read('../skills/lead/SKILL.md');
    expect(skill).toContain('templates/orchestrate/implement.md');
    expect(skill).not.toContain('Rules: test first');
    expect(skill).toContain('cadence orchestrate');
  });
  it('le dossier de gabarits est celui du paquet', () => {
    expect(TEMPLATES_DIR.endsWith('/templates/orchestrate')).toBe(true);
    expect(JSON.parse(read('../package.json')).files).toContain('templates');
  });
});

describe('schémas', () => {
  it('une sortie à champ absent ou mal typé est refusée', () => {
    const ok = { commits: [], tests: { commande: 'x', resultat: 'y', vert: true }, build: { commande: 'x', resultat: 'y', vert: true }, nonVerifie: [], questions: [], resume: 'r' };
    expect(checkShape(ok, WORK_SCHEMA)).toBe(ok);
    expect(() => checkShape({ ...ok, questions: undefined }, WORK_SCHEMA)).toThrow(/questions/);
    expect(() => checkShape({ ...ok, resume: 3 }, WORK_SCHEMA)).toThrow(/resume/);
    expect(() => checkShape({ bloquants: 0 }, REVIEW_SCHEMA)).toThrow(/majeurs/);
  });
});
