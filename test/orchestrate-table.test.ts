import { describe, expect, it } from 'vitest';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { renderTable } from '../src/orchestrate/table.js';
import { newLot, type LotState, type ReviewSummary, type StepState, type WaveState } from '../src/orchestrate/state.js';
import type { StepKind } from '../src/orchestrate/launch.js';
import { Plan } from '../src/plan.js';
import { commitFile, git } from './orchestrate-harness.js';
import { gitRepo } from './helpers.js';

const wave: WaveState = { id: 'w1', created: '2026-10-04T10:00:00Z', cwd: '/x', budget: 2_000_000, consumed: 0, cacheRead: 0, status: 'done', pid: 1, lots: ['demo:L1'] };
const lot = () => newLot({ project: 'demo', repo: '/r', lot: 'L1', title: 't', visible: false, small: false, model: 'sonnet', readOnlyPlan: false });

describe('renderTable : choix et propositions', () => {
  it('un lot avec choix rend une ligne « choix fait : … » par choix', () => {
    const l = lot();
    l.status = 'ready';
    l.choix = ['SQLite plutôt que PostgreSQL', 'message en français'];
    const out = renderTable(wave, [l]);
    expect(out).toContain('demo:L1 — choix fait : SQLite plutôt que PostgreSQL');
    expect(out).toContain('demo:L1 — choix fait : message en français');
  });

  it('sans choix, aucune ligne « choix fait »', () => {
    const l = lot();
    l.status = 'ready';
    expect(renderTable(wave, [l]).join('\n')).not.toContain('choix fait');
  });

  it('un ancien état sans champ « choix » se rend sans erreur', () => {
    const l = lot();
    l.status = 'ready';
    delete (l as { choix?: string[] }).choix;
    expect(() => renderTable(wave, [l])).not.toThrow();
  });

  it('les mineurs non traités sont rendus « proposé : … »', () => {
    const l = lot();
    l.status = 'ready';
    l.proposals = ['[mineur code] a.txt:1 — nommage'];
    expect(renderTable(wave, [l])).toContain('demo:L1 — proposé : [mineur code] a.txt:1 — nommage');
  });
});

describe('renderTable : captures UX (L74)', () => {
  it('une ligne donne le dossier des captures quand l\'étape ux a tourné', () => {
    const l = lot();
    l.status = 'ready';
    l.uxCaptures = '/launch/.cadence/runs/w1/demo--L1/playwright';
    expect(renderTable(wave, [l])).toContain('demo:L1 — captures Playwright : /launch/.cadence/runs/w1/demo--L1/playwright');
  });

  it('sans étape ux, aucune ligne', () => {
    const l = lot();
    l.status = 'ready';
    expect(renderTable(wave, [l]).join('\n')).not.toContain('captures Playwright');
  });
});

describe('renderTable : colonne revue (L51)', () => {
  const step = (kind: StepKind, status: StepState['status'] = 'ok'): StepState => ({ n: 1, kind, model: 'sonnet', status, started: '2026-10-04T10:00:00Z' });
  const summary = (over: Partial<ReviewSummary>): ReviewSummary => ({ conforme: true, bloquants: 0, majeurs: 0, mineurs: 0, verdict: 'v', sousTaches: [], nonVerifie: [], head: 'abc', ...over });
  const cell = (l: LotState) => renderTable(wave, [l])[1];

  it('revue conforme puis lot rendu pour dépôt sale : jamais « non conforme (0 bloquant, 0 majeur) »', () => {
    const l = lot();
    l.status = 'handed-back';
    l.outcome = 'dépôt sale après fix : oublie.txt';
    l.code = summary({});
    l.steps = [step('implement'), step('review'), step('fix')];
    expect(cell(l)).not.toContain('non conforme');
    expect(cell(l)).toContain('conforme (dernier verdict ; rendu pour une autre cause)');
  });

  it('revue non conforme ancienne, lot rendu après une correction pour une autre cause : dernier verdict + autre cause', () => {
    const l = lot();
    l.status = 'handed-back';
    l.code = summary({ conforme: false, bloquants: 1 });
    l.steps = [step('implement'), step('review'), step('fix')];
    expect(cell(l)).toContain('non conforme (1 bloquant, 0 majeur) (dernier verdict ; rendu pour une autre cause)');
  });

  it('rendu par la revue elle-même (passes épuisées) : verdict de la revue, sans mention d\'autre cause', () => {
    const l = lot();
    l.status = 'handed-back';
    l.code = summary({ conforme: false, majeurs: 2 });
    l.steps = [step('implement'), step('review'), step('fix'), step('review')];
    expect(cell(l)).toContain('non conforme (0 bloquant, 2 majeur)');
    expect(cell(l)).not.toContain('autre cause');
  });

  it.each([
    ['failed', 'failed'],
    ['interrupted', 'suspended'],
  ] as const)('dernière étape de revue %s (lot %s) : autre cause, pas un verdict de revue', (stepStatus, lotStatus) => {
    const l = lot();
    l.status = lotStatus;
    l.code = summary({ conforme: false, bloquants: 1 });
    l.steps = [step('implement'), step('review'), step('fix'), step('review', stepStatus)];
    expect(cell(l)).toContain('(dernier verdict ; rendu pour une autre cause)');
  });
});

describe('renderTable : livrable jusqu\'à <sha> (L76)', () => {
  const stacked = (project: string, name: string, status: LotState['status'], shas: string[], repo = '/r'): LotState => {
    const l = newLot({ project, repo, lot: name, title: 't', visible: false, small: false, model: 'sonnet', readOnlyPlan: false });
    l.status = status;
    l.steps = [{ n: 1, kind: 'implement', model: 'sonnet', status: 'ok', started: '2026-10-04T10:00:00Z', commits: shas.map((c) => (c.startsWith('[') ? c : `${c} feat(${name}): sujet du commit`)) }];
    return l;
  };
  // Historique empilé sur main : a1 a2 (L1) < b1 (L2) < c1 (L3), du plus ancien au plus récent.
  const order = ['a1', 'a2', 'b1', 'c1'];
  const isAncestor = (_repo: string, a: string, b: string) => order.indexOf(a) <= order.indexOf(b);
  const lines = (ls: LotState[]) => renderTable(wave, ls, { isAncestor, lotCommits: () => [] }).filter((x) => x.includes('livrable jusqu'));

  it('un lot prêt sous un lot rendu : la ligne donne son dernier commit et la commande deliver --sha', () => {
    const out = lines([stacked('demo', 'L1', 'ready', ['a1', 'a2']), stacked('demo', 'L2', 'handed-back', ['b1'])]);
    expect(out).toEqual(["demo:L1 — livrable jusqu'à a2 (dernier commit de L1, sous L2 rendu) : git push origin a2:main && cadence deliver --sha a2"]);
  });

  it('plusieurs lots prêts sous le lot rendu : le plus haut empilé', () => {
    const l1 = stacked('demo', 'L1', 'ready', ['a1']);
    const l2 = stacked('demo', 'L2', 'ready', ['a2']);
    const l3 = stacked('demo', 'L3', 'failed', ['b1']);
    expect(lines([l1, l2, l3])).toEqual(["demo:L2 — livrable jusqu'à a2 (dernier commit de L2, sous L3 rendu) : git push origin a2:main && cadence deliver --sha a2"]);
  });

  it('un lot prêt au-dessus du lot rendu n\'est pas livrable : aucune ligne', () => {
    expect(lines([stacked('demo', 'L2', 'handed-back', ['b1']), stacked('demo', 'L3', 'ready', ['c1'])])).toEqual([]);
  });

  it('tous prêts, ou aucun commit, ou un autre dépôt : aucune ligne', () => {
    expect(lines([stacked('demo', 'L1', 'ready', ['a1']), stacked('demo', 'L2', 'ready', ['b1'])])).toEqual([]);
    expect(lines([stacked('demo', 'L1', 'ready', ['a1']), stacked('demo', 'L2', 'handed-back', [])])).toEqual([]);
    expect(lines([stacked('demo', 'L1', 'ready', ['a1'], '/r'), stacked('other', 'L2', 'handed-back', ['b1'], '/s')])).toEqual([]);
  });

  it('les commits au format du programme (« <sha> <sujet> ») : sha nu dans la ligne et la commande', () => {
    const seen: string[] = [];
    const out = renderTable(wave, [stacked('demo', 'L1', 'ready', ['a1', 'a2']), stacked('demo', 'L2', 'handed-back', ['b1'])], {
      isAncestor: (_r, a, b) => (seen.push(a, b), order.indexOf(a) <= order.indexOf(b)),
    }).filter((x) => x.includes('livrable jusqu'));
    expect(out).toEqual(["demo:L1 — livrable jusqu'à a2 (dernier commit de L1, sous L2 rendu) : git push origin a2:main && cadence deliver --sha a2"]);
    expect(seen.every((x) => !x.includes(' '))).toBe(true);
  });

  it('les commits d\'un dépôt voisin ([rel] sha) ne comptent pas', () => {
    expect(lines([stacked('demo', 'L1', 'ready', ['[../x] a2']), stacked('demo', 'L2', 'handed-back', ['b1'])])).toEqual([]);
  });
  it('commits lus dans git : un lot en échec sans rapport a commité sous un lot prêt, aucune ligne (le tableau ne propose pas de code non revu)', () => {
    // L1 en échec : aucune étape n'a rempli `commits` (timeout, crash, rapport illisible, quota), mais git attribue a1 à L1.
    const l1 = stacked('demo', 'L1', 'failed', []);
    const l2 = stacked('demo', 'L2', 'ready', ['b1']);
    const l3 = stacked('demo', 'L3', 'handed-back', ['c1']);
    const gitOf: Record<string, string[]> = { L1: ['a1'], L2: ['b1'], L3: ['c1'] };
    const withGit = (ls: LotState[]) => renderTable(wave, ls, { isAncestor, lotCommits: (l) => gitOf[l.lot] ?? [] }).filter((x) => x.includes('livrable jusqu'));
    expect(withGit([l1, l2, l3])).toEqual([]);
    // Sans la lecture de git (état des étapes seul), le tableau proposait b1.
    expect(lines([l1, l2, l3])).toEqual(["demo:L2 — livrable jusqu'à b1 (dernier commit de L2, sous L3 rendu) : git push origin b1:main && cadence deliver --sha b1"]);
  });

  it('commits lus dans git : ceux d\'une vague précédente comptent aussi, sans doublon avec le sha abrégé des étapes', () => {
    const l1 = stacked('demo', 'L1', 'ready', ['a1abcde feat(L1): x']);
    const l2 = stacked('demo', 'L2', 'handed-back', ['b1']);
    const order2 = ['a1abcde', 'a2', 'b1'];
    const anc = (_repo: string, a: string, b: string) => order2.indexOf(a) <= order2.indexOf(b);
    const out = renderTable(wave, [l1, l2], { isAncestor: anc, lotCommits: (l) => (l.lot === 'L1' ? ['a1abcde', 'a2'] : []) }).filter((x) => x.includes('livrable jusqu'));
    expect(out).toEqual(["demo:L1 — livrable jusqu'à a2 (dernier commit de L1, sous L2 rendu) : git push origin a2:main && cadence deliver --sha a2"]);
  });

  it('un commit plan-seul au milieu des étapes (git l\'écarte, les étapes le rendent en fin de liste) : la ligne donne le dernier commit par ascendance', () => {
    // Historique : a1 < p1 (plan-seul) < a2 < b1. git donne a1, a2 ; les étapes a1, p1, a2.
    const hist = ['a1cdef', 'p1cdef', 'a2cdef', 'b1cdef'];
    const anc = (_repo: string, a: string, b: string) => hist.indexOf(a) <= hist.indexOf(b);
    const l1 = stacked('demo', 'L1', 'ready', ['a1cdef', 'p1cdef', 'a2cdef']);
    const l2 = stacked('demo', 'L2', 'handed-back', ['b1cdef']);
    const gitOf: Record<string, string[]> = { L1: ['a1cdef', 'a2cdef'], L2: ['b1cdef'] };
    const out = renderTable(wave, [l1, l2], { isAncestor: anc, lotCommits: (l) => gitOf[l.lot] ?? [] }).filter((x) => x.includes('livrable jusqu'));
    expect(out).toEqual(["demo:L1 — livrable jusqu'à a2cdef (dernier commit de L1, sous L2 rendu) : git push origin a2cdef:main && cadence deliver --sha a2cdef"]);
  });

  it('un commit plan-seul en tête du lot rendu ne le fait pas démarrer plus bas que son premier commit réel', () => {
    // Le lot rendu L2 a un commit plan-seul p0 (étapes seules) plus ancien que tout, puis b1 : p0 reste son plus ancien commit (prudent).
    const hist = ['p0cdef', 'a1cdef', 'b1cdef'];
    const anc = (_repo: string, a: string, b: string) => hist.indexOf(a) <= hist.indexOf(b);
    const out = renderTable(wave, [stacked('demo', 'L1', 'ready', ['a1cdef']), stacked('demo', 'L2', 'handed-back', ['p0cdef', 'b1cdef'])], { isAncestor: anc, lotCommits: () => [] }).filter((x) => x.includes('livrable jusqu'));
    expect(out).toEqual([]);
  });

  it('dépôt réel : un commit plan-seul cité par le lot, au milieu de ses étapes : la ligne donne le dernier commit de code', () => {
    const repo = gitRepo();
    const plan = Plan.create(join(repo, 'docs/plan/raf.yaml'), 'demo', 'L', '2026-09-01');
    for (const t of ['un', 'deux']) plan.add(t, '2026-10-01', { estimate: 1 });
    plan.save();
    writeFileSync(join(repo, 'cadence.yaml'), 'plan:\n  path: docs/plan/raf.yaml\n');
    git(repo, 'add', '--', 'docs/plan/raf.yaml', 'cadence.yaml');
    git(repo, 'commit', '-q', '-m', 'chore: plan');
    const a1 = commitFile(repo, 'a.txt', 'feat(L1): premier code').sha;
    // Commit plan-seul qui cite L1 : lotWork l'écarte, les étapes le rapportent.
    writeFileSync(join(repo, 'docs/plan/raf.yaml'), `${readFileSync(join(repo, 'docs/plan/raf.yaml'), 'utf8')}# note\n`);
    git(repo, 'commit', '-q', '-m', 'plan: L1 démarré', '--', 'docs/plan/raf.yaml');
    const p1 = git(repo, 'rev-parse', 'HEAD');
    const a2 = commitFile(repo, 'a2.txt', 'feat(L1): dernier code').sha;
    const b1 = commitFile(repo, 'b.txt', 'feat(L2): code rendu').sha;
    const mk = (name: string, status: LotState['status'], shas: string[]) => {
      const l = newLot({ project: 'demo', repo, lot: name, title: 't', visible: false, small: false, model: 'sonnet', readOnlyPlan: false });
      l.status = status;
      l.steps = [{ n: 1, kind: 'implement', model: 'sonnet', status: 'ok', started: '2026-10-04T10:00:00Z', commits: shas }];
      return l;
    };
    const lots = [mk('L1', 'ready', [a1, p1, a2].map((c) => `${c.slice(0, 7)} sujet`)), mk('L2', 'handed-back', [`${b1.slice(0, 7)} feat(L2): code rendu`])];
    const short = a2.slice(0, 7);
    expect(renderTable(wave, lots).filter((x) => x.includes('livrable jusqu'))).toEqual([`demo:L1 — livrable jusqu'à ${short} (dernier commit de L1, sous L2 rendu) : git push origin ${short}:main && cadence deliver --sha ${short}`]);
  });

  it('dépôt réel : L1 en échec a commité sans rapport, L2 prêt au-dessus, L3 rendu tout en haut : aucune ligne', () => {
    const repo = gitRepo();
    const plan = Plan.create(join(repo, 'docs/plan/raf.yaml'), 'demo', 'L', '2026-09-01');
    for (const t of ['un', 'deux', 'trois']) plan.add(t, '2026-10-01', { estimate: 1 });
    plan.save();
    writeFileSync(join(repo, 'cadence.yaml'), 'plan:\n  path: docs/plan/raf.yaml\n');
    git(repo, 'add', '--', 'docs/plan/raf.yaml', 'cadence.yaml');
    git(repo, 'commit', '-q', '-m', 'chore: plan');
    commitFile(repo, 'a.txt', 'feat(L1): code sans rapport').sha;
    const b1 = commitFile(repo, 'b.txt', 'feat(L2): code revu').sha;
    const c1 = commitFile(repo, 'c.txt', 'feat(L3): code rendu').sha;
    const mk = (name: string, status: LotState['status'], shas: string[]) => {
      const l = newLot({ project: 'demo', repo, lot: name, title: 't', visible: false, small: false, model: 'sonnet', readOnlyPlan: false });
      l.status = status;
      l.steps = [{ n: 1, kind: 'implement', model: 'sonnet', status: status === 'failed' ? 'failed' : 'ok', started: '2026-10-04T10:00:00Z', commits: shas }];
      return l;
    };
    const lots = [mk('L1', 'failed', []), mk('L2', 'ready', [`${b1.slice(0, 7)} feat(L2): code revu`]), mk('L3', 'handed-back', [`${c1.slice(0, 7)} feat(L3): code rendu`])];
    expect(renderTable(wave, lots).filter((x) => x.includes('livrable jusqu'))).toEqual([]);
    // Si L1 est lui aussi prêt, L2 reste sous L3 rendu : la ligne est bornée à b1 et ne dépend plus de git pour L1.
    lots[0].status = 'ready';
    expect(renderTable(wave, lots).filter((x) => x.includes('livrable jusqu'))).toEqual([`demo:L2 — livrable jusqu'à ${b1.slice(0, 7)} (dernier commit de L2, sous L3 rendu) : git push origin ${b1.slice(0, 7)}:main && cadence deliver --sha ${b1.slice(0, 7)}`]);
  });
});
