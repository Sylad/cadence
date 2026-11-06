import { afterEach, describe, expect, it } from 'vitest';
import { mkdirSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { inspectWave, measureWave, parseJournal, parseRetakes, renderInspection, tourSummary } from '../src/inspect.js';
import { inspectFolder } from '../src/inspect-read.js';
import { Plan } from '../src/plan.js';
import { withPlace } from '../src/orchestrate/gate-place.js';
import type { OrchestrateConfig } from '../src/config.js';
import { fakeRemote } from './fake-ssh.js';
import { git, harness } from './orchestrate-harness.js';
import { cleanupTempDirs, tempDir } from './helpers.js';

afterEach(cleanupTempDirs);

const at = (min: number, text: string) => `2026-11-06T09:${String(min).padStart(2, '0')}:00.000Z ${text}`;
const journal = (...lines: string[]) => `${lines.join('\n')}\n`;
const measure = (text: string) => measureWave(parseJournal(text));
const conflit = journal(at(0, 'cadence:L2 → handed-back — intégration impossible : conflit en rebasant a sur b'), at(3, 'cadence:L2 → ready — prêt'));

function runsIn(root: string, waves: Record<string, string>): string {
  for (const [wave, text] of Object.entries(waves)) {
    mkdirSync(join(root, '.cadence', 'runs', wave), { recursive: true });
    writeFileSync(join(root, '.cadence', 'runs', wave, 'journal.log'), text);
  }
  return join(root, '.cadence', 'runs');
}

describe('cadence inspect (L627) — corrections de la revue', () => {
  it('R1 — « après la première revue » s\'arrête à la dernière ligne du lot, pas à celle de la vague', () => {
    const { lots } = measure(journal(at(0, 'cadence:L1 → reviewing'), at(12, 'cadence:L1 → ready — prêt'), at(50, 'cadence:L2 → reviewing'), at(55, 'cadence:L2 → ready — prêt')));
    expect(lots.map((l) => [l.lot, l.afterFirstReview])).toEqual([['cadence:L1', 12], ['cadence:L2', 5]]);
  });

  it('R5 — le lot qui traite la cause est cherché dans le projet de la vague : un lot d\'un autre projet qui parle de « conflits d\'emplacement » ne la traite pas', () => {
    const dir = runsIn(tempDir(), { '2026-11-05-0900': conflit, '2026-11-06-0900': conflit });
    const autre = { project: 'discotheque', id: 'L17', title: 'Déplacer un disque + résolution des conflits d\'emplacement', status: 'todo' };
    const c = inspectWave(dir, '2026-11-06-0900', [autre]).causes[0]!;
    expect(c.planLot).toBeNull();
    expect(c.proposal).toContain('raf add');
    expect(inspectWave(dir, '2026-11-06-0900', [{ ...autre, project: 'cadence' }]).causes[0]!.planLot).toEqual({ id: 'cadence:L17', status: 'todo' });
  });

  it('R5 — la ligne ne dit pas d\'un lot terminé qu\'il « n\'a pas supprimé » la cause, ni le tour qu\'un lot ouvert la « traite »', () => {
    const dir = runsIn(tempDir(), { '2026-11-05-0900': conflit, '2026-11-06-0900': conflit });
    const livre = inspectWave(dir, '2026-11-06-0900', [{ project: 'cadence', id: 'L631', title: 'conflit de rebase cité dans le refus', status: 'done' }]);
    expect(renderInspection(livre).join('\n')).not.toContain('n\'a pas supprimé');
    const ouvert = inspectWave(dir, '2026-11-06-0900', [{ project: 'cadence', id: 'L599', title: 'conflit de rebase', status: 'todo' }]);
    expect(tourSummary(ouvert)).toContain('au plan : cadence:L599 (todo)');
    expect(tourSummary(ouvert)).not.toContain('traitée');
  });

  it('R5 — lancé depuis un projet (sans sous-dossier de projet), le plan du dossier lui-même est lu', () => {
    const root = tempDir();
    const solo = join(root, 'solo');
    const plan = Plan.create(join(solo, '.cadence', 'raf.yaml'), 'solo', 'L', '2026-09-01');
    plan.add('Ressources pour éviter un conflit de CHANGELOG', '2026-10-01', { estimate: 1 });
    plan.save();
    const t = journal(at(0, 'solo:L9 → handed-back — intégration impossible : conflit en rebasant a sur b'), at(3, 'solo:L9 → ready — prêt'));
    runsIn(solo, { '2026-11-05-0900': t, '2026-11-06-0900': t });
    const i = inspectFolder(solo);
    expect(i.causes[0]).toMatchObject({ planLot: { id: 'solo:L1', status: 'todo' }, proposal: null, recidive: true });
  });

  it('R3 — un lot rendu pour revue non conforme, tests rouges, correction non jouée ou ou implement sans commit est une reprise du lead, avec son niveau ; un retrait --drop n\'en est pas une', () => {
    const { losses } = measure(journal(
      at(0, 'cadence:L1 → handed-back — revue non conforme après 3 passe(s) de correction ; rendu malgré l\'escalade fable'), at(59, 'cadence:L1 → implementing'),
      at(0, 'cadence:L2 → handed-back — tests rouges après 2 passe(s) de correction'), at(10, 'cadence:L2 → implementing'),
      at(0, 'cadence:L3 → handed-back — correction non jouée (budget) : budget du lot : 10 / 20 tokens comptés'), at(5, 'cadence:L3 → implementing'),
      at(0, 'cadence:L4 → handed-back — implement sans commit'), at(4, 'cadence:L4 → implementing'),
      at(0, 'cadence:L5 → handed-back — verrou des tests d\'acceptation : a.test.ts : test modifié'), at(2, 'cadence:L5 → implementing'),
      at(0, 'cadence:L6 → handed-back — retiré de la vague (--drop)'), at(9, 'cadence:L6 → implementing'),
    ));
    expect(losses.map((l) => [l.lot, l.category, l.cause, l.minutes, l.level])).toEqual([
      ['cadence:L1', 'reprise du lead', 'revue non conforme', 59, null],
      ['cadence:L2', 'reprise du lead', 'tests rouges', 10, 'porte'],
      ['cadence:L3', 'reprise du lead', 'correction non jouée', 5, 'porte'],
      ['cadence:L4', 'reprise du lead', 'implement sans commit', 4, 'commit'],
      ['cadence:L5', 'reprise du lead', 'verrou des tests d\'acceptation', 2, 'écriture'],
    ]);
  });

  it('R3 — une reprise du lead d\'une vague d\'avant revient en récidive, et ses minutes sont dans les minutes perdues', () => {
    const rendu = (min: number) => journal(at(0, 'cadence:L1 → handed-back — revue non conforme après 2 passe(s) de correction'), at(min, 'cadence:L1 → ready — prêt'));
    const dir = runsIn(tempDir(), { '2026-11-05-0900': rendu(5), '2026-11-06-0900': rendu(30) });
    const i = inspectWave(dir, '2026-11-06-0900', []);
    expect(i.lostMinutes).toBe(30);
    expect(i.causes[0]).toMatchObject({ cause: 'revue non conforme', minutes: 30, recidive: true });
  });

  it('R2 — « porte : début » n\'est écrit qu\'une fois le tour de l\'hôte obtenu : l\'attente n\'est pas comptée deux fois', async () => {
    const saved = { ...process.env };
    const remote = fakeRemote();
    for (const k of ['FAKE_DIR', 'FAKE_REAL_PATH', 'PATH']) process.env[k] = remote.env[k];
    try {
      const h = harness();
      const events: string[] = [];
      const o = { config: { test: 'true', gate: { host: 'machine', maxParallel: 1 } } as OrchestrateConfig, repo: h.repo, sha: git(h.repo, 'rev-parse', 'HEAD'), dir: h.repo, needClean: true, label: 'porte du lot L1', local: async () => ({ code: 0, output: '' }), say: (l: string) => events.push(`say ${l}`), trace: (l: string) => events.push(l) };
      let release!: () => void;
      const first = withPlace(o, () => new Promise<void>((r) => (release = r)));
      await new Promise((r) => setTimeout(r, 300));
      const second = withPlace(o, async () => {});
      await new Promise((r) => setTimeout(r, 200));
      expect(events.filter((e) => e === 'porte : début')).toHaveLength(1);
      expect(events.some((e) => e.includes('en attente d\'un créneau de porte'))).toBe(true);
      release();
      await Promise.all([first, second]);
      expect(events.filter((e) => e === 'porte : début')).toHaveLength(2);
      expect(events.indexOf('porte : fin')).toBeLessThan(events.lastIndexOf('porte : début'));
    } finally {
      process.env = saved;
    }
  });
});

describe('cadence inspect (L627) — seconde revue', () => {
  it('R1 — un lot dont l\'id contient « / » (sous-tâche, maritime-atlas:Q4/donnees-12) est reconnu : son temps et ses pertes comptent', () => {
    const { lots, losses } = measure(journal(
      at(0, 'maritime-atlas:Q4/donnees-12 → implementing'), at(0, 'maritime-atlas:Q4/donnees-12 · session 1 implement (sonnet)'),
      at(10, 'maritime-atlas:Q4/donnees-12 → handed-back — intégration impossible : conflit en rebasant a sur b'), at(14, 'maritime-atlas:Q4/donnees-12 → ready — prêt'),
    ));
    expect(lots.map((l) => [l.lot, l.states.implementing, l.sessions])).toEqual([['maritime-atlas:Q4/donnees-12', 10, 1]]);
    expect(losses.map((l) => [l.lot, l.category, l.minutes])).toEqual([['maritime-atlas:Q4/donnees-12', 'conflit', 4]]);
  });

  it('R3 — chaque correction a son niveau de détection : « porte » après une porte finie sans revue entre les deux, « revue » après une revue, sinon aucun', () => {
    const { lots } = measure(journal(
      at(0, 'cadence:L1 → implementing'), at(5, 'cadence:L1 · porte : début'), at(6, 'cadence:L1 · porte : fin'), at(6, 'cadence:L1 → fixing'),
      at(10, 'cadence:L1 · porte : début'), at(11, 'cadence:L1 · porte : fin'), at(11, 'cadence:L1 → reviewing'), at(20, 'cadence:L1 → fixing'),
      at(25, 'cadence:L1 → reviewing'), at(30, 'cadence:L1 → fixing'), at(35, 'cadence:L1 → ready — prêt'),
      at(0, 'cadence:L2 → implementing'), at(8, 'cadence:L2 → fixing'), at(9, 'cadence:L2 → ready — prêt'),
    ));
    expect(lots.find((l) => l.lot === 'cadence:L1')!.fixes).toEqual({ porte: 1, revue: 2, autre: 0 });
    expect(lots.find((l) => l.lot === 'cadence:L2')!.fixes).toEqual({ porte: 0, revue: 0, autre: 1 });
    const i = { wave: 'w', lots, causes: [], totalMinutes: 0, lostMinutes: 0 };
    expect(renderInspection(i)).toContain('corrections : 4, détectées à la porte : 1, à la revue : 2, sans niveau : 1');
    expect(renderInspection({ ...i, lots: [] }).join('\n')).not.toContain('corrections :');
  });

  it('R3 — les reprises à la main du lead (commits « correctif du lead », « rebase du lead ») comptent en reprise du lead dans la vague où elles tombent, et en récidive', () => {
    const log = [
      '2026-11-06T09:30:00+00:00 plan: L626 revue de code enregistrée (rebase du lead)',
      '2026-11-06T09:40:00+00:00 plan: L625 revue de code enregistrée (correctif du lead)',
      '2026-11-06T09:41:00+00:00 fix(L625): autre commit',
      '2026-11-05T09:10:00+00:00 plan: L580 revue de code enregistrée après le correctif du lead',
      '2026-11-07T09:10:00+00:00 plan: L580 revue de code enregistrée (correctif du lead)',
    ].join('\n');
    const retakes = parseRetakes(log, 'cadence');
    expect(retakes.map((r) => [r.lot, r.cause])).toEqual([['cadence:L626', 'rebase du lead'], ['cadence:L625', 'correctif du lead'], ['cadence:L580', 'correctif du lead'], ['cadence:L580', 'correctif du lead']]);
    const t = journal(at(0, 'cadence:L1 → implementing'), at(50, 'cadence:L1 → ready — prêt'));
    const dir = runsIn(tempDir(), { '2026-11-05-0900': t.replace(/2026-11-06/g, '2026-11-05'), '2026-11-06-0900': t, '2026-11-07-0900': t.replace(/2026-11-06/g, '2026-11-07') });
    const i = inspectWave(dir, '2026-11-06-0900', [], retakes);
    expect(i.causes.map((c) => [c.category, c.cause, c.count, c.lots, c.recidive])).toEqual([
      ['reprise du lead', 'correctif du lead', 1, ['cadence:L625'], true],
      ['reprise du lead', 'rebase du lead', 1, ['cadence:L626'], false],
    ]);
    expect(renderInspection(i).join('\n')).toContain('reprise du lead · correctif du lead : durée dans git, non mesurée, 1 fois, 1 lot(s) · RÉCIDIVE (déjà vue : 2026-11-05-0900)');
  });

  it('R3 — inspectFolder lit les reprises du lead dans le git du projet de la vague', () => {
    const root = tempDir();
    const proj = join(root, 'solo');
    const plan = Plan.create(join(proj, '.cadence', 'raf.yaml'), 'solo', 'L', '2026-09-01');
    plan.save();
    const g = (...args: string[]) => execFileSync('git', args, { cwd: proj, encoding: 'utf8', env: { ...process.env, GIT_AUTHOR_DATE: '2026-11-06T09:30:00Z', GIT_COMMITTER_DATE: '2026-11-06T09:30:00Z', GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' } });
    g('init', '-q');
    g('add', '.cadence/raf.yaml');
    g('commit', '-q', '-m', 'plan: L4 revue de code enregistrée (correctif du lead)');
    runsIn(proj, { '2026-11-06-0900': journal(at(0, 'solo:L4 → implementing'), at(50, 'solo:L4 → ready — prêt')) });
    expect(inspectFolder(proj).causes.map((c) => [c.cause, c.lots])).toEqual([['correctif du lead', ['solo:L4']]]);
  });
});

describe('cadence inspect (L627) — tableau', () => {
  it('R6 — la colonne du lot s\'élargit au plus long id : une sous-tâche garde ses colonnes alignées', () => {
    const { lots } = measure(journal(at(0, 'maritime-atlas:Q4/toggle-time-brut → implementing'), at(3, 'maritime-atlas:Q4/toggle-time-brut → ready — prêt')));
    const [head, row] = renderInspection({ wave: 'w', lots, causes: [], totalMinutes: 3, lostMinutes: 0 }).slice(1);
    expect(row).toMatch(/^maritime-atlas:Q4\/toggle-time-brut {2}3 /);
    expect(row!.indexOf('3 ')).toBe(head!.indexOf('écriture'));
  });
});
