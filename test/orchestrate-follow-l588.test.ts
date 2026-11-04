import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { orchestrate, parseOrchestrateArgs, type OrchestrateDeps, type OrchestrateIo } from '../src/orchestrate/command.js';
import { leadLine } from '../src/orchestrate/follow.js';
import { cadenceHome, registerWave, unregisterWave } from '../src/orchestrate/registry.js';
import { RunStore } from '../src/orchestrate/state.js';
import { AGENTS_DIR } from '../src/skills.js';
import { Plan } from '../src/plan.js';
import { claudeOut, commitFile, git, kindOf, precheckReport, reviewReport, workReport } from './orchestrate-harness.js';
import { tempDir } from './helpers.js';

const fileHome = process.env.CADENCE_HOME;
beforeEach(() => {
  process.env.CADENCE_HOME = tempDir();
});
afterEach(() => {
  process.env.CADENCE_HOME = fileHome;
});

const WAVE = '2026-11-04-1000-fol';
const TS = '2026-11-04T10:00:00.000Z';

function project() {
  const parent = tempDir();
  const dir = join(parent, 'a');
  mkdirSync(dir, { recursive: true });
  git(dir, 'init', '-q', '-b', 'main');
  git(dir, 'config', 'user.email', 't@example.com');
  git(dir, 'config', 'user.name', 'T');
  git(dir, 'config', 'commit.gpgsign', 'false');
  const plan = Plan.create(join(dir, 'docs/plan/raf.yaml'), 'a', 'L', '2026-09-01');
  plan.add('un', '2026-10-01', { estimate: 1 });
  plan.save();
  writeFileSync(join(dir, 'cadence.yaml'), 'orchestrate:\n  precheck: false\n');
  git(dir, 'add', '--', 'docs/plan/raf.yaml', 'cadence.yaml');
  git(dir, 'commit', '-q', '-m', 'chore: plan');
  return { parent, dir };
}

function deps(): OrchestrateDeps {
  return {
    claude: async (args, o) => {
      const kind = kindOf(args);
      if (kind === 'precheck') return claudeOut(precheckReport());
      if (kind === 'implement' || kind === 'fix') return claudeOut(workReport({ commits: [commitFile(o.cwd, `${kind}.txt`, 'feat(L1): travail')] }));
      return claudeOut(reviewReport());
    },
    claudeInfo: () => ({ version: '2.1.289', jsonSchema: true }),
    agentsDir: AGENTS_DIR,
  };
}

function io(cwd: string) {
  const out: string[] = [];
  const err: string[] = [];
  const i: OrchestrateIo = { cwd, env: { RAF_TODAY: '2026-11-04' }, out: (l) => out.push(l), err: (l) => err.push(l), now: () => new Date('2026-11-04T10:00:00') };
  return { io: i, out, err };
}

/** Une vague réelle (terminée) dont on remplace le journal par `lines`. */
async function waveWith(lines: string[]) {
  const { parent } = project();
  expect(await orchestrate(['a:L1', '--wave', WAVE], io(parent).io, deps())).toBe(0);
  const store = RunStore.find(parent, WAVE)!;
  writeFileSync(join(store.dir, 'journal.log'), lines.map((l) => `${TS} ${l}\n`).join(''));
  return { parent, store };
}

describe('L588 — quelles lignes du journal demandent un geste du lead', () => {
  it('R1 — prêt, rendu, question, budget atteint, intégré : remontés', () => {
    for (const l of [
      'cadence:L1 → ready — prêt à livrer',
      'cadence:L1 → handed-back — revue non conforme après 3 passe(s)',
      'cadence:L1 → failed — erreur',
      'cadence:L1 → question — Quel format ?',
      'cadence:L1 → suspended — budget atteint',
      'cadence:L1 → suspended — quota atteint',
      'cadence:L1 intégré : abc1234..def5678',
      "orchestrate : cadence:L1 : rendu à l'intégration : reprise par cadence orchestrate --integrate",
    ]) expect(leadLine(l), l).toBe(true);
  });

  it('R2 — transitions de travail et bruit de fond : écartés', () => {
    for (const l of [
      'cadence:L1 → implementing',
      'cadence:L1 → reviewing',
      'cadence:L1 → fixing',
      'cadence:L1 → queued',
      'cadence:L1 → suspended — arrêt demandé (--stop-after-current)',
      'cadence:L1 → suspended — intégration reprise (--resume --integrate)',
      'cadence:L1 · session 2 fix (sonnet)',
      'cadence:L1 · worktree créé : /x',
      'orchestrate : cadence:L1 : worktree conservé : /x',
      'demande : ajouter cadence:L1 à la vague',
      'cadence:L1 · escalade fable : lot rendu malgré l\'escalade',
      'cadence:L1 CHANGELOG.md : 2 entrée(s) du lot replacée(s) sous [Unreleased]',
      '',
    ]) expect(leadLine(l), l).toBe(false);
  });

  it('R2 — un mot clé dans le TEXTE d\'une transition de travail ne la fait pas remonter', () => {
    expect(leadLine('cadence:L1 → fixing — le lot est ready pour question')).toBe(false);
    expect(leadLine('cadence:L1 · session 1 implement : a → ready')).toBe(false);
  });
});

describe('L588 — cadence orchestrate --follow', () => {
  it('R3 — arguments : --follow seul ou avec --wave et --interval ; refusé avec toute autre action', async () => {
    expect(parseOrchestrateArgs(['--follow', '--wave', 'v', '--interval', '2'])).toMatchObject({ follow: true, wave: 'v', interval: 2 });
    expect(parseOrchestrateArgs(['--status']).follow).toBe(false);
    const { parent } = project();
    const r = io(parent).io;
    for (const bad of [['a:L1'], ['--status'], ['--resume'], ['--continue'], ['--drop', 'a:L1'], ['--waits'], ['--dry-run']]) {
      await expect(orchestrate(['--follow', ...bad], r, deps()), bad.join(' ')).rejects.toThrow(/--follow/);
    }
  });

  it('R4 — n\'imprime que les lignes de geste, avec leur horodatage, puis la fin de vague (vague terminée : sans attendre)', async () => {
    const { parent } = await waveWith([
      'cadence:L1 → implementing',
      'cadence:L1 · session 1 implement (sonnet)',
      'cadence:L1 → reviewing',
      'cadence:L1 → ready — prêt à livrer',
      'cadence:L1 intégré : abc1234..def5678',
    ]);
    const r = io(parent);
    const d = deps();
    d.watchSleep = async () => {
      throw new Error('ne doit pas attendre');
    };
    expect(await orchestrate(['--follow', '--wave', WAVE], r.io, d)).toBe(0);
    expect(r.out).toEqual([`${TS} cadence:L1 → ready — prêt à livrer`, `${TS} cadence:L1 intégré : abc1234..def5678`, `fin de vague ${WAVE} : done`]);
  });

  it('R5 — suit le journal tant que la vague tourne : lignes arrivées entre deux relevés, ligne coupée attendue, fin quand la vague s\'arrête', async () => {
    const { parent, store } = await waveWith(['cadence:L1 → implementing']);
    registerWave(cadenceHome(), { pid: process.ppid, wave: WAVE, started: TS, cwd: parent, repos: ['/x/a'], cap: 2 });
    const r = io(parent);
    const d = deps();
    const log = join(store.dir, 'journal.log');
    let n = 0;
    d.watchSleep = async (ms) => {
      n++;
      expect(ms).toBe(2000);
      if (n === 1) appendFileSync(log, `${TS} cadence:L1 → reviewing\n${TS} cadence:L1 → question — Quel for`); // dernière ligne non terminée
      if (n === 2) appendFileSync(log, `mat ?\n`);
      if (n === 3) unregisterWave(cadenceHome(), process.ppid);
    };
    expect(await orchestrate(['--follow', '--wave', WAVE, '--interval', '2'], r.io, d)).toBe(0);
    expect(r.out).toEqual([`${TS} cadence:L1 → question — Quel format ?`, `fin de vague ${WAVE} : done`]);
  });

  it('R6 — vague inconnue : refus après quelques relevés ; sans --wave, la dernière vague du dossier ; aucun journal : fin sans ligne', async () => {
    const { parent, store } = await waveWith(['cadence:L1 → ready — prêt à livrer']);
    const d = deps();
    let sleeps = 0;
    d.watchSleep = async () => {
      sleeps++;
    };
    await expect(orchestrate(['--follow', '--wave', 'nope'], io(parent).io, d)).rejects.toThrow(/vague inconnue : nope/);
    expect(sleeps).toBeGreaterThan(0); // la vague nommée d'avance n'a peut-être pas encore écrit son état
    const last = io(parent);
    expect(await orchestrate(['--follow'], last.io, d)).toBe(0);
    expect(last.out[0]).toBe(`${TS} cadence:L1 → ready — prêt à livrer`);
    writeFileSync(join(store.dir, 'journal.log'), '');
    const empty = io(parent);
    expect(await orchestrate(['--follow'], empty.io, d)).toBe(0);
    expect(empty.out).toEqual([`fin de vague ${WAVE} : done`]);
  });

  it('R6 — dossier sans aucune vague : refus net, sans attente', async () => {
    const { parent } = project();
    const d = deps();
    d.watchSleep = async () => {
      throw new Error('ne doit pas attendre');
    };
    await expect(orchestrate(['--follow'], io(parent).io, d)).rejects.toThrow(/aucune vague dans ce dossier/);
  });
});
