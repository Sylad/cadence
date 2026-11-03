import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { claudeOut, commitFile, git, reviewReport } from './orchestrate-harness.js';
import { fake, lotOf, run, setup, store, until, WAVE } from './orchestrate-worktree-harness.js';
import { lotTreeDir } from '../src/orchestrate/worktree.js';
import { cadenceHome, registerWave, unregisterWave } from '../src/orchestrate/registry.js';
import { waveReadsIntegrateQueue } from '../src/orchestrate/snapshot.js';
import { RunStore } from '../src/orchestrate/state.js';
import { Plan } from '../src/plan.js';
import { tempDir } from './helpers.js';

// L532 — `--resume --wave <vague> --integrate <lot>` sur une vague qui tourne encore dépose l'intégration dans sa file (`integrates.log`) au lieu de refuser
// « la vague … tourne encore » ; la vague la prend entre deux étapes, comme un --add (L421) ou une réponse (L407).
const fileHome = process.env.CADENCE_HOME;
beforeEach(() => {
  process.env.CADENCE_HOME = tempDir();
});
afterEach(() => {
  process.env.CADENCE_HOME = fileHome;
});

const blocking = () => claudeOut(reviewReport({ bloquants: 1, constats: [{ gravite: 'bloquant', fichier: 'L1-implement.txt', ligne: 1, texte: 'à corriger' }], verdict: 'non conforme : un bloquant' }));
const fixed = (cwd: string) => claudeOut({ commits: [commitFile(cwd, 'L1-fix.txt', 'fix(L1): travail')], tests: { commande: 'x', resultat: 'ok', vert: true }, build: { commande: 'x', resultat: 'ok', vert: true }, nonVerifie: [], questions: [], resume: 'ok', choix: [] });

/** Le lead corrige L1 dans son worktree et y enregistre sa revue conforme (plan du worktree, commité). */
function leadFixes(dir: string, review: boolean) {
  commitFile(dir, 'lead.txt', 'fix(L1): correction du lead hors vague');
  if (!review) return;
  const plan = Plan.load(join(dir, '.cadence/raf.yaml'));
  plan.recordReview('L1', 'conforme : relu par le lead', '2026-10-27', git(dir, 'rev-parse', 'HEAD'));
  plan.save();
  git(dir, 'add', '--', '.cadence/raf.yaml');
  git(dir, 'commit', '-q', '-m', 'plan: revue du lead L1');
}

/**
 * Une vague L1 + L2 : L1 est rendu sur une revue non conforme ; L2 « tourne » (sa session attend `onL2`) pendant que le lead agit.
 * `registerWave` d'un faux pid vivant (celui du parent) : la reprise voit « la vague tourne encore », comme depuis un autre terminal.
 */
async function liveWave(onL2: (ctx: { parent: string; repo: string; dir: string; out: string[]; err: string[] }) => Promise<void>, lots = 2) {
  const { parent, repo } = setup(Array.from({ length: lots }, (_, i) => ({ title: `lot ${i + 1}` })));
  const seen = { out: [] as string[], err: [] as string[] };
  const f = fake({
    review: (_cwd, brief) => (lotOf(brief) === 'L1' ? blocking() : claudeOut(reviewReport())),
    fix: (cwd, brief) => (lotOf(brief) === 'L1' ? fixed(cwd) : claudeOut(reviewReport())),
    implement: async (cwd, brief) => {
      const lot = lotOf(brief);
      if (lot === 'L2') {
        await until(() => store(parent).readLot('a', 'L1')?.status === 'handed-back');
        registerWave(cadenceHome(), { pid: process.ppid, wave: WAVE, started: 'x', cwd: parent, repos: [] });
        try {
          await onL2({ parent, repo, dir: lotTreeDir(store(parent).dir, 'a', 'L1', repo), ...seen });
        } finally {
          unregisterWave(cadenceHome(), process.ppid);
        }
      }
      return claudeOut({ commits: [commitFile(cwd, `${lot}.txt`, `feat(${lot}): travail`)], tests: { commande: 'x', resultat: 'ok', vert: true }, build: { commande: 'x', resultat: 'ok', vert: true }, nonVerifie: [], questions: [], resume: 'ok', choix: [] });
    },
  });
  const first = await run(parent, ['a:L1', 'a:L2', '--max-sessions', '2'], f);
  return { parent, repo, first, f, ...seen };
}

const resumeIntegrate = (parent: string, ...extra: string[]) => run(parent, ['--resume', '--wave', WAVE, '--integrate', 'a:L1', ...extra], fake());

describe('L532 — intégration déposée sur une vague vivante', () => {
  it("R1 — --resume --integrate d'un lot rendu, revu conforme par le lead, est déposé pendant que la vague tourne ; la vague l'intègre avant sa fin", async () => {
    let said = '';
    let readyBeforeEnd = false;
    const w = await liveWave(async ({ parent, dir }) => {
      leadFixes(dir, true);
      const r = await resumeIntegrate(parent);
      said = `${r.code} ${r.out} ${r.err}`;
      await until(() => store(parent).readLot('a', 'L1')?.status === 'ready');
      readyBeforeEnd = store(parent).readLot('a', 'L1')?.status === 'ready' && store(parent).readLot('a', 'L2')?.status !== 'ready';
    });
    expect(said).toMatch(/^0 [\s\S]*a:L1 : intégration déposée/);
    expect(readyBeforeEnd).toBe(true);
    const s = store(w.parent);
    expect(s.readLot('a', 'L1')!.status).toBe('ready');
    expect(git(w.repo, 'log', '--format=%s', 'main')).toContain('fix(L1): correction du lead hors vague');
    expect(s.integrateQueue()).toEqual([]);
    expect(readFileSync(join(s.dir, 'journal.log'), 'utf8')).toMatch(/a:L1 → suspended — intégration reprise \(--resume --integrate\) : revue conforme du lead hors vague/);
    expect(s.readWave()!.status).toBe('done');
  });

  it("R557 — un --drop déjà appliqué est consommé par l'intégration prise sur la vague vivante : le lot est intégré, jamais rendu « retiré de la vague » (issue #26)", async () => {
    const w = await liveWave(async ({ parent, dir }) => {
      store(parent).requestDrop('a:L1');
      store(parent).requestDrop('a:L2');
      leadFixes(dir, true);
      await resumeIntegrate(parent);
      await until(() => store(parent).readLot('a', 'L1')?.status === 'ready');
    });
    const s = store(w.parent);
    expect(s.readLot('a', 'L1')!.status).toBe('ready');
    expect(s.control().drops).toEqual(['a:L2']);
    expect(readFileSync(join(s.dir, 'journal.log'), 'utf8')).not.toMatch(/a:L1 → handed-back — retiré de la vague/);
  });

  it("R2 — un lot sans revue du lead, inconnu, ou qui n'est pas rendu est refusé (code 2) et rien n'est déposé", async () => {
    const codes: { code: number; err: string }[] = [];
    const w = await liveWave(async ({ parent, dir }) => {
      leadFixes(dir, false); // corrigé mais pas revu
      const noReview = await resumeIntegrate(parent);
      codes.push({ code: noReview.code, err: noReview.err });
      const unknown = await run(parent, ['--resume', '--wave', WAVE, '--integrate', 'a:L9'], fake());
      codes.push({ code: unknown.code, err: unknown.err });
      const running = await run(parent, ['--resume', '--wave', WAVE, '--integrate', 'a:L2'], fake());
      codes.push({ code: running.code, err: running.err });
      expect(store(parent).integrateQueue()).toEqual([]);
    });
    expect(codes.map((c) => c.code)).toEqual([2, 2, 2]);
    expect(codes[0].err).toMatch(/--integrate a:L1 : le lot n'est pas rendu à l'étape d'intégration/);
    expect(codes[1].err).toMatch(/a:L9 : lot inconnu/);
    expect(codes[2].err).toMatch(/a:L2 : le lot n'est pas rendu/);
    expect(store(w.parent).readLot('a', 'L1')!.status).toBe('handed-back');
  });

  it("R3 — le même lot visé deux fois dans la commande est refusé, rien n'est déposé", async () => {
    let seen: { code: number; err: string } | undefined;
    await liveWave(async ({ parent, dir }) => {
      leadFixes(dir, true);
      const r = await resumeIntegrate(parent, '--integrate', 'a:L1');
      seen = { code: r.code, err: r.err };
      expect(store(parent).integrateQueue()).toEqual([]);
    });
    expect(seen!.code).toBe(2);
    expect(seen!.err).toMatch(/--integrate a:L1 : lot visé deux fois/);
  });

  it("R4 — déposée deux fois (deux commandes), l'intégration n'est jouée qu'une fois : la seconde est écartée et dite au journal", async () => {
    const w = await liveWave(async ({ parent, dir }) => {
      leadFixes(dir, true);
      expect((await resumeIntegrate(parent)).code).toBe(0);
      expect((await resumeIntegrate(parent)).code).toBe(0);
      await until(() => store(parent).readLot('a', 'L1')?.status === 'ready');
      await until(() => store(parent).integrateQueue().length === 0);
    });
    const s = store(w.parent);
    expect(s.readLot('a', 'L1')!.status).toBe('ready');
    expect(git(w.repo, 'log', '--format=%s', 'main').split('\n').filter((x) => x.startsWith('fix(L1): correction du lead'))).toHaveLength(1);
    expect(s.integrateQueue()).toEqual([]);
    expect(readFileSync(join(s.dir, 'journal.log'), 'utf8')).toMatch(/a:L1 : intégration écartée \(le lot n'est plus rendu/);
  });

  it("R5 — une demande dont le lot a été changé avant la prise (revue du lead perdue) est écartée, jamais jouée", async () => {
    const w = await liveWave(async ({ parent, dir }) => {
      leadFixes(dir, true);
      commitFile(dir, 'apres.txt', 'fix(L1): commit après la revue'); // la revue ne porte plus le dernier commit
      store(parent).requestIntegrate('a:L1');
      await until(() => store(parent).integrateQueue().length === 0);
    });
    const s = store(w.parent);
    expect(s.readLot('a', 'L1')!.status).toBe('handed-back');
    expect(readFileSync(join(s.dir, 'journal.log'), 'utf8')).toMatch(/a:L1 : intégration écartée \(/);
  });

  it("R6 — la file : ajout, relecture, marque « prise » ; absente, elle est vide ; une ligne illisible est ignorée", () => {
    const s = new RunStore(tempDir(), 'w1');
    expect(s.integrateQueue()).toEqual([]);
    const a = s.requestIntegrate('a:L1');
    const b = s.requestIntegrate('b:L2');
    expect(s.integrateQueue().map((e) => [e.id, e.lot])).toEqual([[a, 'a:L1'], [b, 'b:L2']]);
    s.markIntegrateTaken(a);
    expect(s.integrateQueue().map((e) => e.id)).toEqual([b]);
    writeFileSync(join(s.dir, 'integrates.log'), `${readFileSync(join(s.dir, 'integrates.log'), 'utf8')}{pas du json\n`);
    expect(s.integrateQueue().map((e) => e.id)).toEqual([b]);
    expect(s.lots()).toEqual([]);
  });

  it("R7 — une vague d'avant L532 ne lit pas la file : l'intégration est refusée (code 2), rien n'est écrit", async () => {
    let seen: { code: number; err: string; queued: number } | undefined;
    await liveWave(async ({ parent, dir }) => {
      leadFixes(dir, true);
      const s = store(parent);
      mkdirSync(join(s.dir, 'tool', 'bin'), { recursive: true });
      mkdirSync(join(s.dir, 'tool', 'dist', 'orchestrate'), { recursive: true });
      writeFileSync(join(s.dir, 'tool', 'bin', 'cadence.js'), '');
      writeFileSync(join(s.dir, 'tool', 'dist', 'orchestrate', 'state.js'), "// avant L532 : adds.log\n");
      const r = await resumeIntegrate(parent);
      seen = { code: r.code, err: r.err, queued: s.integrateQueue().length };
      writeFileSync(join(s.dir, 'tool', 'dist', 'orchestrate', 'state.js'), "join(this.dir, 'integrates.log')\n");
      expect(waveReadsIntegrateQueue(s.dir)).toBe(true);
    });
    expect(seen).toMatchObject({ code: 2, queued: 0 });
    expect(seen!.err).toMatch(/ne lit pas la file d'intégrations/);
  });

  it('R7 — sans instantané (vague jouée dans ce processus ou antérieure à L61) : on suppose que la vague lit la file', () => {
    expect(waveReadsIntegrateQueue(tempDir())).toBe(true);
  });

  it("R8 — avec une autre option de reprise (--budget, --drop, --continue) ou --replay, le refus « tourne encore » reste et rien n'est déposé", async () => {
    const errs: string[] = [];
    await liveWave(async ({ parent, dir }) => {
      leadFixes(dir, true);
      for (const extra of [['--budget', '1M'], ['--drop', 'a:L2'], ['--continue']]) errs.push((await resumeIntegrate(parent, ...extra)).err);
      errs.push((await run(parent, ['--resume', '--wave', WAVE, '--replay', 'a:L1'], fake())).err);
      expect(store(parent).integrateQueue()).toEqual([]);
    });
    expect(errs).toHaveLength(4);
    for (const e of errs) expect(e).toMatch(/tourne encore/);
  });
});
