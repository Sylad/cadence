import { afterEach, describe, expect, it } from 'vitest';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { run } from '../src/cli.js';
import { REPO_LOCK } from '../src/orchestrate/lock.js';
import { registerWave } from '../src/orchestrate/registry.js';
import { newLot, RunStore, type LotState } from '../src/orchestrate/state.js';
import { sharedStateDir } from '../src/state.js';
import { commit, gitRepo, tempDir } from './helpers.js';

async function cli(dir: string, ...argv: string[]) {
  const out: string[] = [];
  const err: string[] = [];
  const code = await run(argv, { cwd: dir, env: { RAF_TODAY: '2026-10-23' }, out: (l) => out.push(l), err: (l) => err.push(l), now: () => new Date('2026-10-23T10:00:00') });
  return { code, out: out.join('\n'), err: err.join('\n') };
}

const sha = (dir: string, rev: string) => execFileSync('git', ['rev-parse', rev], { cwd: dir, encoding: 'utf8' }).trim();

/** Un dépôt avec trois commits de travail : A (L1), B (L2), C (L1), puis une vague vivante qui tient le verrou du dépôt. */
async function vague(statuses: Record<string, LotState['status']>, commits = true) {
  const dir = gitRepo();
  await cli(dir, 'init', '--no-hook');
  for (const t of ['Un', 'Deux', 'Trois']) await cli(dir, 'add', `${t} lot`);
  for (const l of ['L1', 'L2', 'L3']) await cli(dir, 'start', l);
  writeFileSync(join(dir, 'cadence.yaml'), 'deliver:\n  ci: none\n  deploy: echo ok\n  verify:\n    - command: "true"\n');
  execFileSync('git', ['add', '.'], { cwd: dir });
  commit(dir, 'chore: plan');
  const shas: Record<string, string> = {};
  if (commits) {
    for (const [name, lot] of [['A', 'L1'], ['B', 'L2'], ['C', 'L1']]) {
      // un commit qui ne touche aucun fichier est « du plan » pour git : le travail d'un lot change du code
      writeFileSync(join(dir, `${name}.ts`), `export const ${name} = 1;\n`);
      execFileSync('git', ['add', `${name}.ts`], { cwd: dir });
      commit(dir, `feat(${lot}): ${name}`, '2026-10-23T10:00:00');
      shas[name] = sha(dir, 'HEAD');
    }
  }
  const launch = tempDir();
  const home = tempDir();
  const store = RunStore.reserve(launch, 'w7')!;
  store.writeWave({ id: 'w7', status: 'running', created: 'x', lots: Object.keys(statuses) } as never);
  for (const [key, status] of Object.entries(statuses)) {
    const [project, lot] = key.split(':');
    store.writeLot({ ...newLot({ project, repo: dir, lot, title: 't', visible: false, small: false, model: 'sonnet' as never, readOnlyPlan: false }), status });
  }
  mkdirSync(sharedStateDir(dir), { recursive: true });
  writeFileSync(join(sharedStateDir(dir), REPO_LOCK), JSON.stringify({ pid: process.pid, wave: 'w7', started: 'x' }));
  registerWave(home, { pid: process.pid, wave: 'w7', started: 'x', cwd: launch, repos: [dir] });
  return { dir, shas, home };
}

describe('livrer au fil de l\'eau pendant une vague (L277)', () => {
  let saved: string | undefined;
  afterEach(() => {
    process.env.CADENCE_HOME = saved;
  });
  const avec = async (statuses: Record<string, LotState['status']>, commits = true) => {
    const w = await vague(statuses, commits);
    saved = process.env.CADENCE_HOME;
    process.env.CADENCE_HOME = w.home;
    return w;
  };

  /** Enregistre une vague vivante `id` qui tient le verrou de `dir` avec ces lots, sans passer par `vague()` (fixtures à plan propre). */
  const attendre = (dir: string, lots: LotState[], repos: string[] = [dir], id = 'w8') => {
    const launch = tempDir();
    const home = tempDir();
    const store = RunStore.reserve(launch, id)!;
    store.writeWave({ id, status: 'running', created: 'x', lots: lots.map((l) => `${l.project}:${l.lot}`) } as never);
    for (const l of lots) store.writeLot(l);
    mkdirSync(sharedStateDir(dir), { recursive: true });
    writeFileSync(join(sharedStateDir(dir), REPO_LOCK), JSON.stringify({ pid: process.pid, wave: id, started: 'x' }));
    registerWave(home, { pid: process.pid, wave: id, started: 'x', cwd: launch, repos });
    saved = process.env.CADENCE_HOME;
    process.env.CADENCE_HOME = home;
  };

  it('R1 — --sha d\'un commit sous tout lot non prêt : la vague ne bloque plus la livraison', async () => {
    const { dir, shas } = await avec({ 'ici:L1': 'ready', 'ici:L2': 'implementing' });
    const r = await cli(dir, 'deliver', '--dry-run', '--sha', shas.A);
    expect(r.err).not.toContain('orchestration en cours');
    // le garde-fou suivant de deliver (sha non poussé) est atteint : la livraison est bien examinée
    expect(r.err).toContain('non poussé');
  });

  it('R2 — --sha qui contient un commit d\'un lot non prêt : refus qui nomme le lot et son état', async () => {
    const { dir, shas } = await avec({ 'ici:L1': 'ready', 'ici:L2': 'implementing' });
    const r = await cli(dir, 'deliver', '--dry-run', '--sha', shas.C);
    expect(r.code).toBe(2);
    expect(r.err).toContain('orchestration en cours (vague w7');
    expect(r.err).toContain('ici:L2');
    expect(r.err).toContain(shas.C.slice(0, 7));
    expect(r.err).not.toContain('non poussé');
  });

  it('R3 — sans --sha la vague refuse comme avant, même quand un lot est prêt', async () => {
    const { dir } = await avec({ 'ici:L1': 'ready', 'ici:L2': 'implementing' });
    const r = await cli(dir, 'deliver', '--dry-run');
    expect(r.code).toBe(2);
    expect(r.err).toContain('orchestration en cours (vague w7');
  });

  it('R4 — un lot en file ou en cours sans aucun commit ne bloque pas le sha d\'un lot prêt', async () => {
    const { dir, shas } = await avec({ 'ici:L1': 'ready', 'ici:L3': 'queued' });
    const r = await cli(dir, 'deliver', '--dry-run', '--sha', shas.C);
    expect(r.err).not.toContain('orchestration en cours');
  });

  it('R5 — un lot rendu au lead bloque le sha qui contient ses commits, comme un lot en cours', async () => {
    const { dir, shas } = await avec({ 'ici:L1': 'ready', 'ici:L2': 'handed-back', 'ici:L3': 'implementing' });
    const refuse = await cli(dir, 'deliver', '--dry-run', '--sha', shas.C);
    expect(refuse.code).toBe(2);
    expect(refuse.err).toContain('ici:L2');
    const accepte = await cli(dir, 'deliver', '--dry-run', '--sha', shas.A);
    expect(accepte.err).not.toContain('orchestration en cours');
  });

  it('R6 — un sha introuvable est refusé sous la vague, sans exception', async () => {
    const { dir } = await avec({ 'ici:L1': 'ready', 'ici:L2': 'implementing' });
    const r = await cli(dir, 'deliver', '--dry-run', '--sha', 'deadbeef');
    expect(r.code).toBe(2);
    expect(r.err).toContain('orchestration en cours (vague w7');
    expect(r.err).toContain('deadbeef');
  });

  it('R7 — état de la vague illisible : on ne peut rien affirmer, --sha refusé aussi', async () => {
    const dir = gitRepo();
    await cli(dir, 'init', '--no-hook');
    writeFileSync(join(dir, 'cadence.yaml'), 'deliver:\n  ci: none\n  deploy: echo ok\n  verify:\n    - command: "true"\n');
    execFileSync('git', ['add', '.'], { cwd: dir });
    commit(dir, 'chore: plan');
    mkdirSync(sharedStateDir(dir), { recursive: true });
    writeFileSync(join(sharedStateDir(dir), REPO_LOCK), JSON.stringify({ pid: process.pid, wave: 'w9', started: 'x' }));
    const r = await cli(dir, 'deliver', '--dry-run', '--sha', 'HEAD');
    expect(r.code).toBe(2);
    expect(r.err).toContain('orchestration en cours (vague w9');
  });

  it('R9 — le plan du lot (ici dans son worktree) est illisible : on ne peut pas dire que le sha est livrable, refus', async () => {
    const dir = gitRepo();
    await cli(dir, 'init', '--no-hook');
    await cli(dir, 'add', 'Un lot');
    await cli(dir, 'start', 'L1');
    writeFileSync(join(dir, 'cadence.yaml'), 'deliver:\n  ci: none\n  deploy: echo ok\n  verify:\n    - command: "true"\n');
    execFileSync('git', ['add', '.'], { cwd: dir });
    commit(dir, 'chore: plan');
    const wt = join(tempDir(), 'wt');
    execFileSync('git', ['worktree', 'add', '-q', '--detach', wt], { cwd: dir });
    writeFileSync(join(wt, '.cadence', 'raf.yaml'), 'lots: [\n');
    const lot = newLot({ project: 'ici', repo: wt, lot: 'L1', title: 't', visible: false, small: false, model: 'sonnet' as never, readOnlyPlan: false });
    lot.status = 'implementing';
    attendre(dir, [lot]);
    const r = await cli(dir, 'deliver', '--dry-run', '--sha', 'HEAD');
    expect(r.code).toBe(2);
    expect(r.err).toContain('orchestration en cours (vague w8');
    expect(r.err).toContain('ici:L1');
    expect(r.err).toContain('illisible');
  });

  it.each(['failed', 'suspended', 'question', 'queued', 'reviewing', 'fixing'] as const)('R10 — un lot « %s » qui a commité dans le dépôt bloque le sha, quelle que soit la session', async (status) => {
    // L3 travaille encore : sans lui la vague ne tiendrait plus le dépôt (tous les lots finis) et deliver irait son cours ordinaire.
    const { dir, shas } = await avec({ 'ici:L1': 'ready', 'ici:L2': status, 'ici:L3': 'implementing' });
    const refuse = await cli(dir, 'deliver', '--dry-run', '--sha', shas.C);
    expect(refuse.code).toBe(2);
    expect(refuse.err).toContain('ici:L2');
    const accepte = await cli(dir, 'deliver', '--dry-run', '--sha', shas.A);
    expect(accepte.err).not.toContain('orchestration en cours');
  });

  it('R11 — un commit que git n\'attribue pas au lot mais que ses étapes ont noté le bloque encore', async () => {
    const dir = gitRepo();
    await cli(dir, 'init', '--no-hook');
    await cli(dir, 'add', 'Un lot');
    await cli(dir, 'start', 'L1');
    writeFileSync(join(dir, 'cadence.yaml'), 'deliver:\n  ci: none\n  deploy: echo ok\n  verify:\n    - command: "true"\n');
    writeFileSync(join(dir, 'X.ts'), 'export const X = 1;\n');
    execFileSync('git', ['add', '.'], { cwd: dir });
    commit(dir, 'feat: sans citer le lot', '2026-10-23T10:00:00');
    const tete = sha(dir, 'HEAD');
    const lot = newLot({ project: 'ici', repo: dir, lot: 'L1', title: 't', visible: false, small: false, model: 'sonnet' as never, readOnlyPlan: false });
    lot.status = 'implementing';
    lot.steps = [{ commits: [`${tete.slice(0, 7)} feat: sans citer le lot`] } as never];
    attendre(dir, [lot]);
    const r = await cli(dir, 'deliver', '--dry-run', '--sha', tete);
    expect(r.code).toBe(2);
    expect(r.err).toContain('ici:L1');
  });

  describe('lot d\'un autre projet qui travaille ici (clé repos:)', () => {
    /** Projet `a` (plan avec L1 démarré) et dépôt voisin `b` où `cadence deliver` tourne ; une vague tient les deux. */
    async function voisin(over: { status?: LotState['status']; subject?: string | null; cite?: string; steps?: (b: string, tete: string) => string[]; plan?: 'ok' | 'casse' } = {}) {
      const a = gitRepo();
      const b = gitRepo();
      await cli(a, 'init', '--no-hook');
      await cli(a, 'add', 'Un lot');
      await cli(a, 'add', 'Deux lot');
      await cli(a, 'start', 'L1');
      await cli(a, 'start', 'L2');
      for (const d of [a, b]) {
        writeFileSync(join(d, 'cadence.yaml'), 'deliver:\n  ci: none\n  deploy: echo ok\n  verify:\n    - command: "true"\n');
        execFileSync('git', ['add', '.'], { cwd: d });
        commit(d, 'chore: init');
      }
      if (over.plan === 'casse') writeFileSync(join(a, '.cadence', 'raf.yaml'), 'lots: [\n');
      const avant = sha(b, 'HEAD');
      let tete = avant;
      if (over.subject !== null) {
        writeFileSync(join(b, 'N.ts'), 'export const N = 1;\n');
        execFileSync('git', ['add', 'N.ts'], { cwd: b });
        commit(b, over.subject ?? 'feat(L1): N', '2026-10-23T10:00:00');
        tete = sha(b, 'HEAD');
      }
      const lot = newLot({ project: 'ici', repo: a, lot: 'L1', title: 't', visible: false, small: false, model: 'sonnet' as never, readOnlyPlan: false });
      lot.status = over.status ?? 'implementing';
      lot.repos = [{ rel: '../b', path: b, ...(over.cite ? { cite: over.cite } : {}) }];
      lot.steps = over.steps ? over.steps(b, tete).map((c) => ({ commits: [c] }) as never) : [];
      // L2 travaille encore dans b, sans commit : sans lui la vague ne tiendrait plus b quand L1 est rendu ou échoué.
      const autre = newLot({ project: 'ici', repo: a, lot: 'L2', title: 't', visible: false, small: false, model: 'sonnet' as never, readOnlyPlan: false });
      autre.status = 'implementing';
      autre.repos = [{ rel: '../b', path: b }];
      attendre(b, [lot, autre], [a, b]);
      return { a, b, avant, tete };
    }

    it('R8a — session en cours : le commit du voisin n\'est connu que par git, il bloque quand même', async () => {
      const { b, avant, tete } = await voisin();
      const refuse = await cli(b, 'deliver', '--dry-run', '--sha', tete);
      expect(refuse.code).toBe(2);
      expect(refuse.err).toContain('ici:L1');
      const accepte = await cli(b, 'deliver', '--dry-run', '--sha', avant);
      expect(accepte.err).not.toContain('orchestration en cours');
    });

    it.each(['failed', 'suspended', 'handed-back'] as const)('R8b — session coupée ou échouée (%s) qui a commité dans le voisin : bloque, sans entrée d\'étape', async (status) => {
      const { b, tete } = await voisin({ status });
      const refuse = await cli(b, 'deliver', '--dry-run', '--sha', tete);
      expect(refuse.code).toBe(2);
      expect(refuse.err).toContain('ici:L1');
    });

    it('R8c — commit connu des seules étapes (il ne cite pas le lot) : bloque encore', async () => {
      const { b, tete } = await voisin({ subject: 'feat: sans citer', steps: (_b, t) => [`[../b] ${t.slice(0, 7)} feat: sans citer`] });
      const refuse = await cli(b, 'deliver', '--dry-run', '--sha', tete);
      expect(refuse.code).toBe(2);
      expect(refuse.err).toContain('ici:L1');
    });

    it('R8d — connu par les étapes ET par git : un seul blocage', async () => {
      const { b, tete } = await voisin({ steps: (_b, t) => [`[../b] ${t.slice(0, 7)} feat(L1): N`] });
      const refuse = await cli(b, 'deliver', '--dry-run', '--sha', tete);
      expect(refuse.code).toBe(2);
      expect(refuse.err.match(/ici:L1/g)).toHaveLength(1);
    });

    it('R8e — aucun commit du lot dans le voisin : rien ne bloque', async () => {
      const { b, tete } = await voisin({ subject: null });
      const r = await cli(b, 'deliver', '--dry-run', '--sha', tete);
      expect(r.err).not.toContain('orchestration en cours');
    });

    it('R8f — un lot prêt qui a commité dans le voisin ne bloque pas', async () => {
      const { b, tete } = await voisin({ status: 'ready' });
      const r = await cli(b, 'deliver', '--dry-run', '--sha', tete);
      expect(r.err).not.toContain('orchestration en cours');
    });

    it('R8g — la chaîne cite: du lot écarte le commit d\'une autre application', async () => {
      const { b, tete } = await voisin({ cite: 'aetherwx' });
      const r = await cli(b, 'deliver', '--dry-run', '--sha', tete);
      expect(r.err).not.toContain('orchestration en cours');
    });

    it('R8h — plan du projet illisible, aucun commit connu : refus (on ne laisse passer que ce qui est vérifié)', async () => {
      const { b, avant } = await voisin({ plan: 'casse', subject: null });
      const r = await cli(b, 'deliver', '--dry-run', '--sha', avant);
      expect(r.code).toBe(2);
      expect(r.err).toContain('orchestration en cours (vague w8');
      expect(r.err).toContain('ici:L1');
      expect(r.err).toContain('illisible');
    });

    it('R8i — plan illisible mais le commit est noté par les étapes : le refus dit qu\'il bloque', async () => {
      const { b, tete } = await voisin({ plan: 'casse', steps: (_b, t) => [`[../b] ${t.slice(0, 7)} feat(L1): N`] });
      const r = await cli(b, 'deliver', '--dry-run', '--sha', tete);
      expect(r.code).toBe(2);
      expect(r.err).toContain('contient des commits de lots pas prêts');
    });
  });
});
