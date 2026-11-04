import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { orchestrate, parseOrchestrateArgs, type OrchestrateDeps, type OrchestrateIo } from '../src/orchestrate/command.js';
import { leadLine } from '../src/orchestrate/follow.js';
import { cadenceHome, registerWave, unregisterWave } from '../src/orchestrate/registry.js';
import { RunStore } from '../src/orchestrate/state.js';
import { AGENTS_DIR } from '../src/skills.js';
import { PLAN_DEFAULT } from '../src/config.js';
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
  const plan = Plan.create(join(dir, PLAN_DEFAULT), 'a', 'L', '2026-09-01');
  plan.add('un', '2026-10-01', { estimate: 1 });
  plan.save();
  writeFileSync(join(dir, 'cadence.yaml'), 'orchestrate:\n  precheck: false\n');
  git(dir, 'add', '--', PLAN_DEFAULT, 'cadence.yaml');
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

  it('R1 — incident : un lot suspendu par un push détecté, un dépôt sali ou un HEAD déplacé est remonté (le lead a un geste à faire avant de reprendre)', () => {
    for (const l of [
      'cadence:L1 → suspended — vague arrêtée : push détecté sur cadence pendant la vague',
      'cadence:L1 → suspended — dépôt /x/a sali par la revue de cadence:L2 : à nettoyer par le lead avant de reprendre',
      'cadence:L1 → suspended — dépôt /x/a laissé en HEAD déplacé par cadence:L2 : à remettre sur sa branche par le lead avant de reprendre',
    ]) expect(leadLine(l), l).toBe(true);
  });

  it('R2 — transitions de travail, suspensions qui sont le geste du lead lui-même et bruit de fond : écartés', () => {
    for (const l of [
      'cadence:L1 → implementing',
      'cadence:L1 → reviewing',
      'cadence:L1 → fixing',
      'cadence:L1 → queued',
      'cadence:L1 → suspended — arrêt demandé (--stop-after-current)',
      'cadence:L1 → suspended — intégration reprise (--resume --integrate)',
      'cadence:L1 → suspended — intégration reprise (--resume --integrate) : revue conforme du lead hors vague, abc1234',
      'cadence:L1 → suspended — budget relevé de 3 à 5 (--resume --budget)',
      'cadence:L1 → suspended — écriture du plan reprise à l\'étape fix (--resume --replay)',
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

/** Inscrit la vague au registre des vagues vivantes, sous le pid du parent (vivant tant que le test tourne). */
function register(parent: string) {
  registerWave(cadenceHome(), { pid: process.ppid, wave: WAVE, started: TS, cwd: parent, repos: ['/x/a'], cap: 2 });
}
const unregister = () => unregisterWave(cadenceHome(), process.ppid);

/** Un suivi dont `at[n]` est joué au n-ième sommeil ; `sleeps` compte les sommeils, `ms` garde la durée demandée. */
function follow(parent: string, at: Record<number, () => void>, extra: string[] = []) {
  const r = io(parent);
  const d = deps();
  const seen = { sleeps: 0, ms: 0 };
  d.watchSleep = async (ms) => {
    seen.sleeps++;
    seen.ms = ms;
    at[seen.sleeps]?.();
  };
  return { run: () => orchestrate(['--follow', '--wave', WAVE, ...extra], r.io, d), out: r.out, seen };
}

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

  it('R4 — n\'imprime que les lignes de geste écrites APRÈS son armement, avec leur horodatage : un second suivi (après --resume) ne rejoue pas le journal', async () => {
    const { parent, store } = await waveWith(['cadence:L1 → ready — prêt à livrer', 'cadence:L1 → question — Déjà répondue ?']);
    register(parent);
    const log = join(store.dir, 'journal.log');
    const f = follow(parent, {
      1: () => appendFileSync(log, `${TS} cadence:L1 → implementing\n${TS} cadence:L1 · session 1 implement (sonnet)\n${TS} cadence:L1 → reviewing\n${TS} cadence:L2 → ready — prêt à livrer\n${TS} cadence:L2 intégré : abc1234..def5678\n`),
      2: unregister,
    });
    expect(await f.run()).toBe(0);
    expect(f.out).toEqual([`${TS} cadence:L2 → ready — prêt à livrer`, `${TS} cadence:L2 intégré : abc1234..def5678`, `fin de vague ${WAVE} : done`]);
  });

  it('R4 — vague déjà terminée et hors registre : six relevés (sa reprise peut être en train de s\'inscrire), puis « fin de vague » sans rejouer le journal', async () => {
    const { parent } = await waveWith(['cadence:L1 → ready — prêt à livrer']);
    const f = follow(parent, {});
    expect(await f.run()).toBe(0);
    expect(f.seen).toEqual({ sleeps: 6, ms: 5000 });
    expect(f.out).toEqual([`fin de vague ${WAVE} : done`]);
  });

  it('R5 — suit le journal tant que la vague tourne : lignes arrivées entre deux relevés, ligne coupée attendue, fin six relevés après que la vague a quitté le registre', async () => {
    const { parent, store } = await waveWith(['cadence:L1 → implementing']);
    register(parent);
    const log = join(store.dir, 'journal.log');
    const f = follow(parent, {
      1: () => appendFileSync(log, `${TS} cadence:L1 → reviewing\n${TS} cadence:L1 → question — Quel for`), // dernière ligne non terminée
      2: () => appendFileSync(log, `mat ?\n`),
      3: unregister,
    }, ['--interval', '2']);
    expect(await f.run()).toBe(0);
    expect(f.seen).toEqual({ sleeps: 9, ms: 2000 });
    expect(f.out).toEqual([`${TS} cadence:L1 → question — Quel format ?`, `fin de vague ${WAVE} : done`]);
  });

  it('R5 — entrée multi-ligne (journal réel 2026-10-06 warhammer40k:L74) : les lignes de suite sans horodatage suivent le sort de leur entrée, même arrivées dans un relevé plus tard ; celles d\'une transition de travail sont écartées', async () => {
    const { parent, store } = await waveWith(['warhammer40k:L74 → implementing']);
    register(parent);
    const log = join(store.dir, 'journal.log');
    const question = `${TS} warhammer40k:L74 → question — STOP, étape 2 du lot. 3 fichiers « contenu » de la prod diffèrent du dépôt : units.json (1 unité sur 133), timeline-events.json (5 sources) et primarchs.json (1 fiche). Détail de chaque écart ci-dessous.`;
    const suite = ['— units.json, sm-primaris-intercessor. La prod garde l\'ancien texte : role « Infanterie de ligne ».', '— timeline-events.json, 5 URL de sources[1]. Fall_of_the_Eldar → Fall_of_the_Aeldari.', '— primarchs.json, fiche Mortarion. La prod a encore « typhus » dans relatedPrimarchIds.'];
    const f = follow(parent, {
      1: () => appendFileSync(log, `${question}\n${suite[0]}\n`),
      2: () => appendFileSync(log, `${suite[1]}\n${suite[2]}\n${TS} warhammer40k:L75 → implementing\n— détail d\'une transition de travail : écarté\n`),
      3: () => appendFileSync(log, `${TS} warhammer40k:L75 → handed-back — fiche non conforme après 2 revues :\n— 1 majeur (datasheet manquante)\n`),
      4: unregister,
    });
    expect(await f.run()).toBe(0);
    expect(f.out).toEqual([question, ...suite, `${TS} warhammer40k:L75 → handed-back — fiche non conforme après 2 revues :`, '— 1 majeur (datasheet manquante)', `fin de vague ${WAVE} : done`]);
  });

  it('R5 — vague reprise : état déjà écrit (suspended-budget ou done), inscription au registre en retard — le suivi attend la reprise au lieu de finir', async () => {
    for (const status of ['suspended-budget', 'done'] as const) {
      const { parent, store } = await waveWith(['cadence:L1 → ready — prêt à livrer']);
      store.writeWave({ ...store.readWave()!, status });
      const log = join(store.dir, 'journal.log');
      const f = follow(parent, {
        5: () => register(parent),
        6: () => appendFileSync(log, `${TS} cadence:L1 → question — Quel format ?\n`),
        7: () => {
          store.writeWave({ ...store.readWave()!, status: 'done' });
          unregister();
        },
      });
      expect(await f.run(), status).toBe(0);
      expect(f.seen.sleeps, status).toBe(13);
      expect(f.out, status).toEqual([`${TS} cadence:L1 → question — Quel format ?`, `fin de vague ${WAVE} : done`]);
    }
  });

  it('R5 — vague --continue : un relevé hors registre entre deux tours ne finit pas le suivi, les questions du tour suivant arrivent', async () => {
    const { parent, store } = await waveWith(['cadence:L1 → ready — prêt à livrer']);
    register(parent);
    const log = join(store.dir, 'journal.log');
    const f = follow(parent, {
      2: () => {
        store.writeWave({ ...store.readWave()!, status: 'done' });
        unregister();
      },
      3: () => register(parent),
      4: () => appendFileSync(log, `${TS} cadence:L2 → question — Tour 2 ?\n`),
      5: () => {
        store.writeWave({ ...store.readWave()!, status: 'suspended-budget' });
        unregister();
      },
    });
    expect(await f.run()).toBe(0);
    expect(f.out).toEqual([`${TS} cadence:L2 → question — Tour 2 ?`, `fin de vague ${WAVE} : suspended-budget`]);
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
    register(parent);
    const log = join(store.dir, 'journal.log');
    const last = io(parent);
    d.watchSleep = async () => {
      appendFileSync(log, `${TS} cadence:L1 → question — Quel format ?\n`);
      unregister();
    };
    expect(await orchestrate(['--follow'], last.io, d)).toBe(0);
    expect(last.out[0]).toBe(`${TS} cadence:L1 → question — Quel format ?`);
    writeFileSync(log, '');
    d.watchSleep = async () => {};
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
