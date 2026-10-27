import { describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { run } from '../src/cli.js';
import { deliver, parseDeliverConfig, type DeliverDeps } from '../src/deliver.js';
import { Plan } from '../src/plan.js';
import { sharedStateDir as stateDir } from '../src/state.js';
import { commit, gitRepo, tempDir } from './helpers.js';

const git = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, stdio: 'ignore' });
const write = (dir: string, file: string, text: string) => {
  mkdirSync(dirname(join(dir, file)), { recursive: true });
  writeFileSync(join(dir, file), text);
};

/** Dépôt poussé : L1 visible, terminé, sans `public:` mais doté d'une Nouveauté ; cadence.yaml déclare un article voisin. */
function pushed(): string {
  const origin = tempDir();
  git(origin, 'init', '-q', '--bare', '-b', 'main');
  const dir = join(tempDir(), 'demo');
  mkdirSync(dir);
  git(dir, 'init', '-q', '-b', 'main');
  git(dir, 'config', 'user.email', 't@e.x');
  git(dir, 'config', 'user.name', 'T');
  git(dir, 'config', 'commit.gpgsign', 'false');
  const plan = Plan.create(join(dir, '.cadence/raf.yaml'), 'demo', 'L', '2026-10-01');
  plan.add('Alertes', '2026-10-01', { visible: true });
  plan.setStatus('L1', 'done', '2026-10-09');
  plan.save();
  write(dir, 'docs/nouveautes/2026-10-09-alertes.md', '---\ntitle: Alertes météo plus claires\ndate: 2026-10-09\ncreated: 2026-10-09T10:00+02:00\nlots: [L1]\n---\nTexte.\n');
  write(dir, 'cadence.yaml', 'deliver:\n  ci: none\n  verify:\n    - command: "true"\ndocs:\n  articles:\n    - { repo: ../codex, file: cas.md }\n');
  write(dir, 'README.md', 'demo\n');
  git(dir, 'add', '.');
  commit(dir, 'chore: plan');
  git(dir, 'remote', 'add', 'origin', origin);
  git(dir, 'push', '-q', '-u', 'origin', 'main');
  return dir;
}

const cad = async (dir: string) => {
  const out: string[] = [];
  const err: string[] = [];
  const code = await run(['deliver'], { cwd: dir, env: { RAF_TODAY: '2026-10-09' }, out: (l) => out.push(l), err: (l) => err.push(l), now: () => new Date('2026-10-09T12:00:00') });
  return { code, out: out.join('\n'), err: err.join('\n') };
};

describe('cadence deliver (CLI) : articles à rafraîchir', () => {
  it('un lot visible sans public: tire son titre de sa Nouveauté et ouvre le lot de l\'article', async () => {
    const dir = pushed();
    expect((await cad(dir)).code).toBe(0); // point de départ
    write(dir, 'src/a.ts', 'x');
    git(dir, 'add', '--', 'src/a.ts');
    commit(dir, 'feat(L1): alertes');
    git(dir, 'push', '-q');
    const r = await cad(dir);
    expect(r.code).toBe(0);
    expect(r.out).toContain('article à rafraîchir : L2 « Article demo à rafraîchir »');
    const lot = Plan.load(join(dir, '.cadence/raf.yaml')).lot('L2');
    expect(lot.notes[0].text).toContain('« Alertes météo plus claires »');
    expect(lot.repos).toEqual([{ path: '../codex', cite: 'demo' }]);
  });
});

describe('deliver : le script du projet écrit le plan', () => {
  it('l\'ouverture du lot d\'article relit le plan : la clôture faite par le script survit', async () => {
    const dir = pushed();
    const plan = Plan.load(join(dir, '.cadence/raf.yaml'));
    plan.add('Autre', '2026-10-01', { public: 'Autre nouveauté' });
    plan.save();
    git(dir, 'add', '--', '.cadence/raf.yaml');
    commit(dir, 'plan: L2');
    git(dir, 'push', '-q');
    const config = parseDeliverConfig('deliver:\n  script: close\n  verify:\n    - command: "true"\n', 'cadence.yaml');
    let clock = 0;
    let armed = false; // le script ne ferme L2 que pour la seconde livraison
    const deps: DeliverDeps = {
      exec: (cmd) => {
        if (cmd === 'close' && armed) {
          const p = Plan.load(join(dir, '.cadence/raf.yaml'));
          p.setStatus('L2', 'done', '2026-10-09');
          p.save();
        }
        return 0;
      },
      gh: () => [],
      ghReady: () => null,
      fetch: async () => ({ status: 200, text: 'ok' }),
      sleep: async (ms) => { clock += ms; },
      now: () => clock,
    };
    const out: string[] = [];
    const base = { root: dir, state: stateDir(dir), config, today: '2026-10-09', dryRun: false, args: [] as string[], out: (l: string) => out.push(l), err: (l: string) => out.push(l), articles: [{ repo: '../codex', file: 'cas.md' }], publicTitle: (l: { public?: string }) => l.public };
    expect(await deliver({ ...base, plan: Plan.load(join(dir, '.cadence/raf.yaml')) }, deps)).toBe(0);
    write(dir, 'src/a.ts', 'x');
    git(dir, 'add', '--', 'src/a.ts');
    commit(dir, 'feat(L2): autre');
    git(dir, 'push', '-q');
    out.length = 0;
    armed = true;
    const code2 = await deliver({ ...base, plan: Plan.load(join(dir, '.cadence/raf.yaml')) }, deps);
    expect(code2).toBe(0);
    const after = Plan.load(join(dir, '.cadence/raf.yaml'));
    expect(after.lot('L2').status).toBe('done');
    expect(after.lot('L3').title).toBe('Article demo à rafraîchir');
  });
});

describe('deliver pendant une vague (L388) : le plan écrit pour l\'article est commité', () => {
  /** Un dépôt avec une livraison de départ faite et un commit `feat(L1)` poussé, prêt à être livré par `deliverOnce`. */
  async function prete(): Promise<{ dir: string; base: Parameters<typeof deliver>[0]; deps: DeliverDeps; out: string[] }> {
    const dir = pushed();
    let clock = 0;
    const deps: DeliverDeps = { exec: () => 0, gh: () => [], ghReady: () => null, fetch: async () => ({ status: 200, text: 'ok' }), sleep: async (ms) => { clock += ms; }, now: () => clock };
    const out: string[] = [];
    const config = parseDeliverConfig('deliver:\n  ci: none\n  verify:\n    - command: "true"\n', 'cadence.yaml');
    const base = { root: dir, state: stateDir(dir), plan: Plan.load(join(dir, '.cadence/raf.yaml')), config, today: '2026-10-09', dryRun: false, args: [] as string[], out: (l: string) => out.push(l), err: (l: string) => out.push(l), articles: [{ repo: '../codex', file: 'cas.md' }], publicTitle: (l: { public?: string }) => l.public ?? 'Alertes météo plus claires' };
    expect(await deliver(base, deps)).toBe(0); // point de départ
    write(dir, 'src/a.ts', 'x');
    git(dir, 'add', '--', 'src/a.ts');
    commit(dir, 'feat(L1): alertes');
    git(dir, 'push', '-q');
    out.length = 0;
    return { dir, base: { ...base, plan: Plan.load(join(dir, '.cadence/raf.yaml')) }, deps, out };
  }
  const status = (dir: string) => execFileSync('git', ['status', '--porcelain'], { cwd: dir, encoding: 'utf8' }).trim();
  const subject = (dir: string) => execFileSync('git', ['log', '-1', '--format=%s'], { cwd: dir, encoding: 'utf8' }).trim();

  it('R1 — vague qui tient le dépôt : le lot de l\'article ouvert est commité, l\'arbre reste propre', async () => {
    const { dir, base, deps, out } = await prete();
    expect(await deliver({ ...base, duringWave: true, waveId: '2026-10-27-1950' }, deps)).toBe(0);
    expect(status(dir)).toBe('');
    expect(subject(dir)).toBe('plan: L2 article à rafraîchir ouvert (orchestrate 2026-10-27-1950)');
    expect(out.join('\n')).toContain('article à rafraîchir : L2');
    expect(out.join('\n')).not.toContain('à commiter');
  });

  it('R2 — le message du commit suit le gabarit plan.commit du projet', async () => {
    const { dir, base, deps } = await prete();
    expect(await deliver({ ...base, duringWave: true, waveId: 'W9', planCommit: 'chore({lot}): {action} [{vague}]' }, deps)).toBe(0);
    expect(subject(dir)).toBe('chore(L2): article à rafraîchir ouvert [W9]');
  });

  it('R3 — hors vague : le plan reste écrit sans être commité, comme avant', async () => {
    const { dir, base, deps, out } = await prete();
    const head = subject(dir);
    expect(await deliver(base, deps)).toBe(0);
    expect(status(dir)).toBe('M .cadence/raf.yaml');
    expect(subject(dir)).toBe(head);
    expect(out.join('\n')).toContain('plan modifié, à commiter');
  });

  it('R4 — plan déjà modifié par le lead avant la livraison : rien n\'est commité à sa place, la ligne le dit', async () => {
    const { dir, base, deps, out } = await prete();
    const p = join(dir, '.cadence/raf.yaml');
    writeFileSync(p, `${readFileSync(p, 'utf8')}# note du lead\n`);
    const head = subject(dir);
    const sha = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: dir, encoding: 'utf8' }).trim(); // --sha : l'arbre sale ne refuse pas la livraison
    expect(await deliver({ ...base, plan: Plan.load(p), sha, duringWave: true, waveId: 'W9' }, deps)).toBe(0);
    expect(subject(dir)).toBe(head);
    expect(status(dir)).toBe('M .cadence/raf.yaml');
    expect(out.join('\n')).toContain('plan déjà modifié avant la livraison');
  });

  it('R6 — plan.onWrite : les fichiers produits partent avec le plan, l\'arbre reste propre', async () => {
    const { dir, base, deps } = await prete();
    const planPath = join(dir, '.cadence/raf.yaml');
    const onWrite = { command: 'cp .cadence/raf.yaml docs-plan.yaml', files: ['docs-plan.yaml'], cwd: dir };
    expect(await deliver({ ...base, plan: Plan.load(planPath, { onWrite }), duringWave: true, waveId: 'W9' }, deps)).toBe(0);
    expect(status(dir)).toBe('');
    expect(execFileSync('git', ['show', '--stat', '--format=', 'HEAD'], { cwd: dir, encoding: 'utf8' })).toContain('docs-plan.yaml');
  });

  it('R7 — fichier produit par plan.onWrite déjà modifié par le lead : rien n\'est commité à sa place, la ligne le dit', async () => {
    const { dir, base, deps, out } = await prete();
    const planPath = join(dir, '.cadence/raf.yaml');
    write(dir, 'docs-plan.yaml', 'publié\n');
    git(dir, 'add', '--', 'docs-plan.yaml');
    commit(dir, 'docs: plan publié');
    git(dir, 'push', '-q');
    writeFileSync(join(dir, 'docs-plan.yaml'), 'publié\n# note du lead\n');
    const head = subject(dir);
    const sha = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: dir, encoding: 'utf8' }).trim(); // --sha : l'arbre sale ne refuse pas la livraison
    const onWrite = { command: 'cp .cadence/raf.yaml docs-plan.yaml', files: ['docs-plan.yaml'], cwd: dir };
    expect(await deliver({ ...base, plan: Plan.load(planPath, { onWrite }), sha, duringWave: true, waveId: 'W9' }, deps)).toBe(0);
    expect(subject(dir)).toBe(head);
    expect(status(dir)).toContain('docs-plan.yaml');
    expect(out.join('\n')).toContain('plan déjà modifié avant la livraison');
  });

  it('R5 — commit refusé (hook commit-msg) : le plan reste écrit, la livraison reste verte et le dit', async () => {
    const { dir, base, deps, out } = await prete();
    writeFileSync(join(dir, '.git/hooks/commit-msg'), '#!/bin/sh\necho refusé >&2\nexit 1\n', { mode: 0o755 });
    expect(await deliver({ ...base, duringWave: true, waveId: 'W9' }, deps)).toBe(0);
    expect(status(dir)).toBe('M .cadence/raf.yaml');
    expect(out.join('\n')).toContain('commit du plan refusé');
  });
});
