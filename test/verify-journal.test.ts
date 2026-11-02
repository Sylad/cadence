import { afterEach, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, utimesSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { run } from '../src/cli.js';
import { parseDeliverConfig, type CheckDeps } from '../src/deliver.js';
import { headSha } from '../src/git.js';
import { Plan } from '../src/plan.js';
import { appendDelivery, appendFailedDelivery, recordVerifiedDelivery, sharedStateDir } from '../src/state.js';
import { verifyCommand } from '../src/verify.js';
import { cleanupTempDirs, commit, tempDir } from './helpers.js';

afterEach(cleanupTempDirs);

const SHA = '3d6edf4' + 'a'.repeat(33);
const OTHER = 'b'.repeat(40);
const config = parseDeliverConfig('deliver:\n  verify:\n    - command: check\n', 'cadence.yaml');
const deps = (code: number): CheckDeps => ({ exec: async () => code, fetch: async () => ({ status: 200, text: '' }), sleep: async () => {}, now: () => 0 });
const stateDir = () => {
  const d = join(tempDir(), 'cadence');
  mkdirSync(d, { recursive: true });
  return d;
};
const journal = (d: string) => (existsSync(join(d, 'deliveries.log')) ? readFileSync(join(d, 'deliveries.log'), 'utf8') : '');
const touch = (file: string, at: number) => utimesSync(file, at, at);
const out = (lines: string[]) => (l: string) => lines.push(l);
/** Effets d'une livraison verte sans plan : rien à annoncer, rien à rafraîchir. */
const noEffects = (lines: string[]) => ({ root: '', plan: null, today: '2026-10-29' as const, out: out(lines), err: out(lines) });
async function verify(d: string, sha: string, code = 0) {
  const lines: string[] = [];
  const exit = await verifyCommand({ config, sha, retry: 0, out: out(lines), journal: { dir: d, day: '2026-10-29', effects: noEffects(lines) } }, deps(code));
  return { exit, lines };
}

const git = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, stdio: 'ignore' });
const write = (dir: string, file: string, text: string) => {
  mkdirSync(dirname(join(dir, file)), { recursive: true });
  writeFileSync(join(dir, file), text);
};
/** Dépôt avec un plan (L1 au titre public), cadence.yaml qui vérifie par « true » et déclare un article voisin (docs.articles). */
function repoWithArticle(): string {
  const dir = join(tempDir(), 'demo');
  mkdirSync(dir);
  git(dir, 'init', '-q', '-b', 'main');
  git(dir, 'config', 'user.email', 't@e.x');
  git(dir, 'config', 'user.name', 'T');
  git(dir, 'config', 'commit.gpgsign', 'false');
  const plan = Plan.create(join(dir, '.cadence/raf.yaml'), 'demo', 'L', '2026-10-01');
  plan.add('Alertes', '2026-10-01', { public: 'Alertes météo plus claires' });
  plan.save();
  write(dir, 'cadence.yaml', 'deliver:\n  ci: none\n  verify:\n    - command: "true"\ndocs:\n  articles:\n    - { repo: ../codex, file: cas.md }\n');
  write(dir, 'README.md', 'demo\n');
  git(dir, 'add', '.');
  commit(dir, 'chore: plan');
  return dir;
}

describe('L435 — verify vert après une livraison rouge du même sha', () => {
  it('R1 — un verify vert au sha de la dernière livraison rouge l\'inscrit au journal vert et le dit', async () => {
    const d = stateDir();
    appendFailedDelivery(d, '2026-10-29', SHA, 'vérification en échec');
    const { exit, lines } = await verify(d, SHA);
    expect(exit).toBe(0);
    expect(journal(d)).toBe(`2026-10-29 ${SHA}\n`);
    expect(lines.join('\n')).toContain('livraison rouge');
  });

  it('R2 — un verify rouge n\'écrit rien', async () => {
    const d = stateDir();
    appendFailedDelivery(d, '2026-10-29', SHA, 'vérification en échec');
    expect((await verify(d, SHA, 1)).exit).toBe(1);
    expect(journal(d)).toBe('');
  });

  it('R3 — sans livraison rouge, ou rouge d\'un autre sha, rien n\'est écrit', async () => {
    const d = stateDir();
    await verify(d, SHA);
    appendFailedDelivery(d, '2026-10-29', OTHER, 'vérification en échec', 'verification');
    await verify(d, SHA);
    expect(journal(d)).toBe('');
  });

  it('R4 — une livraison rouge plus récente d\'un autre sha n\'est pas effacée', async () => {
    const d = stateDir();
    appendFailedDelivery(d, '2026-10-28', SHA, 'vérification en échec', 'verification');
    appendFailedDelivery(d, '2026-10-29', OTHER, 'vérification en échec', 'verification');
    await verify(d, SHA);
    expect(journal(d)).toBe('');
  });

  it('R5 — deux verify de suite n\'écrivent qu\'une ligne', async () => {
    const d = stateDir();
    appendFailedDelivery(d, '2026-10-29', SHA, 'vérification en échec');
    touch(join(d, 'deliveries-failed.log'), 1000);
    await verify(d, SHA);
    await verify(d, SHA);
    expect(journal(d)).toBe(`2026-10-29 ${SHA}\n`);
  });

  it('R6 — une livraison verte du même sha déjà postérieure au rouge : rien de plus', async () => {
    const d = stateDir();
    appendFailedDelivery(d, '2026-10-28', SHA, 'vérification en échec');
    touch(join(d, 'deliveries-failed.log'), 1000);
    appendDelivery(d, '2026-10-28', SHA);
    touch(join(d, 'deliveries.log'), 2000);
    await verify(d, SHA);
    expect(journal(d)).toBe(`2026-10-28 ${SHA}\n`);
  });

  it('R7 — une livraison rouge nouvelle après une verte du même sha est de nouveau effaçable', async () => {
    const d = stateDir();
    appendDelivery(d, '2026-10-27', SHA);
    touch(join(d, 'deliveries.log'), 1000);
    appendFailedDelivery(d, '2026-10-29', SHA, 'vérification en échec');
    touch(join(d, 'deliveries-failed.log'), 2000);
    expect(recordVerifiedDelivery(d, '2026-10-29', SHA)).toBe(true);
    expect(journal(d)).toBe(`2026-10-27 ${SHA}\n2026-10-29 ${SHA}\n`);
  });

  it('R9 — une livraison rouge d\'une autre classe que « vérification » (CI, refus, déploiement) n\'est jamais effacée', async () => {
    for (const [cls, reason] of [['ci', 'CI en échec'], ['refus', 'refus'], ['deploiement', 'déploiement en échec'], [undefined, 'CI en échec']] as const) {
      const d = stateDir();
      appendFailedDelivery(d, '2026-10-29', SHA, reason, cls);
      expect((await verify(d, SHA)).exit).toBe(0);
      expect(journal(d)).toBe('');
    }
  });

  it('R10 — la ligne verte écrite par verify a les effets d\'une livraison verte : lots livrés depuis la précédente annoncés, article à rafraîchir ouvert', async () => {
    const dir = repoWithArticle();
    const state = sharedStateDir(dir);
    appendDelivery(state, '2026-10-27', headSha(dir)!);
    touch(join(state, 'deliveries.log'), 1000);
    write(dir, 'src/a.ts', 'x');
    git(dir, 'add', '--', 'src/a.ts');
    commit(dir, 'feat(L1): alertes');
    const x = headSha(dir)!;
    appendFailedDelivery(state, '2026-10-28', x, 'vérification en échec', 'verification');
    touch(join(state, 'deliveries-failed.log'), 2000);
    const lines: string[] = [];
    const code = await run(['verify', '--sha', x], { cwd: dir, env: { RAF_TODAY: '2026-10-29' }, out: out(lines), err: out(lines), now: () => new Date('2026-10-29T12:00:00') });
    const text = lines.join('\n');
    expect(code).toBe(0);
    expect(journal(state)).toContain(`2026-10-29 ${x}\n`);
    expect(text).toContain('inscrit au journal des livraisons');
    expect(text).toContain('livré : L1 — raf done si l\'effet est celui attendu');
    expect(text).toContain('article à rafraîchir : L2 « Article demo à rafraîchir » ouvert');
  });

  it('R8 — sans journal passé (verify hors dépôt de suivi) rien n\'est écrit et rien ne casse', async () => {
    const lines: string[] = [];
    expect(await verifyCommand({ config, sha: SHA, retry: 0, out: (l) => lines.push(l) }, deps(0))).toBe(0);
  });
});
