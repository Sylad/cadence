import { describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
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
  const plan = Plan.create(join(dir, 'docs/plan/raf.yaml'), 'demo', 'L', '2026-10-01');
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

const cad = (dir: string) => {
  const out: string[] = [];
  const err: string[] = [];
  return run(['deliver'], { cwd: dir, env: { RAF_TODAY: '2026-10-09' }, out: (l) => out.push(l), err: (l) => err.push(l), now: () => new Date('2026-10-09T12:00:00') }).then((code) => ({ code, out: out.join('\n'), err: err.join('\n') }));
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
    const lot = Plan.load(join(dir, 'docs/plan/raf.yaml')).lot('L2');
    expect(lot.notes[0].text).toContain('« Alertes météo plus claires »');
    expect(lot.repos).toEqual([{ path: '../codex', cite: 'demo' }]);
  });
});

describe('deliver : le script du projet écrit le plan', () => {
  it('l\'ouverture du lot d\'article relit le plan : la clôture faite par le script survit', async () => {
    const dir = pushed();
    const plan = Plan.load(join(dir, 'docs/plan/raf.yaml'));
    plan.add('Autre', '2026-10-01', { public: 'Autre nouveauté' });
    plan.save();
    git(dir, 'add', '--', 'docs/plan/raf.yaml');
    commit(dir, 'plan: L2');
    git(dir, 'push', '-q');
    const config = parseDeliverConfig('deliver:\n  script: close\n  verify:\n    - command: "true"\n', 'cadence.yaml');
    let clock = 0;
    let armed = false; // le script ne ferme L2 que pour la seconde livraison
    const deps: DeliverDeps = {
      exec: (cmd) => {
        if (cmd === 'close' && armed) {
          const p = Plan.load(join(dir, 'docs/plan/raf.yaml'));
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
    expect(await deliver({ ...base, plan: Plan.load(join(dir, 'docs/plan/raf.yaml')) }, deps)).toBe(0);
    write(dir, 'src/a.ts', 'x');
    git(dir, 'add', '--', 'src/a.ts');
    commit(dir, 'feat(L2): autre');
    git(dir, 'push', '-q');
    out.length = 0;
    armed = true;
    const code2 = await deliver({ ...base, plan: Plan.load(join(dir, 'docs/plan/raf.yaml')) }, deps);
    expect(code2).toBe(0);
    const after = Plan.load(join(dir, 'docs/plan/raf.yaml'));
    expect(after.lot('L2').status).toBe('done');
    expect(after.lot('L3').title).toBe('Article demo à rafraîchir');
  });
});
