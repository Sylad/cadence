import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { spawn } from 'node:child_process';
import { appendFileSync, existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { run as rafRun } from '../src/cli.js';
import { sharedStateDir } from '../src/state.js';
import { REPO_LOCK } from '../src/orchestrate/lock.js';
import { cadenceHome, registerWave, unregisterWave } from '../src/orchestrate/registry.js';
import { claudeOut, commitFile, git, workReport } from './orchestrate-harness.js';
import { branches, conflictWave, fake, lotOf, meeting, planOf, run, setup, store, subjects, until, WAVE, writes } from './orchestrate-worktree-harness.js';
import { tempDir } from './helpers.js';

// L279 — C3 : reprise d'une vague qui laissait des worktrees (R11, R12, R14, R19, R20, R27) et C4 (R13).
const fileHome = process.env.CADENCE_HOME;
beforeEach(() => {
  process.env.CADENCE_HOME = tempDir();
});
afterEach(() => {
  process.env.CADENCE_HOME = fileHome;
});

/** Vague arrêtée sur budget juste après l'implémentation : les deux lots ont un worktree et un commit, suspendus à la revue. */
async function suspendedWave() {
  const { parent, repo } = setup();
  const f = fake({ implement: writes(meeting(2)) });
  const r = await run(parent, ['a:L1', 'a:L2', '--max-sessions', '2', '--budget', '2000'], f);
  return { parent, repo, r };
}
const treeOf = (parent: string, lot: string) => join(store(parent).dir, 'worktrees', `a--${lot}`);

describe('R11 — reprise dans les worktrees retrouvés', () => {
  it('R11 — reprise d\'un lot suspendu : même chemin de worktree, mêmes commits', async () => {
    const { parent, r } = await suspendedWave();
    expect(r.code).toBe(3);
    const l1 = store(parent).readLot('a', 'L1')!;
    expect(l1.status).toBe('suspended');
    const dir = treeOf(parent, 'L1');
    const tip = git(dir, 'rev-parse', 'HEAD');
    const seen: string[] = [];
    const g = fake({
      review: async (cwd, brief) => {
        if (lotOf(brief) === 'L1') seen.push(`${cwd}|${git(cwd, 'rev-parse', 'HEAD')}`);
        return claudeOut({ bloquants: 0, majeurs: 0, mineurs: 0, constats: [], sousTaches: [], nonVerifie: [], verdict: 'conforme' });
      },
    });
    const again = await run(parent, ['--resume', WAVE, '--budget', '5M'], g);
    expect(again.err).toBe('');
    expect(again.code).toBe(0);
    expect(seen).toEqual([`${dir}|${tip}`]); // la revue relit le travail commité avant l'arrêt, dans le même worktree
    expect(g.calls.filter((c) => c.kind === 'implement')).toHaveLength(0);
    expect(store(parent).readLot('a', 'L1')!.status).toBe('ready');
  });
  it('R11 — reprise avec worktree de lot sale : code 2, état de la vague inchangé', async () => {
    const { parent } = await suspendedWave();
    appendFileSync(join(treeOf(parent, 'L1'), 'base.txt'), 'travail non commité\n');
    const waveFile = join(store(parent).dir, 'wave.json');
    const before = [readFileSync(waveFile, 'utf8'), readFileSync(join(store(parent).dir, 'a--L1.json'), 'utf8')];
    const g = fake();
    const again = await run(parent, ['--resume', WAVE, '--budget', '5M'], g);
    expect(again.code).toBe(2);
    expect(again.err).toMatch(/orchestrate : a--L1 : arbre sale, 1 fichier\(s\) suivi\(s\) modifié\(s\) : base\.txt/);
    expect(g.calls).toHaveLength(0);
    expect([readFileSync(waveFile, 'utf8'), readFileSync(join(store(parent).dir, 'a--L1.json'), 'utf8')]).toEqual(before);
  });
  it('R11 — worktree enregistré mais dossier disparu : élagué et recréé sur la branche existante', async () => {
    const { parent, repo } = await suspendedWave();
    const dir = treeOf(parent, 'L1');
    const tip = git(dir, 'rev-parse', 'HEAD');
    rmSync(dir, { recursive: true, force: true });
    const seen: string[] = [];
    const g = fake({
      review: async (cwd, brief) => {
        if (lotOf(brief) === 'L1') seen.push(`${cwd}|${git(cwd, 'rev-parse', 'HEAD')}`);
        return claudeOut({ bloquants: 0, majeurs: 0, mineurs: 0, constats: [], sousTaches: [], nonVerifie: [], verdict: 'conforme' });
      },
    });
    const again = await run(parent, ['--resume', WAVE, '--budget', '5M'], g);
    expect(again.code).toBe(0);
    expect(seen).toEqual([`${dir}|${tip}`]);
    expect(existsSync(join(repo, 'L1.txt'))).toBe(true);
  });
});

describe('R12 — jamais de suppression de commits non intégrés', () => {
  it('R12 — lot rendu : worktree et branche conservés et chemin journalisé', async () => {
    const { r, repo, dir, branch } = await conflictWave();
    expect(existsSync(dir)).toBe(true);
    expect(branches(repo)).toContain(branch);
    expect(r.out).toContain(`orchestrate : a:L1 : worktree conservé : ${dir} (branche ${branch})`);
  });
  it('R12 — lot retiré par --drop avec commits non intégrés : worktree et branche conservés', async () => {
    const { parent, repo } = await suspendedWave();
    const g = fake();
    const again = await run(parent, ['--resume', WAVE, '--drop', 'a:L1', '--budget', '5M'], g);
    expect(again.code).toBe(1);
    expect(store(parent).readLot('a', 'L1')!.status).toBe('handed-back');
    expect(existsSync(treeOf(parent, 'L1'))).toBe(true);
    expect(branches(repo)).toContain('a--L1');
    expect(again.out).toContain(`orchestrate : a:L1 : worktree conservé : ${treeOf(parent, 'L1')} (branche cadence/${WAVE}/a--L1)`);
    expect(store(parent).readLot('a', 'L2')!.status).toBe('ready');
  });
});

describe('R13 — une seule vague par dépôt', () => {
  it('R13 — seconde vague sur un dépôt à worktrees : refus, aucun worktree créé', async () => {
    const { parent, repo } = setup();
    const sleeper = spawn('sleep', ['30'], { stdio: 'ignore' });
    try {
      writeFileSync(join(sharedStateDir(repo), REPO_LOCK), JSON.stringify({ pid: sleeper.pid, wave: 'première', started: '2026-10-24T00:00:00Z' }));
      const g = fake();
      const r = await run(parent, ['a:L1', 'a:L2'], g);
      expect(r.code).toBe(2);
      expect(r.err).toMatch(new RegExp(`orchestrate : a : une orchestration y est déjà en cours \\(première, pid ${sleeper.pid}\\)`));
      expect(g.calls).toHaveLength(0);
      expect(branches(repo)).toBe('');
      expect(existsSync(join(store(parent).dir, 'worktrees'))).toBe(false);
    } finally {
      sleeper.kill();
    }
  });
  it('R13 — le verrou n\'est libéré qu\'après l\'intégration du dernier lot', async () => {
    const { parent, repo } = setup();
    const lock = join(sharedStateDir(repo), REPO_LOCK);
    const held: boolean[] = [];
    const f = fake({
      implement: async (cwd, brief) => {
        const lot = lotOf(brief);
        if (lot === 'L2') await until(() => store(parent).readLot('a', 'L1')?.status === 'ready'); // L1 est fini et intégré
        return claudeOut(workReport({ commits: [commitFile(cwd, `${lot}.txt`, `feat(${lot}): travail`)] }));
      },
      review: async (_cwd, brief) => {
        if (lotOf(brief) === 'L2') held.push(existsSync(lock));
        return claudeOut({ bloquants: 0, majeurs: 0, mineurs: 0, constats: [], sousTaches: [], nonVerifie: [], verdict: 'conforme' });
      },
    });
    const r = await run(parent, ['a:L1', 'a:L2', '--max-sessions', '2'], f);
    expect(r.code).toBe(0);
    expect(held).toEqual([true]); // L1 est fini, le verrou du dépôt est encore tenu pour L2
    expect(existsSync(lock)).toBe(false);
  });
});

describe('R14 — l\'étape d\'intégration est la valeur `integrate` du champ `next`', () => {
  it('R14 — un lot rendu à l\'intégration garde next: integrate dans son état, et seul --resume --integrate le rejoue à cette étape', async () => {
    const { parent, f } = await conflictWave();
    const l1 = store(parent).readLot('a', 'L1')!;
    expect(l1.next).toBe('integrate');
    expect(Object.keys(l1)).not.toContain('worktree');
    const calls = f.calls.length;
    const g = fake();
    const plain = await run(parent, ['--resume', WAVE], g);
    expect(plain.code).toBe(2); // la vague est terminée : rien n'est rejoué
    expect(g.calls).toHaveLength(0);
    expect(store(parent).readLot('a', 'L1')!.status).toBe('handed-back');
    const named = await run(parent, ['--resume', WAVE, '--integrate', 'a:L1'], g);
    expect(named.out).toContain('a:L1 → suspended — intégration reprise (--resume --integrate)');
    expect(g.calls).toHaveLength(0); // l'intégration seule est rejouée, aucune session
    expect(calls).toBeGreaterThan(0);
  });
  it('R14 — l\'état d\'une vague écrite sans worktree (avant L279) se relit sans changement', async () => {
    const { parent } = setup([{ title: 'un' }], '');
    await run(parent, ['a:L1'], fake());
    const file = join(store(parent).dir, 'a--L1.json');
    const before = readFileSync(file, 'utf8');
    expect((await run(parent, ['--status', WAVE], fake())).out).not.toContain('worktree');
    expect((await run(parent, ['--resume', WAVE], fake())).err).toMatch(/est terminée/);
    expect(readFileSync(file, 'utf8')).toBe(before);
  });
});

describe('R19 — worktrees conservés visibles', () => {
  it('R19 — orchestrate --status liste un worktree conservé avec dépôt, lot, âge et commits non intégrés', async () => {
    const { parent, dir } = await conflictWave();
    const r = await run(parent, ['--status', WAVE], fake());
    expect(r.out).toContain('worktrees de lot conservés');
    expect(r.out).toMatch(new RegExp(`a · a:L1 · \\d+ min · 1 commit\\(s\\) non intégré\\(s\\) · ${dir}`));
  });
  it('R19 — le tableau de fin de vague donne, par lot rendu, le chemin de son worktree', async () => {
    const { r, dir } = await conflictWave();
    expect(r.out).toMatch(new RegExp(`a · a:L1 · .* · 1 commit\\(s\\) non intégré\\(s\\) · ${dir}`));
  });
  it('R19 — cadence lead tour liste le même worktree', async () => {
    const { parent, dir } = await conflictWave();
    const out: string[] = [];
    rafRun(['lead', 'tour'], { cwd: parent, env: { RAF_TODAY: '2026-10-04' }, out: (l) => out.push(l), err: () => {}, now: () => new Date('2026-10-04T14:12:00') });
    const text = out.join('\n');
    expect(text).toContain('worktrees de lot conservés');
    expect(text).toMatch(new RegExp(`a · a:L1 · .* · 1 commit\\(s\\) non intégré\\(s\\) · ${dir}`));
  });
  it('R19 — aucun worktree conservé : aucune ligne ajoutée', async () => {
    const { parent } = setup();
    await run(parent, ['a:L1', 'a:L2', '--max-sessions', '2'], fake());
    expect((await run(parent, ['--status', WAVE], fake())).out).not.toContain('worktree');
    const out: string[] = [];
    rafRun(['lead', 'tour'], { cwd: parent, env: { RAF_TODAY: '2026-10-04' }, out: (l) => out.push(l), err: () => {}, now: () => new Date('2026-10-04T14:12:00') });
    expect(out.join('\n')).not.toContain('worktree');
  });
});

describe('R20 — retrait explicite d\'un worktree conservé', () => {
  it('R20 — commits non intégrés sans --abandon-commits : refus code 2, worktree et branche intacts', async () => {
    const { parent, repo, dir, branch } = await conflictWave();
    const r = await run(parent, ['--remove-worktree', 'a:L1'], fake());
    expect(r.code).toBe(2);
    expect(r.err).toContain('orchestrate : a:L1 : 1 commit(s) non intégré(s), --abandon-commits pour les abandonner');
    expect(existsSync(dir)).toBe(true);
    expect(branches(repo)).toContain(branch);
  });
  it('R20 — avec --abandon-commits : worktree et branche retirés', async () => {
    const { parent, repo, dir } = await conflictWave();
    const r = await run(parent, ['--remove-worktree', 'a:L1', '--abandon-commits'], fake());
    expect(r.code).toBe(0);
    expect(r.out).toContain('orchestrate : a:L1 : worktree retiré (1 commit(s) abandonné(s))');
    expect(existsSync(dir)).toBe(false);
    expect(branches(repo)).toBe('');
  });
  it('R20 — worktree entièrement intégré : retiré sans option', async () => {
    const { parent, repo, dir, branch } = await conflictWave();
    git(repo, 'merge', '-q', '-X', 'theirs', '--no-edit', branch); // le lead a intégré le travail à sa façon
    const r = await run(parent, ['--remove-worktree', 'a:L1'], fake());
    expect(r.code).toBe(0);
    expect(r.out).toContain('orchestrate : a:L1 : worktree retiré (0 commit(s) abandonné(s))');
    expect(existsSync(dir)).toBe(false);
  });
  it('R20 — fichier non suivi non ignoré dans le worktree : refus code 2, fichier conservé, même sans commit non intégré', async () => {
    const { parent, repo, dir, branch } = await conflictWave();
    git(repo, 'merge', '-q', '-X', 'theirs', '--no-edit', branch); // plus aucun commit non intégré
    writeFileSync(join(dir, 'new.txt'), 'travail en cours\n');
    const r = await run(parent, ['--remove-worktree', 'a:L1'], fake());
    expect(r.code).toBe(2);
    expect(r.err).toContain('fichiers non suivis dans le worktree (new.txt)');
    expect(readFileSync(join(dir, 'new.txt'), 'utf8')).toBe('travail en cours\n');
    expect(branches(repo)).toContain(branch);
    rmSync(join(dir, 'new.txt'));
    expect((await run(parent, ['--remove-worktree', 'a:L1'], fake())).code).toBe(0); // arbre propre : retiré
  });
  it('R20 — worktree d\'une vague vivante : refus code 2 même avec --abandon-commits, absent de la liste des conservés', async () => {
    const { parent, repo, dir, branch } = await conflictWave();
    registerWave(cadenceHome(), { pid: process.pid, wave: WAVE, started: '2026-10-04T14:12:00.000Z', cwd: parent, repos: [repo] });
    try {
      for (const extra of [[], ['--abandon-commits']]) {
        const r = await run(parent, ['--remove-worktree', 'a:L1', ...extra], fake());
        expect(r.code).toBe(2);
        expect(r.err).toContain(`la vague ${WAVE} est vivante`);
        expect(existsSync(dir)).toBe(true);
        expect(branches(repo)).toContain(branch);
      }
      expect((await run(parent, ['--status', WAVE], fake())).out).not.toContain('worktrees de lot conservés');
    } finally {
      unregisterWave(cadenceHome(), process.pid);
    }
    expect((await run(parent, ['--status', WAVE], fake())).out).toContain('worktrees de lot conservés'); // la vague finie, il l'est de nouveau
    expect((await run(parent, ['--remove-worktree', 'a:L1', '--abandon-commits'], fake())).code).toBe(0);
  });
  it('R20 — lot inconnu ou sans worktree : refus code 2', async () => {
    const { parent } = await conflictWave();
    const r = await run(parent, ['--remove-worktree', 'a:L9'], fake());
    expect(r.code).toBe(2);
    expect(r.err).toContain('orchestrate : a:L9 : aucun worktree conservé');
  });
});

describe('R27 — --resume --integrate rejoue seul une intégration rendue', () => {
  /** Vague où le lead salit son arbre : les deux lots sont rendus à l'étape d'intégration. */
  async function dirtyLead() {
    const { parent, repo } = setup();
    const meet = meeting(2);
    const f = fake({
      implement: async (cwd, brief) => {
        await meet();
        const lot = lotOf(brief);
        if (lot === 'L1') appendFileSync(join(repo, 'base.txt'), 'édité par le lead\n');
        return claudeOut(workReport({ commits: [commitFile(cwd, `${lot}.txt`, `feat(${lot}): travail`)] }));
      },
    });
    await run(parent, ['a:L1', 'a:L2', '--max-sessions', '2'], f);
    return { parent, repo };
  }
  it('R27 — lot rendu sur verrou d\'intégration (next: integrate) puis --resume seul : il reste handed-back, rien n\'est rejoué', async () => {
    const { parent } = await dirtyLead();
    const g = fake();
    const r = await run(parent, ['--resume', WAVE], g);
    expect(r.code).toBe(2);
    expect(g.calls).toHaveLength(0);
    expect(store(parent).readLot('a', 'L1')!.status).toBe('handed-back');
  });
  it('R27 — lot rendu sur arbre du lead sale (R8), arbre nettoyé, --integrate : le lot s\'intègre', async () => {
    const { parent, repo } = await dirtyLead();
    git(repo, 'checkout', '--', 'base.txt');
    const g = fake();
    const r = await run(parent, ['--resume', WAVE, '--integrate', 'a:L1', '--integrate', 'a:L2'], g);
    expect(r.err).toBe('');
    expect(r.code).toBe(0);
    expect(r.out).toContain('a:L1 → suspended — intégration reprise (--resume --integrate)');
    expect(g.calls).toHaveLength(0);
    for (const id of ['L1', 'L2']) {
      expect(store(parent).readLot('a', id)!.status).toBe('ready');
      expect(existsSync(join(repo, `${id}.txt`))).toBe(true);
    }
    expect(branches(repo)).toBe('');
  });
  it('R27 — --integrate avec un fichier suivi modifié dans le dépôt : refus d\'arbre sale avant toute écriture', async () => {
    const { parent } = await dirtyLead();
    const files = ['wave.json', 'a--L1.json', 'a--L2.json'].map((f) => readFileSync(join(store(parent).dir, f), 'utf8'));
    const r = await run(parent, ['--resume', WAVE, '--integrate', 'a:L1'], fake());
    expect(r.code).toBe(2);
    expect(r.err).toMatch(/orchestrate : a : arbre sale, 1 fichier\(s\) suivi\(s\) modifié\(s\) : base\.txt/);
    expect(['wave.json', 'a--L1.json', 'a--L2.json'].map((f) => readFileSync(join(store(parent).dir, f), 'utf8'))).toEqual(files);
  });
  it('R27 — lot rendu pour conflit (R6) puis --integrate sans que le lead ait rien changé : le conflit est constaté de nouveau, lot rendu de nouveau, branche du dépôt inchangée', async () => {
    const { parent, repo, branch } = await conflictWave();
    const main = git(repo, 'rev-parse', 'main');
    const tip = git(repo, 'rev-parse', branch);
    const r = await run(parent, ['--resume', WAVE, '--integrate', 'a:L1'], fake());
    expect(r.code).toBe(1);
    const l = store(parent).readLot('a', 'L1')!;
    expect(l.status).toBe('handed-back');
    expect(l.next).toBe('integrate');
    expect(l.outcome).toMatch(/conflit en rebasant .* \(fichiers : shared\.txt\)/);
    expect(git(repo, 'rev-parse', 'main')).toBe(main);
    expect(git(repo, 'rev-parse', branch)).toBe(tip);
  });
  it('R27 — --integrate d\'un lot dont le worktree a été retiré par --remove-worktree : rendu de nouveau à l\'intégration, rien n\'est rejoué', async () => {
    const { parent } = await conflictWave();
    expect((await run(parent, ['--remove-worktree', 'a:L1', '--abandon-commits'], fake())).code).toBe(0);
    const g = fake();
    const r = await run(parent, ['--resume', WAVE, '--integrate', 'a:L1'], g);
    expect(r.code).toBe(1);
    const l = store(parent).readLot('a', 'L1')!;
    expect(l.status).toBe('handed-back');
    expect(l.next).toBe('integrate');
    expect(l.outcome).toMatch(/^intégration impossible : le worktree du lot n'existe plus/);
    expect(g.calls).toHaveLength(0);
  });
  it('R27 — --integrate sur un lot rendu hors intégration (next null) : refus code 2 avec statut et étape cités, état de la vague inchangé', async () => {
    const { parent } = setup();
    const f = fake({ implement: async () => claudeOut(workReport({ commits: [] })) });
    await run(parent, ['a:L1', 'a:L2', '--max-sessions', '2'], f);
    const l1 = store(parent).readLot('a', 'L1')!;
    expect(l1.status).toBe('handed-back');
    expect(l1.next).toBeNull();
    const before = readFileSync(join(store(parent).dir, 'a--L1.json'), 'utf8');
    const r = await run(parent, ['--resume', WAVE, '--integrate', 'a:L1'], fake());
    expect(r.code).toBe(2);
    expect(r.err).toContain(`orchestrate : --integrate a:L1 : le lot n'est pas rendu à l'étape d'intégration (handed-back, étape aucune : ${l1.outcome})`);
    expect(readFileSync(join(store(parent).dir, 'a--L1.json'), 'utf8')).toBe(before);
  });
  it('R27 — --integrate sur un lot inconnu, visé deux fois, retiré par --drop ou aussi visé par --answer, --budget : refus code 2', async () => {
    const { parent } = await conflictWave();
    const g = fake();
    const refuse = async (extra: string[]) => run(parent, ['--resume', WAVE, ...extra], g);
    expect((await refuse(['--integrate', 'a:L9'])).err).toContain(`orchestrate : --integrate a:L9 : lot inconnu dans la vague ${WAVE}`);
    expect((await refuse(['--integrate', 'a:L1', '--integrate', 'a:L1'])).err).toContain('orchestrate : --integrate a:L1 : lot visé deux fois');
    expect((await refuse(['--integrate', 'a:L1', '--drop', 'a:L1'])).err).toContain('orchestrate : --integrate a:L1 : lot aussi retiré par --drop');
    expect((await refuse(['--integrate', 'a:L1', '--budget', 'a:L1=+300k'])).err).toContain('orchestrate : --integrate a:L1 : lot aussi visé par --budget');
    expect((await refuse(['--integrate', 'a:L1', '--answer', 'a:L1', 'oui'])).err).toContain('orchestrate : --integrate a:L1 : lot aussi visé par --answer');
    expect(g.calls).toHaveLength(0);
    expect(store(parent).readLot('a', 'L1')!.status).toBe('handed-back');
  });
  it('R27 — --integrate sur un lot retiré par --drop (outcome DROPPED, next null) : refus code 2', async () => {
    const { parent } = await suspendedWave();
    await run(parent, ['--resume', WAVE, '--drop', 'a:L1', '--budget', '5M'], fake());
    expect(store(parent).readLot('a', 'L1')!.outcome).toMatch(/retiré de la vague/);
    const r = await run(parent, ['--resume', WAVE, '--integrate', 'a:L1'], fake());
    expect(r.code).toBe(2);
    expect(r.err).toMatch(/--integrate a:L1 : le lot n'est pas rendu à l'étape d'intégration \(handed-back, étape aucune : retiré de la vague/);
  });
  it('R24 — le lead revient sur la branche de départ puis --resume --integrate : le lot s\'intègre ; --resume seul le laisse rendu', async () => {
    const { parent, repo } = setup();
    const meet = meeting(2);
    const f = fake({
      implement: async (cwd, brief) => {
        await meet();
        const lot = lotOf(brief);
        const out = claudeOut(workReport({ commits: [commitFile(cwd, `${lot}.txt`, `feat(${lot}): travail`)] }));
        if (lot === 'L1') git(repo, 'checkout', '-q', '-b', 'autre');
        return out;
      },
    });
    await run(parent, ['a:L1', 'a:L2', '--max-sessions', '2'], f);
    git(repo, 'checkout', '-q', 'main');
    const g = fake();
    expect((await run(parent, ['--resume', WAVE], g)).code).toBe(2);
    expect(store(parent).readLot('a', 'L1')!.status).toBe('handed-back');
    const r = await run(parent, ['--resume', WAVE, '--integrate', 'a:L1', '--integrate', 'a:L2'], g);
    expect(r.code).toBe(0);
    expect(subjects(repo).filter((s) => s.startsWith('feat('))).toHaveLength(2);
    expect(planOf(repo).lot('L1').review).toBeDefined();
  });
});
