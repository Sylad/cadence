import { afterEach, describe, expect, it } from 'vitest';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { inspectWave, measureWave, parseJournal, renderInspection, tourSummary } from '../src/inspect.js';
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
