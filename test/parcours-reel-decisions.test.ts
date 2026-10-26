import { describe, expect, it } from 'vitest';
import { renderBrief } from '../src/orchestrate/briefs.js';
import { decisionsText, humanDecisions } from '../src/orchestrate/decisions.js';
import { hypothesisNote } from '../src/orchestrate/spec.js';
import { WORK_SCHEMA } from '../src/orchestrate/schemas.js';
import type { Lot } from '../src/plan.js';

const vars = { chemin: '/r/p', lot: 'L9', titre: 'Un titre', objectif: 'faire X', commits: 'c1', reponse: '', constats: 'un constat', ux: '', choix: '', checks: '', news: '', captures: '', fiche: '', repos: '', decisions: '' };
const lot = (id: string, notes: { date: string; text: string }[], parent?: string): Lot => ({ id, parent, notes, title: id, status: 'todo', estimate: 1, quickwin: false, visible: false, after: [], tasks: [] }) as unknown as Lot;
/** Le bloc « parcours réel » : de son titre à la fin de son paragraphe. */
const parcours = (): string => {
  const out = renderBrief('implement', vars);
  const i = out.indexOf('Real walkthrough');
  expect(i, 'implement porte le bloc').toBeGreaterThanOrEqual(0);
  return out.slice(i).split('\n\n')[0]!;
};

describe('parcours réel avant la revue (L344)', () => {
  it('R1 — le brief implement demande, tests verts, de jouer le livrable comme un utilisateur : la commande dans un dépôt jetable en suivant la doc du lot', () => {
    const b = parcours();
    expect(b).toContain('tests are green');
    expect(b).toContain('as a user would');
    expect(b).toContain('throwaway repository');
    expect(b).toContain('documentation the lot wrote');
  });

  it('R2 — un écran se joue dans chacun de ses états, échec compris, à la position où l\'action a lieu, avec une capture', () => {
    const b = parcours();
    expect(b).toContain('each of its states');
    expect(b).toContain('failure included');
    expect(b).toContain('where the action takes place');
    expect(b).toContain('capture');
  });

  it('R3 — ce qui casse se corrige dans la même session, test d\'abord, et le rapport le dit sous « parcours réel » dans le résumé, sans nouveau champ', () => {
    const b = parcours();
    expect(b).toContain('same session');
    expect(b).toContain('test first');
    expect(b).toContain('« parcours réel »');
    expect(b).toContain('"resume"');
    const avant = ['commits', 'tests', 'build', 'nonVerifie', 'questions', 'choix', 'echecsDeBase', 'nouveauxEchecs', 'resume'];
    expect(Object.keys(WORK_SCHEMA.properties).sort()).toEqual([...avant].sort());
  });

  it('R4 — le parcours précède l\'auto-vérification, et le brief fix ne le porte pas (il ne corrige que les constats)', () => {
    const out = renderBrief('implement', vars);
    expect(out.indexOf('Real walkthrough')).toBeLessThan(out.indexOf('Auto-verification'));
    expect(renderBrief('fix', vars)).not.toContain('Real walkthrough');
  });
});

describe('décisions de l\'humain dans le brief (L344)', () => {
  const decision = { date: '2026-10-22', text: 'décision de Sylvain (22-10) : « champs exclus » veut dire les champs qu\'on ne remplit pas, pas ceux qu\'on retire.' };

  it('R5 — les décisions de l\'humain sont extraites des notes du lot, avec leur date et leur texte cités', () => {
    const l = lot('L9', [{ date: '2026-10-20', text: 'revue de la vague : 2 mineurs' }, decision]);
    expect(humanDecisions(l)).toEqual([{ lot: 'L9', date: '2026-10-22', text: decision.text }]);
  });

  it('R6 — celles du lot parent comptent aussi, le parent d\'abord, chaque décision nommant son lot', () => {
    const parent = lot('P1', [{ date: '2026-10-01', text: 'Sylvain a tranché : pas de migration automatique' }]);
    const l = lot('L9', [decision], 'P1');
    expect(humanDecisions(l, parent).map((d) => `${d.lot} ${d.date}`)).toEqual(['P1 2026-10-01', 'L9 2026-10-22']);
  });

  it('R7 — une note sans décision de l\'humain (revue, mesure, relevé) n\'est pas reprise', () => {
    const l = lot('L9', [{ date: '2026-10-20', text: 'revue de la vague 2026-10-20 : conforme' }, { date: '2026-10-21', text: 'Relevé : 12 lots sur 30' }]);
    expect(humanDecisions(l)).toEqual([]);
  });

  it('R8 — le brief implement les reçoit sous « décisions à respecter », avec la règle : un écart devient une question, jamais un choix', () => {
    const out = renderBrief('implement', { ...vars, decisions: decisionsText(humanDecisions(lot('L9', [decision]))) });
    expect(out).toContain('Decisions to respect');
    expect(out).toContain('2026-10-22 (L9)');
    expect(out).toContain('« champs exclus »');
    expect(out).toContain('"questions"');
    expect(out).toContain('never under "choix"');
  });

  it('R9 — sans décision le brief ne porte aucune ligne vide de plus ni le bloc (le texte est vide)', () => {
    expect(decisionsText([])).toBe('');
    expect(renderBrief('implement', vars)).not.toContain('Decisions to respect');
  });

  it('R10 — le brief fix reçoit aussi les décisions (une correction ne défait pas une décision)', () => {
    const out = renderBrief('fix', { ...vars, decisions: decisionsText(humanDecisions(lot('L9', [decision]))) });
    expect(out).toContain('Decisions to respect');
  });

  it('R11 — une note très longue est coupée, le début (la décision) reste', () => {
    const long = `décision de Sylvain : ${'x'.repeat(5000)}`;
    const [d] = humanDecisions(lot('L9', [{ date: '2026-10-22', text: long }]));
    expect(d!.text.length).toBeLessThan(1700);
    expect(d!.text.startsWith('décision de Sylvain')).toBe(true);
  });

  it('R12 — une hypothèse de fiche posée par le programme (« Hypothèses (fiche …) — ») n\'est pas une décision, même quand elle parle de l\'utilisateur', () => {
    const l = lot('L9', [{ date: '2026-10-24', text: hypothesisNote('ecran-pin', "R3 : l'utilisateur voit le bandeau d'échec quand le PIN est refusé") }, decision]);
    expect(humanDecisions(l).map((d) => d.text)).toEqual([decision.text]);
  });

  it('R13 — un mineur de revue noté par le programme (« Revue de la fiche — mineur : ») n\'est pas une décision, même « validé par le lead »', () => {
    const l = lot('L9', [{ date: '2026-10-24', text: 'Revue de la fiche — mineur : docs/specs/x/fiche.yaml:12 — libellé validé par le lead à reformuler' }, decision]);
    expect(humanDecisions(l).map((d) => d.text)).toEqual([decision.text]);
  });

  it('R14 — « titre remplacé : « … » » cite l\'ancien titre, périmé : ce n\'est pas une décision', () => {
    const l = lot('L9', [{ date: '2026-10-24', text: 'titre remplacé : « champs exclus selon la décision de Sylvain »' }, decision]);
    expect(humanDecisions(l).map((d) => d.text)).toEqual([decision.text]);
  });

  it('R15 — « remis en attente » (avec ou sans raison) n\'est pas une décision', () => {
    const l = lot('L9', [{ date: '2026-10-24', text: 'remis en attente : le lead demande de livrer L8 d\'abord' }, { date: '2026-10-24', text: 'remis en attente' }, decision]);
    expect(humanDecisions(l).map((d) => d.text)).toEqual([decision.text]);
  });

  it('R16 — « abandonné : … » n\'est pas une décision', () => {
    const l = lot('L9', [{ date: '2026-10-24', text: 'abandonné : Sylvain a refusé la migration, lot sans objet' }, decision]);
    expect(humanDecisions(l).map((d) => d.text)).toEqual([decision.text]);
  });

  it('R17 — les notes posées sur une sous-tâche portent le préfixe « [Lnn/tn] » : « abandonné : », « remis en attente » et « titre remplacé : » restent écartés', () => {
    const l = lot('L9', [
      { date: '2026-10-24', text: '[L9/t1] abandonné : Sylvain a refusé la migration, sous-tâche sans objet' },
      { date: '2026-10-24', text: '[L9/t2] remis en attente : le lead demande de livrer L8 d\'abord' },
      { date: '2026-10-24', text: '[L9/t3] titre remplacé : « champs exclus selon la décision de Sylvain »' },
      decision,
    ]);
    expect(humanDecisions(l).map((d) => d.text)).toEqual([decision.text]);
  });
});
