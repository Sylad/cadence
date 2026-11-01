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


describe('L420 probe : deliver hors vague commite le plan de l\'article', () => {
  async function prete() {
    const dir = pushed();
    let clock = 0;
    const deps: DeliverDeps = { exec: () => 0, gh: () => [], ghReady: () => null, fetch: async () => ({ status: 200, text: 'ok' }), sleep: async (ms) => { clock += ms; }, now: () => clock };
    const out: string[] = [];
    const config = parseDeliverConfig('deliver:\n  ci: none\n  verify:\n    - command: "true"\n', 'cadence.yaml');
    const base = { root: dir, state: stateDir(dir), plan: Plan.load(join(dir, '.cadence/raf.yaml')), config, today: '2026-10-09', dryRun: false, args: [] as string[], out: (l: string) => out.push(l), err: (l: string) => out.push(l), articles: [{ repo: '../codex', file: 'cas.md' }], publicTitle: (l: { public?: string }) => l.public ?? 'Alertes météo plus claires' };
    expect(await deliver(base, deps)).toBe(0);
    write(dir, 'src/a.ts', 'x');
    git(dir, 'add', '--', 'src/a.ts');
    commit(dir, 'feat(L1): alertes');
    git(dir, 'push', '-q');
    out.length = 0;
    return { dir, base: { ...base, plan: Plan.load(join(dir, '.cadence/raf.yaml')) }, deps, out };
  }
  const sh = (dir: string, ...a: string[]) => execFileSync('git', a, { cwd: dir, encoding: 'utf8' }).trim();

  it('hors vague, un fichier non suivi sans rapport reste non suivi', async () => {
    const { dir, base, deps } = await prete();
    write(dir, 'brouillon.md', 'z');
    expect(await deliver(base, deps)).toBe(0);
    expect(sh(dir, 'status', '--porcelain')).toBe('?? brouillon.md');
    expect(sh(dir, 'log', '-1', '--format=%s')).toBe('plan: L2 article à rafraîchir ouvert');
  });

  it('hors vague, gabarit plan.commit avec {vague} hors parenthèses : pas de crochets vides', async () => {
    const { dir, base, deps } = await prete();
    expect(await deliver({ ...base, planCommit: 'chore({lot}): {action} [{vague}]' }, deps)).toBe(0);
    expect(sh(dir, 'log', '-1', '--format=%s')).not.toContain('[]');
  });

  it('hors vague, gabarit avec parenthèse portant {vague} : elle disparaît', async () => {
    const { dir, base, deps } = await prete();
    expect(await deliver({ ...base, planCommit: 'plan: {lot} {action} (vague {vague})' }, deps)).toBe(0);
    expect(sh(dir, 'log', '-1', '--format=%s')).toBe('plan: L2 article à rafraîchir ouvert');
  });

  it('hors vague, commit refusé : rien ne reste indexé', async () => {
    const { dir, base, deps } = await prete();
    writeFileSync(join(dir, '.git/hooks/commit-msg'), '#!/bin/sh\nexit 1\n', { mode: 0o755 });
    expect(await deliver(base, deps)).toBe(0);
    expect(sh(dir, 'diff', '--cached', '--name-only')).toBe('');
    expect(sh(dir, 'status', '--porcelain')).toBe('M .cadence/raf.yaml');
  });

  it('hors vague, --dry-run : ni écriture ni commit du plan', async () => {
    const { dir, base, deps } = await prete();
    const head = sh(dir, 'rev-parse', 'HEAD');
    await deliver({ ...base, dryRun: true }, deps);
    expect(sh(dir, 'rev-parse', 'HEAD')).toBe(head);
    expect(sh(dir, 'status', '--porcelain')).toBe('');
  });

  it('hors vague, livraison rouge : aucun commit de plan', async () => {
    const { dir, base, deps } = await prete();
    const head = sh(dir, 'rev-parse', 'HEAD');
    const config = parseDeliverConfig('deliver:\n  ci: none\n  verify:\n    - command: "false"\n', 'cadence.yaml');
    const code = await deliver({ ...base, config }, { ...deps, exec: (c: string) => (c === 'false' ? 1 : 0) } as DeliverDeps);
    expect(code).not.toBe(0);
    expect(sh(dir, 'rev-parse', 'HEAD')).toBe(head);
    expect(sh(dir, 'status', '--porcelain')).toBe('');
  });

  it('hors vague, deux livraisons de suite : la seconde ajoute une note, commitée, arbre propre', async () => {
    const { dir, base, deps, out } = await prete();
    expect(await deliver(base, deps)).toBe(0);
    const plan = Plan.load(join(dir, '.cadence/raf.yaml'));
    plan.add('Autre', '2026-10-01', { visible: true });
    plan.setStatus('L3', 'done', '2026-10-09');
    plan.save();
    git(dir, 'add', '--', '.cadence/raf.yaml');
    commit(dir, 'plan: L3');
    write(dir, 'src/b.ts', 'x');
    git(dir, 'add', '--', 'src/b.ts');
    commit(dir, 'feat(L3): autre');
    git(dir, 'push', '-q');
    out.length = 0;
    expect(await deliver({ ...base, plan: Plan.load(join(dir, '.cadence/raf.yaml')) }, deps)).toBe(0);
    expect(sh(dir, 'status', '--porcelain')).toBe('');
    expect(sh(dir, 'log', '-1', '--format=%s')).toBe('plan: L2 article à rafraîchir : titres livrés notés');
    expect(out.join('\n')).toContain('déjà ouvert');
  });

  it('hors vague, rejouer la livraison sans nouveau commit : aucun commit de plan supplémentaire', async () => {
    const { dir, base, deps } = await prete();
    expect(await deliver(base, deps)).toBe(0);
    const head = sh(dir, 'rev-parse', 'HEAD');
    await deliver({ ...base, plan: Plan.load(join(dir, '.cadence/raf.yaml')) }, deps);
    expect(sh(dir, 'rev-parse', 'HEAD')).toBe(head);
    expect(sh(dir, 'status', '--porcelain')).toBe('');
  });
});
