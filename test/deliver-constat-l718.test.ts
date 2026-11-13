import { afterEach, describe, expect, it } from 'vitest';
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, utimesSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { run } from '../src/cli.js';
import { parseDeliverConfig, type DeliverConfig } from '../src/deliver.js';
import { constat, readDeployed, type ConstatDeps } from '../src/deliver-constat.js';
import { headSha } from '../src/git.js';
import { tourRow } from '../src/lead.js';
import { Plan } from '../src/plan.js';
import { appendDelivery, appendFailedDelivery, sharedStateDir } from '../src/state.js';
import { cleanupTempDirs, commit, gitRepo, tempDir } from './helpers.js';

// L718 : une livraison constatée — le code d'un sha est en production sans être passé par cadence deliver (script du projet lancé
// à la main) ; `cadence deliver --constat` l'inscrit au journal sans rien déployer, ses lots cessent d'être « clos non livrés »,
// et une livraison rouge antérieure cesse d'être la dernière.

afterEach(cleanupTempDirs);

// Le mod est hors du typecheck de cadence : son module est chargé à l'exécution, par une URL que tsc ne suit pas.
const { LAST_DELIVERIES } = (await import(new URL('../plugins/cadence-hud/hooks/collect.ts', import.meta.url).href)) as { LAST_DELIVERIES: string };
const { deliveriesOf, parseLastDeliveries } = (await import(new URL('../plugins/cadence-hud/hooks/deliveries.ts', import.meta.url).href)) as {
  deliveriesOf: (last: unknown[], board: unknown, at: number) => { project: string; undelivered: string[] | null }[];
  parseLastDeliveries: (stdout: string) => unknown[];
};
const { parseLotsBoard } = (await import(new URL('../plugins/cadence-hud/hooks/lots.ts', import.meta.url).href)) as { parseLotsBoard: (stdout: string) => unknown };

const git = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, stdio: 'ignore' });
const SCRIPT = parseDeliverConfig('deliver:\n  script: ./livrer.sh\n', 'cadence.yaml');
const TODAY = '2026-11-13';

/** Dépôt poussé (remote bare), plan de deux lots, L1 clos par un commit de travail (sur `file`, a.txt par défaut) ; `push: false` laisse la tête non poussée. */
function repo(o: { push?: boolean; file?: string } = {}): { dir: string; planFile: string; base: string; head: string } {
  const origin = tempDir();
  git(origin, 'init', '-q', '--bare', '-b', 'main');
  const dir = gitRepo();
  const planFile = join(dir, '.cadence/raf.yaml');
  const plan = Plan.create(planFile, 'demo', 'L', '2026-11-10');
  plan.add('Premier', '2026-11-10');
  plan.add('Second', '2026-11-10');
  plan.save();
  writeFileSync(join(dir, 'README.md'), 'demo\n');
  git(dir, 'add', '.');
  commit(dir, 'chore: plan');
  const base = headSha(dir)!;
  git(dir, 'remote', 'add', 'origin', origin);
  git(dir, 'push', '-q', '-u', 'origin', 'main');
  const file = o.file ?? 'a.txt';
  mkdirSync(dirname(join(dir, file)), { recursive: true });
  writeFileSync(join(dir, file), 'un\n');
  git(dir, 'add', file);
  commit(dir, 'feat(L1): un');
  const done = Plan.load(planFile);
  done.setStatus('L1', 'done', '2026-11-12', { force: true });
  done.save();
  git(dir, 'add', '.');
  commit(dir, 'plan: L1 terminé');
  if (o.push !== false) git(dir, 'push', '-q', 'origin', 'main');
  return { dir, planFile, base, head: headSha(dir)! };
}

const deps = (o: { deployed?: string | Error; check?: number } = {}): ConstatDeps & { calls: string[] } => {
  const calls: string[] = [];
  return {
    calls,
    exec: async (cmd, env) => (calls.push(`${cmd} [${env.CADENCE_SHA}]`), o.check ?? 0),
    fetch: async () => ({ status: 200, text: '' }),
    sleep: async () => {},
    now: () => 0,
    deployed: (cmd) => {
      calls.push(`deployed: ${cmd}`);
      if (o.deployed instanceof Error) throw o.deployed;
      return o.deployed ?? '';
    },
  };
};

async function constate(dir: string, planFile: string | null, o: { sha?: string; config?: DeliverConfig; deployed?: string; deps?: ConstatDeps; dryRun?: boolean; block?: string } = {}) {
  const out: string[] = [];
  const err: string[] = [];
  const code = await constat(
    { root: dir, state: sharedStateDir(dir), plan: planFile ? Plan.load(planFile) : null, today: TODAY, config: o.config ?? SCRIPT, deployed: o.deployed, sha: o.sha, block: o.block, dryRun: !!o.dryRun, out: (l) => out.push(l), err: (l) => err.push(l) },
    o.deps ?? deps(),
  );
  return { code, out: out.join('\n'), err: err.join('\n') };
}

const journal = (dir: string) => {
  const f = join(sharedStateDir(dir), 'deliveries.log');
  return existsSync(f) ? readFileSync(f, 'utf8') : '';
};

/** La sortie du script LAST_DELIVERIES du HUD (panneau « Dernière livraison par projet ») sur le dossier parent du dépôt. */
function lastDeliveries(dir: string): string {
  const r = spawnSync('python3', ['-I', '-c', LAST_DELIVERIES, dirname(dir)], { encoding: 'utf8' });
  expect(r.status).toBe(0);
  return r.stdout;
}

/** Ce que le panneau lit pour le projet du dossier. */
const panel = (dir: string): { status: string; sha: string; green: string | null } =>
  (JSON.parse(lastDeliveries(dir)) as { project: string; status: string; sha: string; green: string | null }[]).find((d) => d.project === dir.split('/').at(-1))!;

/** Les lots « clos non livrés » du panneau pour le projet du dossier : son journal (LAST_DELIVERIES) croisé avec `closed` du tour (`cadence lead tour --json`). */
function undelivered(dir: string): string[] | null {
  const board = parseLotsBoard(JSON.stringify([tourRow(dir, TODAY)]));
  return deliveriesOf(parseLastDeliveries(lastDeliveries(dir)), board, Date.parse(`${TODAY}T12:00:00`)).find((d) => d.project === dir.split('/').at(-1))!.undelivered;
}

describe('L718 — cadence deliver --constat', () => {
  it('R1 — un sha poussé est inscrit au journal sans rien lancer, ses lots clos sont marqués livrés au plan', async () => {
    const { dir, planFile, base, head } = repo();
    appendDelivery(sharedStateDir(dir), '2026-11-10', base);
    const d = deps();
    const r = await constate(dir, planFile, { sha: head, deps: d });
    expect(r.code).toBe(0);
    expect(d.calls).toEqual([]);
    expect(journal(dir)).toBe(`2026-11-10 ${base}\n${TODAY} ${head}\n`);
    expect(r.out).toContain(`✓ constat : ${head.slice(0, 7)} inscrit au journal des livraisons, rien n'est déployé`);
    expect(Plan.load(planFile).lots().find((l) => l.id === 'L1')!.delivered).toEqual({ date: TODAY, sha: head });
    // sans témoin ni vérification, l'inscription repose sur la parole du lead : il le lit
    expect(r.err).toContain('sur votre parole');
  });

  it('R2 — un sha non poussé est refusé (2), rien n\'est inscrit', async () => {
    const { dir, planFile, head } = repo({ push: false });
    const r = await constate(dir, planFile, { sha: head });
    expect(r.code).toBe(2);
    expect(r.err).toContain('non poussé');
    expect(journal(dir)).toBe('');
  });

  it('R3 — une livraison rouge suivie d\'un constat vert n\'est plus « en échec » au panneau, et ses lots ne sont plus clos non livrés', async () => {
    const { dir, planFile, base, head } = repo();
    const state = sharedStateDir(dir);
    appendDelivery(state, '2026-11-10', base);
    appendFailedDelivery(state, TODAY, head, 'script de livraison en échec (code 1) : ./livrer.sh', 'deploiement');
    utimesSync(join(state, 'deliveries.log'), new Date('2026-11-10T10:00:00Z'), new Date('2026-11-10T10:00:00Z'));
    expect(panel(dir).status).toBe('rouge');
    expect(undelivered(dir)).toEqual(['L1']);
    const r = await constate(dir, planFile, { sha: head });
    expect(r.code).toBe(0);
    expect(r.out).toContain(`la livraison rouge de ${head.slice(0, 7)} n'est plus la dernière`);
    // le panneau : verte, au sha constaté, et le jour de la dernière verte couvre les lots clos jusqu'à aujourd'hui
    expect(panel(dir)).toMatchObject({ status: 'verte', sha: head, green: TODAY });
    // le compte du panneau, tiré du tour : L1 n'est plus clos non livré
    expect(tourRow(dir, TODAY).closed).toEqual([{ id: 'L1', finished: '2026-11-12', delivered: true }]);
    expect(undelivered(dir)).toEqual([]);
  });

  it('R4 — sans sha, deliver.deployed dit le sha déployé, et il est inscrit', async () => {
    const { dir, planFile, head } = repo();
    const d = deps({ deployed: `image en prod :\n${head.slice(0, 12)}\n` });
    const r = await constate(dir, planFile, { deployed: 'kubectl get deploy -o jsonpath=…', deps: d });
    expect(r.code).toBe(0);
    expect(d.calls).toEqual(['deployed: kubectl get deploy -o jsonpath=…']);
    expect(journal(dir)).toBe(`${TODAY} ${head}\n`);
    expect(r.out).toContain('confirmé par deliver.deployed');
    expect(r.err).not.toContain('sur votre parole');
  });

  it('R5 — un sha donné que deliver.deployed contredit n\'est pas inscrit (1)', async () => {
    const { dir, planFile, base, head } = repo();
    const r = await constate(dir, planFile, { sha: head, deployed: './sha-en-prod.sh', deps: deps({ deployed: `${base}\n` }) });
    expect(r.code).toBe(1);
    expect(r.err).toContain(`deliver.deployed dit ${base.slice(0, 7)} déployé, pas ${head.slice(0, 7)}`);
    expect(journal(dir)).toBe('');
  });

  it('R6 — deliver.deployed en échec ou qui n\'écrit pas un sha du dépôt : rien n\'est inscrit (1)', async () => {
    const { dir, planFile } = repo();
    const deployed = './sha-en-prod.sh';
    const failed = await constate(dir, planFile, { deployed, deps: deps({ deployed: new Error('code 1 : cluster injoignable') }) });
    expect(failed.code).toBe(1);
    expect(failed.err).toContain('cluster injoignable');
    for (const bad of ['main', 'f'.repeat(40), '']) {
      const r = await constate(dir, planFile, { deployed, deps: deps({ deployed: bad }) });
      expect(r.code).toBe(1);
      expect(r.err).toContain('deliver.deployed');
    }
    expect(journal(dir)).toBe('');
  });

  it('R7 — sans sha ni deliver.deployed : refus (2) qui dit les deux façons', async () => {
    const { dir, planFile } = repo();
    const r = await constate(dir, planFile);
    expect(r.code).toBe(2);
    expect(r.err).toContain('--constat <sha>');
    expect(r.err).toContain('deliver.deployed');
  });

  it('R8 — deliver.verify déclaré : rouge, rien n\'est inscrit (1) ; vert, inscrit, la commande reçoit le sha constaté (CADENCE_SHA)', async () => {
    const { dir, planFile, head } = repo();
    const config = parseDeliverConfig('deliver:\n  ci: none\n  verify:\n    - command: ./effet.sh\n', 'cadence.yaml');
    const red = deps({ check: 1 });
    expect((await constate(dir, planFile, { sha: head, config, deps: red })).code).toBe(1);
    expect(journal(dir)).toBe('');
    const green = deps();
    const r = await constate(dir, planFile, { sha: head, config, deps: green });
    expect(r.code).toBe(0);
    expect(green.calls).toEqual([`./effet.sh [${head}]`]);
    expect(r.out).toContain('1 vérification verte');
    expect(journal(dir)).toBe(`${TODAY} ${head}\n`);
  });

  it('R9 — un sha antérieur à la dernière livraison est refusé (2) ; le même sha, sans rouge après lui, n\'écrit rien (0)', async () => {
    const { dir, planFile, base, head } = repo();
    appendDelivery(sharedStateDir(dir), '2026-11-12', head);
    const older = await constate(dir, planFile, { sha: base });
    expect(older.code).toBe(2);
    expect(older.err).toContain('antérieur à la dernière livraison');
    const same = await constate(dir, planFile, { sha: head });
    expect(same.code).toBe(0);
    expect(same.out).toContain('déjà la dernière livraison');
    expect(journal(dir)).toBe(`2026-11-12 ${head}\n`);
  });

  it('R10 — --dry-run dit ce qui serait inscrit sans rien écrire', async () => {
    const { dir, planFile, head } = repo();
    const r = await constate(dir, planFile, { sha: head, dryRun: true });
    expect(r.code).toBe(0);
    expect(r.out).toContain('simulation, rien n\'est écrit');
    expect(journal(dir)).toBe('');
    expect(Plan.load(planFile).lots().find((l) => l.id === 'L1')!.delivered).toBeUndefined();
  });

  it('R11 — une livraison en cours (verrou vivant) refuse le constat (2)', async () => {
    const { dir, planFile, head } = repo();
    writeFileSync(join(sharedStateDir(dir), 'deliver.lock'), JSON.stringify({ pid: process.pid, sha: head, started: new Date().toISOString() }));
    const r = await constate(dir, planFile, { sha: head });
    expect(r.code).toBe(2);
    expect(r.err).toContain('livraison en cours');
    expect(journal(dir)).toBe('');
  });

  it('R12 — deliver.deployed vide ou qui n\'est pas un texte est refusé à la lecture de cadence.yaml ; absent, il n\'y en a pas', () => {
    const file = join(tempDir(), 'cadence.yaml');
    const read = (yaml: string) => (writeFileSync(file, yaml), readDeployed(file));
    expect(() => read('deliver:\n  script: ./l.sh\n  deployed: ""\n')).toThrow(/deliver\.deployed/);
    expect(() => read('deliver:\n  script: ./l.sh\n  deployed: [a]\n')).toThrow(/deliver\.deployed/);
    expect(read('deliver:\n  script: ./l.sh\n  deployed: " ./sha.sh "\n')).toBe('./sha.sh');
    expect(read('deliver:\n  script: ./l.sh\n')).toBeUndefined();
  });

  it('R13 — en ligne de commande : cadence deliver --constat <sha> inscrit sans lancer le script ; deux sha sont refusés', async () => {
    const { dir, head } = repo();
    // le script échouerait : le constat ne doit pas le lancer
    writeFileSync(join(dir, 'cadence.yaml'), 'deliver:\n  script: "exit 7"\n');
    const lines: string[] = [];
    const io = { cwd: dir, env: { RAF_TODAY: TODAY }, out: (l: string) => lines.push(l), err: (l: string) => lines.push(l), now: () => new Date(`${TODAY}T12:00:00`) };
    expect(await run(['deliver', '--constat', head], io)).toBe(0);
    expect(journal(dir)).toBe(`${TODAY} ${head}\n`);
    expect(lines.join('\n')).toContain('✓ constat');
    expect(await run(['deliver', '--constat', head, '--sha', head], io)).not.toBe(0);
    expect(await run(['deliver', '--constat', head, head], io)).not.toBe(0);
    expect(lines.join('\n')).toContain('une fois');
  });

  it('R15 — --block : la ligne porte le bloc, seuls les lots du bloc sont livrés, l\'autre bloc part de sa propre dernière ligne ; un bloc inconnu est refusé', async () => {
    const { dir, planFile, base } = repo({ file: 'web/page.html' });
    mkdirSync(join(dir, 'src/api'), { recursive: true });
    writeFileSync(join(dir, 'src/api/x.ts'), 'deux\n');
    git(dir, 'add', '.');
    commit(dir, 'feat(L2): deux');
    const plan = Plan.load(planFile);
    plan.setStatus('L2', 'done', '2026-11-12', { force: true });
    plan.save();
    git(dir, 'add', '.');
    commit(dir, 'plan: L2 terminé');
    git(dir, 'push', '-q', 'origin', 'main');
    const head = headSha(dir)!;
    const config = parseDeliverConfig('deliver:\n  script: ./livrer.sh\n  blocks:\n    api: [src/api]\n    web: [web]\n', 'cadence.yaml');
    appendDelivery(sharedStateDir(dir), '2026-11-10', base);
    const delivered = (id: string) => Plan.load(planFile).lots().find((l) => l.id === id)!.delivered;

    const api = await constate(dir, planFile, { sha: head, config, block: 'api' });
    expect(api.code).toBe(0);
    expect(api.out).toContain(`✓ constat : ${head.slice(0, 7)} (bloc api) inscrit`);
    expect(journal(dir)).toBe(`2026-11-10 ${base}\n${TODAY} ${head} api\n`);
    expect(delivered('L2')).toEqual({ date: TODAY, sha: head });
    expect(delivered('L1')).toBeUndefined();

    // le même sha pour api : déjà sa dernière ligne ; pour web, sa dernière ligne est encore celle sans bloc, il s'inscrit
    expect((await constate(dir, planFile, { sha: head, config, block: 'api' })).out).toContain('déjà la dernière livraison');
    const web = await constate(dir, planFile, { sha: head, config, block: 'web' });
    expect(web.code).toBe(0);
    expect(journal(dir)).toBe(`2026-11-10 ${base}\n${TODAY} ${head} api\n${TODAY} ${head} web\n`);
    expect(delivered('L1')).toEqual({ date: TODAY, sha: head });

    // en ligne de commande : un bloc inconnu est refusé avant tout, rien n'est inscrit
    writeFileSync(join(dir, 'cadence.yaml'), 'deliver:\n  script: "exit 7"\n  blocks:\n    api: [src/api]\n    web: [web]\n');
    const lines: string[] = [];
    const io = { cwd: dir, env: { RAF_TODAY: TODAY }, out: (l: string) => lines.push(l), err: (l: string) => lines.push(l), now: () => new Date(`${TODAY}T12:00:00`) };
    expect(await run(['deliver', '--constat', head, '--block', 'mobile'], io)).toBe(2);
    expect(lines.join('\n')).toContain('--block mobile : bloc inconnu (déclarés : api, web)');
    expect(journal(dir)).toBe(`2026-11-10 ${base}\n${TODAY} ${head} api\n${TODAY} ${head} web\n`);
  });

  it('R14 — en ligne de commande, sans sha : la commande deliver.deployed lancée pour de vrai donne le sha inscrit', async () => {
    const { dir, head } = repo();
    writeFileSync(join(dir, 'cadence.yaml'), `deliver:\n  script: "exit 7"\n  deployed: "echo déployé ; echo ${head.slice(0, 10)}"\n`);
    const lines: string[] = [];
    const io = { cwd: dir, env: { RAF_TODAY: TODAY }, out: (l: string) => lines.push(l), err: (l: string) => lines.push(l), now: () => new Date(`${TODAY}T12:00:00`) };
    expect(await run(['deliver', '--constat'], io)).toBe(0);
    expect(journal(dir)).toBe(`${TODAY} ${head}\n`);
    expect(lines.join('\n')).toContain('confirmé par deliver.deployed');
  });
});
