import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { claudeOut, commitFile, reviewReport } from './orchestrate-harness.js';
import { fake, lotOf, run, setup, store, until, WAVE } from './orchestrate-worktree-harness.js';
import { cadenceHome, registerWave, unregisterWave } from '../src/orchestrate/registry.js';
import { DROPPED, HYPOTHESES_HANDBACK } from '../src/orchestrate/cycle.js';
import { DOCS_GAP, lotGesture } from '../src/orchestrate/geste.js';
import { renderTable } from '../src/orchestrate/table.js';
import type { LotState, WaveState } from '../src/orchestrate/state.js';
import { tempDir } from './helpers.js';

// L554 — chaque refus d'orchestrate et chaque lot rendu imprime LE geste suivant exact.
const fileHome = process.env.CADENCE_HOME;
beforeEach(() => {
  process.env.CADENCE_HOME = tempDir();
});
afterEach(() => {
  process.env.CADENCE_HOME = fileHome;
});

const lot = (over: Partial<LotState>): LotState => ({ project: 'a', lot: 'L1', status: 'handed-back', next: null, outcome: null, steps: [], pass: 0, answers: [], questions: [], warnings: [], constats: [], proposals: [], ...over }) as unknown as LotState;
const WAVE_ID = '2026-10-04-1412';
const live = { id: WAVE_ID, status: 'running' } as const;
const stopped = { id: WAVE_ID, status: 'suspended' } as const;

describe("L554 — le geste d'un lot rendu (lotGesture)", () => {
  it("R1 — un lot rendu pour docs.sync : « raf docs-ok » puis, à la fin d'une vague vivante, --resume --wave W --replay P:L", () => {
    const l = lot({ outcome: `${DOCS_GAP} : README.md sans la documentation attendue` });
    expect(lotGesture(live, l)).toBe(`raf docs-ok L1 --reason "…", puis à la fin de la vague : cadence orchestrate --resume --wave ${WAVE_ID} --replay a:L1`);
    expect(lotGesture(stopped, l)).toBe(`raf docs-ok L1 --reason "…", puis : cadence orchestrate --resume --wave ${WAVE_ID} --replay a:L1`);
  });
  it("R2 — rendu à l'intégration : --integrate (déposé tout de suite, même sur une vague vivante) ; écriture de plan refusée : --replay", () => {
    expect(lotGesture(live, lot({ next: 'integrate', outcome: 'rebase' }))).toBe(`cadence orchestrate --resume --wave ${WAVE_ID} --integrate a:L1`);
    expect(lotGesture(stopped, lot({ next: 'review', outcome: `${HYPOTHESES_HANDBACK} x` }))).toBe(`cadence orchestrate --resume --wave ${WAVE_ID} --replay a:L1`);
    expect(lotGesture(live, lot({ next: 'review', outcome: `${HYPOTHESES_HANDBACK} x` }))).toBe(`à la fin de la vague : cadence orchestrate --resume --wave ${WAVE_ID} --replay a:L1`);
  });
  it('R3 — lot retiré (--drop) : nouvelle vague ; lot rendu sans geste connu, ou lot non rendu : rien', () => {
    expect(lotGesture(live, lot({ outcome: DROPPED }))).toBe('cadence orchestrate a:L1');
    expect(lotGesture(live, lot({ outcome: 'revue non conforme' }))).toBe('');
    expect(lotGesture(live, lot({ outcome: null }))).toBe('');
    expect(lotGesture(live, lot({ status: 'ready', outcome: DOCS_GAP }))).toBe('');
  });
});

describe('L554 — la colonne « geste » de status', () => {
  const wave = { id: WAVE_ID, status: 'running', budget: 1_000_000, consumed: 0, cacheRead: 0, lots: ['a:L1', 'a:L2'] } as unknown as WaveState;
  const deps = { isAncestor: () => false, lotCommits: () => [], now: 0 };
  it('R4 — une colonne « geste » porte la commande de chaque lot rendu, vide pour les autres', () => {
    const rows = renderTable(wave, [lot({ next: 'integrate', outcome: 'x' }), lot({ lot: 'L2', status: 'ready' })], deps);
    expect(rows[0]).toMatch(/\bgeste$/);
    expect(rows[1]).toContain(`cadence orchestrate --resume --wave ${WAVE_ID} --integrate a:L1`);
    expect(rows[2]).not.toContain('--integrate');
  });
  it('R4 — sans lot rendu à geste connu, pas de colonne « geste »', () => {
    expect(renderTable(wave, [lot({ status: 'ready' }), lot({ lot: 'L2', outcome: 'revue non conforme' })], deps)[0]).not.toContain('geste');
  });
});

const blocking = () => claudeOut(reviewReport({ bloquants: 1, constats: [{ gravite: 'bloquant', fichier: 'L1-implement.txt', ligne: 1, texte: 'à corriger' }], verdict: 'non conforme : un bloquant' }));

/** Une vague L1 + L2 vivante (faux pid) : L1 est rendu ; `onL2` agit pendant que L2 « tourne ». */
async function liveWave(onL2: (parent: string) => Promise<void>, fakePid = true) {
  const { parent } = setup([{ title: 'un' }, { title: 'deux' }]);
  const f = fake({
    review: (_cwd, brief) => (lotOf(brief) === 'L1' ? blocking() : claudeOut(reviewReport())),
    implement: async (cwd, brief) => {
      const l = lotOf(brief);
      if (l === 'L2') {
        await until(() => store(parent).readLot('a', 'L1')?.status === 'handed-back');
        // la vague jouée dans ce processus est déjà inscrite vivante : un second faux pid la rendrait ambiguë pour --add (plusieurs vagues)
        if (fakePid) registerWave(cadenceHome(), { pid: process.ppid, wave: WAVE, started: 'x', cwd: parent, repos: [] });
        try {
          await onL2(parent);
        } finally {
          if (fakePid) unregisterWave(cadenceHome(), process.ppid);
        }
      }
      return claudeOut({ commits: [commitFile(cwd, `${l}.txt`, `feat(${l}): travail`)], tests: { commande: 'x', resultat: 'ok', vert: true }, build: { commande: 'x', resultat: 'ok', vert: true }, nonVerifie: [], questions: [], resume: 'ok', choix: [] });
    },
  });
  await run(parent, ['a:L1', 'a:L2', '--max-sessions', '2'], f);
  return parent;
}

describe("L554 — les refus d'une vague vivante disent le geste", () => {
  it("R1/R5 — --integrate d'un lot rendu pour docs.sync, sur une vague vivante : le refus dit raf docs-ok puis le --replay de la fin de vague", async () => {
    let err = '';
    await liveWave(async (parent) => {
      const s = store(parent);
      const l = s.readLot('a', 'L1')!;
      l.outcome = `${DOCS_GAP} : README.md sans la documentation attendue`;
      l.next = null;
      s.writeLot(l);
      err = (await run(parent, ['--resume', '--wave', WAVE, '--integrate', 'a:L1'], fake())).err;
    });
    expect(err).toContain('raf docs-ok L1 --reason');
    expect(err).toContain(`à la fin de la vague : cadence orchestrate --resume --wave ${WAVE} --replay a:L1`);
  });
  it('R5 — --replay sur une vague vivante : le refus « tourne encore » donne la commande à jouer à la fin', async () => {
    let err = '';
    await liveWave(async (parent) => {
      err = (await run(parent, ['--resume', '--wave', WAVE, '--replay', 'a:L1'], fake())).err;
    });
    expect(err).toMatch(/la vague \S+ tourne encore/);
    expect(err).toContain(`à la fin de la vague : cadence orchestrate --resume --wave ${WAVE} --replay a:L1`);
  });
  it('R5 — --remove-worktree d\'un lot de la vague vivante : le refus donne la commande à jouer à la fin', async () => {
    let err = '';
    await liveWave(async (parent) => {
      err = (await run(parent, ['--remove-worktree', 'a:L2', '--wave', WAVE], fake())).err;
    });
    expect(err).toContain('worktree non retirable');
    expect(err).toContain(`à la fin de la vague : cadence orchestrate --remove-worktree a:L2 --wave ${WAVE}`);
  });
  it('R6 — --add d\'un lot déjà retiré de la vague (--drop) : le refus dit de le lancer dans une nouvelle vague', async () => {
    let err = '';
    await liveWave(async (parent) => {
      const s = store(parent);
      const l = s.readLot('a', 'L1')!;
      l.outcome = DROPPED;
      s.writeLot(l);
      err = (await run(parent, ['--add', 'a:L1', '--wave', WAVE], fake())).err;
    }, false);
    expect(err).toMatch(/a:L1 : lot déjà dans la vague/);
    expect(err).toContain('retiré de la vague : le lancer dans une nouvelle vague : cadence orchestrate a:L1');
  });
});
