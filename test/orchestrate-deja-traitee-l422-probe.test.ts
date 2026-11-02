import { mkdirSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { renderDetail, renderTable } from '../src/orchestrate/table.js';
import { newLot, type LotState, type WaveState } from '../src/orchestrate/state.js';
import { runLot } from '../src/orchestrate/cycle.js';
import { citedFiles, proposalLine } from '../src/orchestrate/deja-traitee.js';
import { claudeOut, commitFile, git, harness, reviewReport, workReport, type Handler } from './orchestrate-harness.js';
import { gitRepo } from './helpers.js';

const wave: WaveState = { id: 'w1', created: '2026-11-02T10:00:00Z', cwd: '/x', budget: 2_000_000, consumed: 0, cacheRead: 0, status: 'done', pid: 1, lots: ['demo:L1'] };
const lot = (proposals: string[], heads: Record<string, string> | undefined, repo = '/r'): LotState => {
  const l = newLot({ project: 'demo', repo, lot: 'L1', title: 't', visible: false, small: false, model: 'sonnet', readOnlyPlan: false });
  l.status = 'ready';
  l.proposals = proposals;
  l.proposalHeads = heads;
  return l;
};

describe('L422 probe — citedFiles, formes réelles de texte de revue', () => {
  it('chemin en gras markdown **src/a.ts** est reconnu', () => {
    expect(citedFiles('**src/a.ts** : à revoir')).toEqual(['src/a.ts']);
  });
  it('chemin entre crochets [src/a.ts] ou chevrons <src/a.ts> est reconnu', () => {
    expect(citedFiles('voir [src/a.ts] et <docs/z.md>')).toEqual(['src/a.ts', 'docs/z.md']);
  });
  it('ligne et colonne src/a.ts:42:7 donne src/a.ts', () => {
    expect(citedFiles('src/a.ts:42:7 : bug')).toEqual(['src/a.ts']);
  });
  it('plage src/a.ts:42-50 donne src/a.ts', () => {
    expect(citedFiles('src/a.ts:42-50')).toEqual(['src/a.ts']);
  });
  it('préfixe ./src/a.ts donne src/a.ts', () => {
    expect(citedFiles('./src/a.ts : x')).toEqual(['src/a.ts']);
  });
  it('« e.g. » et « i.e. » ne sont pas des fichiers', () => {
    expect(citedFiles('extraire (e.g. une fonction, i.e. pure)')).toEqual([]);
  });
  it('une version « v1.5.2 » ou « 2.0 » n\'est pas un fichier', () => {
    expect(citedFiles('passer à v1.5.2 puis 2.0')).toEqual([]);
  });
  it('chaîne vide / espaces seuls : aucun fichier', () => {
    expect(citedFiles('   \n\t')).toEqual([]);
  });
  it('src/a.ts suivi de deux-points et phrase : « src/a.ts: erreur » reconnu', () => {
    expect(citedFiles('src/a.ts: erreur')).toEqual(['src/a.ts']);
  });
  it('fichier à accents « docs/règle.md » reconnu', () => {
    expect(citedFiles('docs/règle.md à corriger')).toEqual(['docs/règle.md']);
  });
});

describe('L422 probe — proposalLine', () => {
  const p = '[sous-tâche code] src/a.ts : x';
  it('deux fois : la même ligne rendue deux fois est identique (pas de marque cumulée)', () => {
    const l = lot([p], { [p]: 'h' });
    const once = proposalLine(l, p, () => 'abc1234');
    expect(proposalLine(l, p, () => 'abc1234')).toBe(once);
    expect(once.match(/peut-être/g)).toHaveLength(1);
  });
  it('proposalHeads présent mais vide : pas de marque', () => {
    expect(proposalLine(lot([p], {}), p, () => 'abc1234')).toBe(p);
  });
  it('head chaîne vide : pas de marque', () => {
    expect(proposalLine(lot([p], { [p]: '' }), p, () => 'abc1234')).toBe(p);
  });
  it('proposition « [sous-tâche » avec source ux / maquette est aussi marquée', () => {
    const q = '[sous-tâche ux] src/a.ts : x';
    expect(proposalLine(lot([q], { [q]: 'h' }), q, () => 'abc1234')).toContain('abc1234');
  });
  it('proposition identique deux fois dans proposals : chaque ligne marquée', () => {
    const out = renderDetail([lot([p, p], { [p]: 'h' })], 'demo:L1', { touchedSince: () => 'abc1234' });
    expect(out.filter((x) => x.includes('peut-être'))).toHaveLength(2);
  });
  it('touchedSince qui lève : le tableau ne tombe pas', () => {
    const l = lot([p], { [p]: 'h' });
    expect(() => renderTable(wave, [l], { touchedSince: () => { throw new Error('boom'); } })).not.toThrow();
  });
  it('mode compact : aucune lecture git ni marque dans le tableau, la marque est dans --detail', () => {
    const l = lot([p], { [p]: 'h' });
    const asked: string[] = [];
    const out = renderTable(wave, [l], { compact: true, touchedSince: (_l, _h, f) => (asked.push(f), 'abc1234') });
    expect(out.join('\n')).not.toContain('peut-être');
  });
});

describe('L422 probe — vrai dépôt git', () => {
  const p = '[sous-tâche code] src/a.ts : à reprendre';
  const render = (repo: string, head: string, shas: string[], prop = p) => renderDetail([lot([prop], { [prop]: head }, repo)], 'demo:L1', { lotCommits: () => shas }).join('\n');

  it('le commit de la revue lui-même (head) ne marque pas', () => {
    const repo = gitRepo();
    git(repo, 'commit', '-q', '--allow-empty', '-m', 'init');
    mkdirSync(`${repo}/src`);
    const c = commitFile(repo, 'src/a.ts', 'feat(L1): a');
    expect(render(repo, c.sha, [c.sha.slice(0, 7)])).not.toContain('peut-être');
  });
  it('chemin entier vs fin de chemin : « a.ts » cité marque un commit sur src/a.ts', () => {
    const repo = gitRepo();
    const c0 = commitFile(repo, 'z.txt', 'feat(L1): z');
    mkdirSync(`${repo}/src`);
    const c1 = commitFile(repo, 'src/a.ts', 'fix(L1): a');
    expect(render(repo, c0.sha, [c1.sha.slice(0, 7)], '[sous-tâche code] a.ts : x')).toContain(`(${c1.sha.slice(0, 7)})`);
  });
  it('fin de chemin partielle « xa.ts » ne correspond pas à src/a.ts', () => {
    const repo = gitRepo();
    const c0 = commitFile(repo, 'z.txt', 'feat(L1): z');
    mkdirSync(`${repo}/src`);
    const c1 = commitFile(repo, 'src/a.ts', 'fix(L1): a');
    expect(render(repo, c0.sha, [c1.sha.slice(0, 7)], '[sous-tâche code] xa.ts : x')).not.toContain('peut-être');
  });
  it('plusieurs commits postérieurs : le plus ancien donne le sha', () => {
    const repo = gitRepo();
    const c0 = commitFile(repo, 'a.ts', 'feat(L1): a');
    const c1 = commitFile(repo, 'a.ts', 'fix(L1): 1');
    const c2 = commitFile(repo, 'a.ts', 'fix(L1): 2');
    expect(render(repo, c0.sha, [c1.sha.slice(0, 7), c2.sha.slice(0, 7)], '[sous-tâche code] a.ts : x')).toContain(`(${c1.sha.slice(0, 7)})`);
  });
  it('head inconnu du dépôt : pas de marque', () => {
    const repo = gitRepo();
    const c0 = commitFile(repo, 'a.ts', 'feat(L1): a');
    expect(render(repo, 'deadbeefdeadbeef', [c0.sha.slice(0, 7)], '[sous-tâche code] a.ts : x')).not.toContain('peut-être');
  });
  it('liste de commits du lot vide : pas de marque', () => {
    const repo = gitRepo();
    const c0 = commitFile(repo, 'a.ts', 'feat(L1): a');
    expect(render(repo, c0.sha, [], '[sous-tâche code] a.ts : x')).not.toContain('peut-être');
  });
  it('commit postérieur qui SUPPRIME le fichier cité : marqué (le fichier a été touché)', () => {
    const repo = gitRepo();
    const c0 = commitFile(repo, 'a.ts', 'feat(L1): a');
    git(repo, 'rm', '-q', 'a.ts');
    git(repo, 'commit', '-q', '-m', 'fix(L1): rm');
    const sha = git(repo, 'rev-parse', '--short=7', 'HEAD');
    expect(render(repo, c0.sha, [sha], '[sous-tâche code] a.ts : x')).toContain(`(${sha})`);
  });
  it('dépôt de la fiche = chemin inexistant et head vide-string : pas de levée', () => {
    expect(() => render('/n/existe/pas', 'abc', ['abc1234'], '[sous-tâche code] a.ts : x')).not.toThrow();
  });
});

describe('L422 probe — cycle : la date d\'une proposition n\'est pas renouvelée', () => {
  it('une revue suivante qui répète la même sous-tâche garde le HEAD de la première', async () => {
    const T = 'a.txt : à revoir';
    const major: Handler = () => claudeOut(reviewReport({ majeurs: 1, constats: [{ gravite: 'majeur', fichier: 'a.txt', ligne: 1, texte: 'bug' }], sousTaches: [T], verdict: 'non conforme' }));
    const again: Handler = () => claudeOut(reviewReport({ sousTaches: [T] }));
    const impl: Handler = (call) => claudeOut(workReport({ commits: [commitFile(call.opts.cwd, 'a.txt', 'feat(L1): a')] }));
    const fix: Handler = (call) => claudeOut(workReport({ commits: [commitFile(call.opts.cwd, 'b.txt', 'fix(L1): b')] }));
    const h = harness({ script: { implement: [impl], review: [major, again], fix: [fix] } });
    const c = h.lot('L1');
    await runLot(c);
    const heads = c.lot.proposalHeads ?? {};
    const key = `[sous-tâche code] ${T}`;
    expect(c.lot.proposals.filter((x) => x === key)).toHaveLength(1);
    expect(heads[key]).toBeTruthy();
    // la première revue a lu le commit d'implémentation, pas le commit de correction
    expect(heads[key]).not.toBe(git(c.lot.repo, 'rev-parse', 'HEAD'));
  });
  it('une revue sans sous-tâche ne crée pas proposalHeads', async () => {
    const impl: Handler = (call) => claudeOut(workReport({ commits: [commitFile(call.opts.cwd, 'a.txt', 'feat(L1): a')] }));
    const h = harness({ script: { implement: [impl], review: [() => claudeOut(reviewReport())] } });
    const c = h.lot('L1');
    await runLot(c);
    expect(c.lot.proposalHeads ?? {}).toEqual({});
  });
});
