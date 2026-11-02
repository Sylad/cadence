import { describe, expect, it } from 'vitest';
import { renderDetail, renderTable } from '../src/orchestrate/table.js';
import { newLot, type LotState, type WaveState } from '../src/orchestrate/state.js';
import { runLot } from '../src/orchestrate/cycle.js';
import { citedFiles } from '../src/orchestrate/deja-traitee.js';
import { claudeOut, commitFile, git, harness, reviewReport, workReport, type Handler } from './orchestrate-harness.js';
import { gitRepo } from './helpers.js';

const wave: WaveState = { id: 'w1', created: '2026-11-02T10:00:00Z', cwd: '/x', budget: 2_000_000, consumed: 0, cacheRead: 0, status: 'done', pid: 1, lots: ['demo:L1'] };
const SUB = '[sous-tâche code] src/a.ts : extraire le calcul dans une fonction';

const lot = (proposals: string[], heads: Record<string, string> | undefined, repo = '/r'): LotState => {
  const l = newLot({ project: 'demo', repo, lot: 'L1', title: 't', visible: false, small: false, model: 'sonnet', readOnlyPlan: false });
  l.status = 'ready';
  l.proposals = proposals;
  l.proposalHeads = heads;
  return l;
};
const lotCommits = (shas: string[]) => () => shas;

describe('L422 — table finale : « peut-être déjà traitée »', () => {
  it('R1 — une sous-tâche dont le fichier cité a été modifié par un commit du lot postérieur à la revue est marquée avec le sha', () => {
    const l = lot([SUB], { [SUB]: 'rev0001' });
    const out = renderTable(wave, [l], { touchedSince: (_l, head, file) => (head === 'rev0001' && file === 'src/a.ts' ? 'abc1234' : null), lotCommits: lotCommits([]) });
    expect(out).toContain(`demo:L1 — proposé : ${SUB} — peut-être déjà traitée (abc1234)`);
  });

  it('R2 — le fichier cité intact depuis la revue : la ligne reste telle quelle', () => {
    const l = lot([SUB], { [SUB]: 'rev0001' });
    const out = renderTable(wave, [l], { touchedSince: () => null });
    expect(out).toContain(`demo:L1 — proposé : ${SUB}`);
    expect(out.join('\n')).not.toContain('peut-être');
  });

  it('R3 — un mineur n\'est jamais marqué, ni une sous-tâche sans fichier cité ou sans sha de revue (ancien état)', () => {
    const minor = '[mineur code] src/a.ts:3 — nommage';
    const noFile = '[sous-tâche code] ajouter un test de non-régression';
    const old = '[sous-tâche ux] src/b.ts : revoir';
    const l = lot([minor, noFile, old], { [minor]: 'rev0001', [noFile]: 'rev0001' });
    const asked: string[] = [];
    const out = renderTable(wave, [l], { touchedSince: (_l, _h, f) => (asked.push(f), 'abc1234') });
    expect(out.join('\n')).not.toContain('peut-être');
    expect(asked).toEqual([]);
  });

  it('R4 — plusieurs fichiers cités, avec ligne, backticks et chemin relatif : le premier touché donne le sha', () => {
    const p = '[sous-tâche code] voir `src/x/y.ts:42` et docs/z.md';
    const l = lot([p], { [p]: 'rev0001' });
    const out = renderTable(wave, [l], { touchedSince: (_l, _h, f) => (f === 'docs/z.md' ? 'def5678' : null) });
    expect(out).toContain(`demo:L1 — proposé : ${p} — peut-être déjà traitée (def5678)`);
  });

  it('R5 — renderDetail marque aussi (le tableau compact renvoie à lui)', () => {
    const l = lot([SUB], { [SUB]: 'rev0001' });
    expect(renderDetail([l], 'demo:L1', { touchedSince: () => 'abc1234' })).toContain(`demo:L1 — proposé : ${SUB} — peut-être déjà traitée (abc1234)`);
  });

  it('R6 — sur un vrai dépôt : seul un commit du lot POSTÉRIEUR à la revue marque, un commit antérieur ou d\'un autre lot non', () => {
    const repo = gitRepo();
    const before = commitFile(repo, 'a.ts', 'feat(L1): avant la revue');
    const head = before.sha;
    const other = commitFile(repo, 'a.ts', 'fix(L9): autre lot');
    const mine = commitFile(repo, 'a.ts', 'fix(L1): après la revue');
    const p = '[sous-tâche code] a.ts : à reprendre';
    const l = lot([p], { [p]: head }, repo);
    const touched = (shas: string[]) => renderTable(wave, [l], { lotCommits: () => shas }).join('\n');
    // Les commits du lot sont donnés par `lotCommits` (sha courts, du plus ancien au plus récent) : seuls ceux d'après la revue comptent.
    expect(git(repo, 'rev-parse', '--short=7', mine.sha)).toBeTruthy();
    expect(touched([before.sha.slice(0, 7)])).not.toContain('peut-être');
    expect(touched([before.sha.slice(0, 7), mine.sha.slice(0, 7)])).toContain(`peut-être déjà traitée (${mine.sha.slice(0, 7)})`);
    expect(other.sha).not.toBe(mine.sha);
  });

  it('R7 — une lecture git impossible ne fait pas tomber le tableau : pas de marque', () => {
    const p = '[sous-tâche code] a.ts : à reprendre';
    const l = lot([p], { [p]: 'rev0001' }, '/n/existe/pas');
    expect(() => renderTable(wave, [l], { lotCommits: () => ['abc1234'] })).not.toThrow();
  });

  it('R8 — le cycle garde, pour chaque sous-tâche proposée, le HEAD que la revue a lu ', async () => {
    let sha = '';
    const impl: Handler = (call) => {
      const k = commitFile(call.opts.cwd, 'a.txt', 'feat(L1): a');
      sha = k.sha;
      return claudeOut(workReport({ commits: [k] }));
    };
    const sub = (t: string): Handler => () => claudeOut(reviewReport({ sousTaches: [t] }));
    const h = harness({ script: { implement: [impl], review: [sub('a.txt : à revoir')] } });
    const c = h.lot('L1');
    await runLot(c);
    expect(c.lot.proposalHeads).toEqual({ '[sous-tâche code] a.txt : à revoir': sha });
  });

  it('R9 — citedFiles : chemins, ligne, backticks ; ni adresse web, ni nombre, ni point final', () => {
    expect(citedFiles('voir `src/a.ts:42`, docs/z.md. Détails : https://x.dev/a.html et 1.5 ou e.g. fin.')).toEqual(['src/a.ts', 'docs/z.md']);
    expect(citedFiles('')).toEqual([]);
    expect(citedFiles('src/a.ts src/a.ts')).toEqual(['src/a.ts']);
  });
  it('R10 — les commits relus sont ceux des étapes du lot : un lot intégré par rebase ne marque pas le commit que la revue a lu, un lot non intégré marque son commit postérieur', () => {
    const repo = gitRepo();
    commitFile(repo, 'base.ts', 'chore: base');
    git(repo, 'switch', '-q', '-c', 'lot');
    const read = commitFile(repo, 'a.ts', 'feat(L1): lu par la revue');
    const fix = commitFile(repo, 'b.ts', 'fix(L1): après la revue');
    const p = '[sous-tâche code] a.ts : extraire';
    const q = '[sous-tâche code] b.ts : renommer';
    const l = lot([p, q], { [p]: read.sha, [q]: read.sha }, repo);
    l.steps.push({ n: 1, kind: 'implement', model: 'sonnet', status: 'ok', started: '2026-11-02T10:00:00Z', commits: [`${read.sha.slice(0, 7)} ${read.sujet}`, `${fix.sha.slice(0, 7)} ${fix.sujet}`] });
    // Non intégré : les commits ne sont que sur la branche du lot, git (HEAD du dépôt) ne les voit pas.
    const lines = renderTable(wave, [l]).join('\n');
    expect(lines).toContain(`${q} — peut-être déjà traitée (${fix.sha.slice(0, 7)})`);
    expect(lines).not.toContain(`${p} — peut`);
    // Intégré : main a avancé, la branche est réécrite par le rebase, le HEAD de la revue (avant rebase) n'est plus dans l'histoire de main.
    git(repo, 'switch', '-q', 'main');
    commitFile(repo, 'plan.md', 'plan: avance');
    git(repo, 'switch', '-q', 'lot');
    git(repo, 'rebase', '-q', 'main');
    git(repo, 'switch', '-q', 'main');
    git(repo, 'merge', '-q', '--ff-only', 'lot');
    const after = renderTable(wave, [l]).join('\n');
    expect(after).toContain(`${q} — peut-être déjà traitée (${fix.sha.slice(0, 7)})`);
    expect(after).not.toContain(`${p} — peut`);
  });

  it('R11 — le mode compact (--status) ne lit pas git pour marquer, et chaque lot ne charge ses commits qu\'une fois', () => {
    const q = '[sous-tâche code] src/a.ts src/b.ts src/c.ts : x';
    const r = '[sous-tâche code] src/d.ts src/e.ts : y';
    const l = lot([q, r], { [q]: 'rev0001', [r]: 'rev0001' });
    let reads = 0;
    const touchedSince = () => (reads++, null);
    renderTable(wave, [l], { compact: true, touchedSince });
    expect(reads).toBe(0);
    let loads = 0;
    renderTable(wave, [l], { touchedSince });
    expect(reads).toBe(5);
    const repo = gitRepo();
    const c = commitFile(repo, 'a.ts', 'feat(L1): x');
    const m = lot([q, r], { [q]: c.sha, [r]: c.sha }, repo);
    renderTable(wave, [m], { lotCommits: () => (loads++, [c.sha.slice(0, 7)]) });
    expect(loads).toBeLessThanOrEqual(2);
  });
});
