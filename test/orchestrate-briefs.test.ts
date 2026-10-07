import { describe, expect, it } from 'vitest';
import { cpSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tempDir } from './helpers.js';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { TEMPLATES_DIR, loadTemplates, newsText, objective, renderBrief } from '../src/orchestrate/briefs.js';
import { WORK_SCHEMA, REVIEW_SCHEMA, checkShape } from '../src/orchestrate/schemas.js';
import type { Lot } from '../src/plan.js';

const read = (p: string) => readFileSync(fileURLToPath(new URL(p, import.meta.url)), 'utf8');
const lot = (extra: Partial<Lot> = {}): Lot => ({
  id: 'L9', title: 'Un titre', status: 'doing', estimate: 1, quickwin: false, visible: false, after: [], notes: [{ date: '2026-10-04', text: 'décision A' }], tasks: [{ id: 'L9/t1', title: 'sous-tâche', status: 'todo' }], problems: [], ...extra,
});

describe('gabarits', () => {
  const vars = { chemin: '/r/p', lot: 'L9', titre: 'Un titre', objectif: 'faire X', commits: '', reponse: '', constats: '', ux: '', choix: '', news: '' };

  it('implement, fix et fix-minors interdisent de s\'arrêter sur une question d\'organisation (L52)', () => {
    for (const kind of ['implement', 'fix', 'fix-minors'] as const) {
      const out = renderBrief(kind, vars);
      expect(out, kind).toContain('Never stop to ask about how to organise your own work');
      expect(out, kind).toContain('split or squash a commit');
    }
    expect(renderBrief('implement', vars)).toContain('Leave "questions" empty rather than writing a placeholder');
  });

  it('fix et fix-minors : un constat contesté est noté en choix avec ses preuves, relu par la revue suivante, pas remonté au lead (L52)', () => {
    const fix = renderBrief('fix', vars);
    expect(fix).toContain('A finding you contest');
    expect(fix).toContain('not a question and not a reason to stop');
    expect(fix).toContain('the next fresh review re-reads it');
    expect(renderBrief('fix-minors', vars)).toContain('A finding you contest is noted under "choix"');
  });

  it('ux.md : captures et snapshots dans le dossier du serveur Playwright de la vague, noms relatifs (L74)', () => {
    const out = renderBrief('ux', vars);
    expect(out).toContain("output directory, which lies in the orchestrator's run directory, outside the repository");
    expect(out).toContain('relative file name');
    expect(out).not.toContain('.playwright-mcp');
    expect(out).not.toMatch(/pass `?--output-dir/); // le serveur est lancé avec son --output-dir : la session ne le prescrit pas
  });

  it('implement.md est le brief du lead (§2) plus deux lignes, rendu sans accolades restantes', () => {
    const out = renderBrief('implement', vars);
    expect(out).toContain('Work in `/r/p` on lot `L9` — "Un titre" — of its plan');
    expect(out).toContain('read the lot, its notes and sub-tasks, and the project\'s CLAUDE.md first');
    expect(out).toContain('Goal: faire X');
    expect(out).toContain('test first; commit each sub-part as soon as its tests pass, with explicit paths (never');
    expect(out).toContain('`git add -A` or `commit -a`), and a message that cites the lot (`feat(L9): …`)');
    expect(out).toContain('do not push, deliver, run `raf done`, `raf ux` or');
    expect(out).toContain('Decide minor interpretation questions yourself');
    expect(out).toContain('list each one under "choix" in your report');
    expect(out).toContain('Stop and ask (under "questions") only on a real blocker.');
    expect(out).toContain('AND the plan, its notes and the project\'s CLAUDE.md do not settle it');
    expect(out).not.toContain('or that the plan, its notes');
    expect(out).not.toContain('instead of guessing');
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

  it('les briefs qui peuvent ouvrir un navigateur donnent une consigne Playwright vraie dans les deux cas (MCP de la vague, ou CLI hors du dépôt) (L74)', () => {
    for (const kind of ['implement', 'fix', 'fix-minors', 'review-small'] as const) {
      const out = renderBrief(kind, vars);
      expect(out, kind).toContain('Playwright');
      expect(out, kind).not.toContain('.playwright-mcp'); // les sorties ne tombent plus dans le dépôt
      expect(out, kind).toContain('do not install or start one');
      expect(out, kind).toContain('never inside the repository');
      expect(out, kind).toContain('relative file name');
      expect(out, kind).toContain("run directory outside the repository");
      expect(out, kind).not.toContain('no browser MCP server is loaded');
      // --output-dir est un argument de lancement du serveur MCP et /tmp est refusé hors racines autorisées : ni l'un ni l'autre ne se prescrit.
      expect(out, kind).not.toContain('--output-dir /tmp');
      expect(out, kind).not.toMatch(/pass `?--output-dir/);
      expect(out, kind).not.toContain('/tmp/<name>');
      expect(out, kind).not.toMatch(/absolute `?\/tmp/);
    }
  });

  it('les revues reçoivent les choix faits de l\'auteur pour les relire, sans son résumé', () => {
    const out = renderBrief('review', { ...vars, choix: '- A plutôt que B', reponse: 'une réponse' });
    expect(out).toContain('- A plutôt que B');
    const small = renderBrief('review-small', { ...vars, choix: '- A plutôt que B' });
    expect(small).toContain('- A plutôt que B');
  });

  it('fix.md liste les constats et les commits du lot', () => {
    const out = renderBrief('fix', { ...vars, constats: '- [majeur] a.ts:3 — bug', commits: '- abc1234 feat(L9): x' });
    expect(out).toContain('- [majeur] a.ts:3 — bug');
    expect(out).toContain('- abc1234 feat(L9): x');
    expect(out).toContain('fix(L9): …');
  });

  it('les gabarits d\'écriture portent la règle « question = seulement ce qu\'elle change »', () => {
    for (const kind of ['implement', 'fix', 'fix-minors'] as const) {
      const out = renderBrief(kind, vars);
      if (kind !== 'fix-minors') {
        expect(out, kind).toContain('A question is legitimate only if it names what it would change');
        expect(out, kind).toContain('scope of the lot, the architecture, or a costly rollback');
        expect(out, kind).toContain('otherwise it is a choice: decide, write the alternative you did not take, go on');
      } else {
        expect(out, kind).not.toContain('A question is legitimate');
        expect(out, kind).toContain('writing the alternative you did not take');
      }
      expect(out, kind).toContain('a spacing, colour or label value');
      expect(out, kind).toContain('the URL of a link');
      if (kind === 'implement') expect(out, kind).not.toContain('yes, always'); // la News d'un lot visible n'est plus un choix mineur : consigne {{news}} (L48)
      else {
        expect(out, kind).toContain('a News entry: only if a finding asks for it');
        expect(out, kind).not.toContain('yes, always');
      }
      expect(out, kind).toContain('a written rule of the project\'s CLAUDE.md (apply it)');
      expect(out, kind).toContain('who launches the review or UX pass (never the session');
      expect(out, kind).toContain('"not my job to touch the plan" is not a question');
    }
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

describe('variantes de la passe des mineurs (L38)', () => {
  const vars = { chemin: '/r/p', lot: 'L9', titre: 'Un titre', objectif: 'faire X', commits: 'abc1234 feat(L9): x', reponse: '', constats: '- [mineur] a.txt:1 — nommage', ux: '', choix: '', news: '' };

  it('la correction des mineurs ne dit jamais de s\'arrêter pour poser la question, et demande de lister les mineurs refusés en choix', () => {
    const out = renderBrief('fix-minors', vars);
    expect(out).toContain('found only minor');
    expect(out).toContain('- [mineur] a.txt:1 — nommage');
    expect(out).toContain('abc1234 feat(L9): x');
    expect(out).toContain('Do not stop to ask');
    expect(out).toContain('list it under\n"choix"');
    expect(out).not.toContain('stop and report the question');
    expect(out).not.toContain('defects');
    expect(out).not.toMatch(/\{\{/);
  });

  it('la revue courte qui la suit est une revue de code : ni « small lot » ni revue d\'ergonomie, les choix relus', () => {
    const out = renderBrief('review-recheck', { ...vars, choix: '- A plutôt que B', ux: 'Start the app with: npm start' });
    expect(out).toContain('short re-review');
    expect(out).toContain('This is a code review only');
    expect(out).not.toContain('This lot is small');
    expect(out).not.toContain('single pass');
    expect(out).not.toContain('usability');
    expect(out).not.toContain('Start the app');
    expect(out).toContain('- A plutôt que B');
    expect(out).toContain('read-only');
  });
});

describe('instantané des gabarits (L39)', () => {
  const vars = { chemin: '/r/p', lot: 'L9', titre: 'Un titre', objectif: 'faire X', commits: '', reponse: '', constats: '', ux: '', choix: '', news: '' };

  it('loadTemplates lit tous les gabarits une fois ; renderBrief rend depuis l\'instantané sans relire le disque', () => {
    const dir = tempDir();
    cpSync(TEMPLATES_DIR, dir, { recursive: true });
    const snap = loadTemplates(dir);
    expect(Object.keys(snap).sort()).toEqual(['fix', 'fix-minors', 'implement', 'review', 'review-recheck', 'review-small', 'ux']);
    writeFileSync(join(dir, 'review.md'), 'changé {{lot}}\n');
    expect(renderBrief('review', vars, snap)).toContain('Review lot `L9`');
    expect(renderBrief('review', vars, dir)).toBe('changé L9\n');
  });

  it('un gabarit absent est une erreur nommée, avant tout rendu', () => {
    const dir = tempDir();
    cpSync(TEMPLATES_DIR, dir, { recursive: true });
    rmSync(join(dir, 'ux.md'));
    expect(() => loadTemplates(dir)).toThrow(/gabarit ux\.md illisible/);
  });
});

describe('entrée Nouveautés dans le brief d\'un lot visible (L48)', () => {
  const base = { chemin: '/r/p', lot: 'L9', titre: 'Un titre', objectif: 'faire X', commits: '', reponse: '', constats: '', ux: '', choix: '' };

  it('lot visible : commande cadence news new <lot>, texte factuel côté utilisateur, capture ou nocapture, jamais une question', () => {
    const out = renderBrief('implement', { ...base, news: newsText('L9') });
    expect(out).toContain('cadence news new L9');
    expect(out).toContain('docs/nouveautes/');
    expect(out).toContain('what changes for the user');
    expect(out).toContain('docs/nouveautes/captures/');
    expect(out).toContain('nocapture');
    expect(out).toContain('cadence news check');
    expect(out).not.toMatch(/\{\{/);
  });

  it("le titre de l'entrée est côté utilisateur : titre public du lot, sinon réécrit avec --title (L48/t2)", () => {
    const out = renderBrief('implement', { ...base, news: newsText('L9') });
    expect(out).toContain("entry's title is user-side");
    expect(out).toContain("the lot's public title");
    expect(out).toContain('--title');
  });

  it('lot non visible : aucune mention des Nouveautés', () => {
    const out = renderBrief('implement', { ...base, news: '' });
    expect(out).not.toMatch(/\{\{/);
    expect(out).not.toContain('news new');
    expect(out).not.toContain('nouveautes');
  });
});
