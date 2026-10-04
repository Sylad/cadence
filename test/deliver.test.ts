import { describe, expect, it, vi } from 'vitest';
import { execFileSync, spawn } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { run } from '../src/cli.js';
import { deliver, parseDeliverConfig, realDeps, TIMED_OUT, type DeliverDeps, type GhRun } from '../src/deliver.js';
import { headSha } from '../src/git.js';
import { Plan, type PlanFormat } from '../src/plan.js';
import { appendDelivery, lastDelivery, readLock, sharedStateDir as stateDir, writeLock } from '../src/state.js';
import { commit, gitRepo, tempDir } from './helpers.js';

const git = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, stdio: 'ignore' });

/** Dépôt poussé sur un « origin » local, avec un plan L1 et un commit qui le cite. */
function pushedRepo(): string {
  const origin = tempDir();
  git(origin, 'init', '-q', '--bare', '-b', 'main');
  const dir = gitRepo();
  const plan = Plan.create(join(dir, 'docs/plan/raf.yaml'), 'demo', 'L', '2026-09-28');
  plan.add('Cache', '2026-09-28');
  plan.save();
  writeFileSync(join(dir, 'README.md'), 'demo\n');
  git(dir, 'add', '.');
  commit(dir, 'chore: plan');
  git(dir, 'remote', 'add', 'origin', origin);
  git(dir, 'push', '-q', '-u', 'origin', 'main');
  return dir;
}

function fakeDeps(over: Partial<DeliverDeps> = {}) {
  let clock = 0;
  const execs: { cmd: string; env: Record<string, string> }[] = [];
  const deps: DeliverDeps = {
    exec: (cmd, env) => {
      execs.push({ cmd, env });
      return 0;
    },
    gh: () => [{ name: 'ci', status: 'completed', conclusion: 'success' }],
    ghReady: () => null,
    fetch: async () => ({ status: 200, text: 'ok' }),
    sleep: async (ms) => {
      clock += ms;
    },
    now: () => clock,
    ...over,
  };
  return { deps, execs, clock: () => clock };
}

const CONFIG = parseDeliverConfig(
  `deliver:
  ci: github
  deploy:
    - echo "$CADENCE_SHORT"
  verify:
    - url: https://app.example/v/\${SHORT}
      contains: ok
`,
  'cadence.yaml',
);

function ctx(dir: string, over: Record<string, unknown> = {}) {
  const out: string[] = [];
  const err: string[] = [];
  return {
    c: {
      root: dir,
      state: stateDir(dir),
      // Un test qui apporte son plan (autre fichier, autre format) n'a pas de plan à l'endroit par défaut.
      plan: 'plan' in over ? (over.plan as Plan) : Plan.load(join(dir, 'docs/plan/raf.yaml')),
      config: CONFIG,
      today: '2026-09-28',
      dryRun: false,
      args: [] as string[],
      out: (l: string) => out.push(l),
      err: (l: string) => err.push(l),
      ...over,
    },
    out,
    err,
  };
}

describe('parseDeliverConfig', () => {
  it('applique les défauts', () => {
    const c = parseDeliverConfig('deliver:\n  verify:\n    - command: "true"\n', 'f');
    expect(c).toEqual({ ci: 'none', ciTimeout: 1800, deploy: [], verify: [{ command: 'true' }], verifyTimeout: 300, deployTimeout: 1800 });
  });
  it.each([
    ['foo: 1', /clé deliver absente/],
    ['deliver:\n  ci: gitlab\n  verify: [{command: x}]', /ci/],
    ['deliver:\n  deploy: {a: 1}\n  verify: [{command: x}]', /deploy/],
    ['deliver:\n  verify: []', /au moins une vérification/],
    ['deliver:\n  verify: [{status: 200}]', /verify\[1\]/],
    ['deliver:\n  verify: [{url: x, command: y}]', /verify\[1\]/],
    ['deliver:\n  ciTimeout: -1\n  verify: [{command: x}]', /ciTimeout/],
    ['deliver: [', /illisible/],
    ['deliver:\n  ci: {command: " "}\n  verify: [{command: x}]', /ci.command/],
    ['deliver:\n  deploy: [""]\n  verify: [{command: x}]', /deploy/],
  ])('refuse %j', (text, msg) => {
    expect(() => parseDeliverConfig(text, 'f')).toThrow(msg);
  });
});

describe('deliver', () => {
  it('livre : CI, déploiement avec les variables, vérification, journal, lots livrés', async () => {
    const dir = pushedRepo();
    const state = stateDir(dir);
    const { deps, execs } = fakeDeps();
    const urls: string[] = [];
    deps.fetch = async (u) => {
      urls.push(u);
      return { status: 200, text: 'ok' };
    };
    // Première livraison : pose le point de départ.
    expect(await deliver(ctx(dir).c, deps)).toBe(0);
    commit(dir, 'feat(L1): cache');
    git(dir, 'push', '-q');
    const sha = headSha(dir)!;
    const { c, out } = ctx(dir);
    expect(await deliver(c, deps)).toBe(0);
    expect(execs.at(-1)).toEqual({
      cmd: 'echo "$CADENCE_SHORT"',
      env: { CADENCE_SHA: sha, CADENCE_SHORT: sha.slice(0, 7), CADENCE_BRANCH: 'main' },
    });
    expect(urls.at(-1)).toBe(`https://app.example/v/${sha.slice(0, 7)}`);
    expect(lastDelivery(state)).toBe(sha);
    expect(readLock(state)).toBeNull();
    expect(out.join('\n')).toContain('livré : L1');
  });

  it('refuse un arbre modifié, un sha non poussé, une livraison en cours (code 2)', async () => {
    const dir = pushedRepo();
    writeFileSync(join(dir, 'README.md'), 'x');
    const a = ctx(dir);
    expect(await deliver(a.c, fakeDeps().deps)).toBe(2);
    expect(a.err.join('\n')).toContain('modifié');
    git(dir, 'checkout', '-q', '.');

    commit(dir, 'feat(L1): local');
    const b = ctx(dir);
    expect(await deliver(b.c, fakeDeps().deps)).toBe(2);
    expect(b.err.join('\n')).toContain('non poussé');
    git(dir, 'push', '-q');

    writeLock(stateDir(dir), { pid: process.pid, sha: 'x', started: 'y' });
    const c = ctx(dir);
    expect(await deliver(c.c, fakeDeps().deps)).toBe(2);
    expect(c.err.join('\n')).toContain('déjà en cours');
    expect(readLock(stateDir(dir))?.pid).toBe(process.pid);
  });

  it('retire un verrou périmé et continue', async () => {
    const dir = pushedRepo();
    writeLock(stateDir(dir), { pid: 2 ** 22 + 12345, sha: 'x', started: 'y' });
    const { c, err } = ctx(dir);
    expect(await deliver(c, fakeDeps().deps)).toBe(0);
    expect(err.join('\n')).toContain('périmé');
  });

  it('simulation : rien n’est exécuté ni verrouillé', async () => {
    const dir = pushedRepo();
    const { deps, execs } = fakeDeps({ gh: () => { throw new Error('gh appelé'); } });
    const { c, out } = ctx(dir, { dryRun: true });
    expect(await deliver(c, deps)).toBe(0);
    expect(execs).toEqual([]);
    expect(lastDelivery(stateDir(dir))).toBeNull();
    expect(out.join('\n')).toMatch(/simulation[\s\S]*1\. echo "\$CADENCE_SHORT"[\s\S]*GET https:\/\/app\.example\/v\/[0-9a-f]{7} → 200, contient « ok »/);
  });

  it('CI : aucun run après 5 min → échec, verrou retiré', async () => {
    const dir = pushedRepo();
    let calls = 0;
    const { deps, execs, clock } = fakeDeps({ gh: () => (calls++, []) });
    const { c, err } = ctx(dir);
    expect(await deliver(c, deps)).toBe(1);
    expect(err.join('\n')).toContain('aucun run CI');
    expect(clock()).toBeGreaterThanOrEqual(300_000);
    expect(calls).toBeGreaterThan(1);
    expect(execs).toEqual([]);
    expect(readLock(stateDir(dir))).toBeNull();
  });

  it('CI : attend que les runs apparaissent puis se terminent ; échec nommé', async () => {
    const dir = pushedRepo();
    const seq: GhRun[][] = [
      [],
      [{ name: 'build', status: 'in_progress', conclusion: '' }],
      [
        { name: 'build', status: 'completed', conclusion: 'failure' },
        { name: 'lint', status: 'completed', conclusion: 'skipped' },
      ],
    ];
    const { deps } = fakeDeps({ gh: () => seq.shift() ?? [] });
    const { c, err } = ctx(dir);
    expect(await deliver(c, deps)).toBe(1);
    expect(err.join('\n')).toContain('CI en échec : build (failure)');
  });

  it('déploiement en échec : arrêt, verrou retiré', async () => {
    const dir = pushedRepo();
    const { deps } = fakeDeps({ exec: () => 3 });
    const { c, err } = ctx(dir);
    expect(await deliver(c, deps)).toBe(1);
    expect(err.join('\n')).toContain('code 3');
    expect(readLock(stateDir(dir))).toBeNull();
  });

  it('vérifications réessayées jusqu’au délai, dernière raison affichée', async () => {
    const dir = pushedRepo();
    let n = 0;
    const ok = fakeDeps({ fetch: async () => (++n < 3 ? { status: 502, text: '' } : { status: 200, text: 'ok' }) });
    expect(await deliver(ctx(dir).c, ok.deps)).toBe(0);
    expect(n).toBe(3);

    const ko = fakeDeps({ fetch: async () => ({ status: 200, text: 'ancienne version' }) });
    const { c, err } = ctx(dir);
    expect(await deliver(c, ko.deps)).toBe(1);
    expect(err.join('\n')).toContain('« ok » absent');
    expect(ko.clock()).toBeGreaterThanOrEqual(300_000);
  });
});

describe('deliver : relecture', () => {
  it('refuse sans gh authentifié (code 2, avant le verrou)', async () => {
    const dir = pushedRepo();
    const { c, err } = ctx(dir);
    expect(await deliver(c, fakeDeps({ ghReady: () => 'gh auth login' }).deps)).toBe(2);
    expect(err.join('\n')).toContain('gh auth login');
    expect(readLock(stateDir(dir))).toBeNull();
  });

  it('réessaie une erreur gh passagère, abandonne une erreur persistante avec sa cause', async () => {
    let n = 0;
    const flaky = fakeDeps({
      gh: () => {
        if (++n < 3) throw new Error('HTTP 502');
        return [{ name: 'ci', status: 'completed', conclusion: 'success' }];
      },
    });
    expect(await deliver(ctx(pushedRepo()).c, flaky.deps)).toBe(0);
    const down = fakeDeps({ gh: () => { throw new Error('API rate limit exceeded'); } });
    const { c, err } = ctx(pushedRepo());
    expect(await deliver(c, down.deps)).toBe(1);
    expect(err.join('\n')).toContain('gh run list en échec : API rate limit exceeded');
  });

  it('commande qui dépasse son délai : échec explicite', async () => {
    const { c, err } = ctx(pushedRepo());
    expect(await deliver(c, fakeDeps({ exec: () => TIMED_OUT }).deps)).toBe(1);
    expect(err.join('\n')).toContain('délai dépassé');
  });

  it("vérification : l'attente entre deux essais ne dépasse jamais le délai restant", async () => {
    const config = parseDeliverConfig('deliver:\n  verify:\n    - url: https://app.example/\n  verifyTimeout: 15\n', 'cadence.yaml');
    const { c, err } = ctx(pushedRepo(), { config });
    const sleeps: number[] = [];
    let clock = 0;
    const f = fakeDeps({
      fetch: async () => ({ status: 502, text: '' }),
      sleep: async (ms) => {
        sleeps.push(ms);
        clock += ms;
      },
      now: () => clock,
    });
    expect(await deliver(c, f.deps)).toBe(1);
    expect(err.join('\n')).toContain('vérification en échec après 15 s');
    expect(sleeps).toEqual([10_000, 5_000]);
  });

  it("vérification tuée une milliseconde avant l'échéance : pas d'attente de 10 s au-delà du délai", async () => {
    const config = parseDeliverConfig('deliver:\n  verify:\n    - command: sleep 30\n  verifyTimeout: 1\n', 'cadence.yaml');
    const { c, err } = ctx(pushedRepo(), { config });
    const sleeps: number[] = [];
    let clock = 0;
    let runs = 0;
    const f = fakeDeps({
      // l'horloge murale lue juste après l'arrêt de la commande peut précéder l'échéance d'un rien
      exec: () => {
        clock += ++runs === 1 ? 999 : 1_000;
        return TIMED_OUT;
      },
      sleep: async (ms) => {
        sleeps.push(ms);
        clock += ms;
      },
      now: () => clock,
    });
    expect(await deliver(c, f.deps)).toBe(1);
    expect(err.join('\n')).toContain('délai dépassé');
    expect(sleeps).toEqual([1]);
    expect(clock).toBeLessThan(5_000);
  });

  it('HEAD détachée : CADENCE_BRANCH vide', async () => {
    const dir = pushedRepo();
    git(dir, 'checkout', '-q', '--detach');
    const { deps, execs } = fakeDeps();
    expect(await deliver(ctx(dir).c, deps)).toBe(0);
    expect(execs[0].env.CADENCE_BRANCH).toBe('');
  });

  it('historique réécrit : lots non calculés, annoncés comme tels', async () => {
    const dir = pushedRepo();
    appendDelivery(stateDir(dir), '2026-09-27', 'f'.repeat(40));
    commit(dir, 'feat(L1): cache');
    git(dir, 'push', '-q');
    const { c, out } = ctx(dir);
    expect(await deliver(c, fakeDeps().deps)).toBe(0);
    expect(out.join('\n')).toContain('lots livrés non calculés');
  });
});

describe('deliver : script du projet (L2)', () => {
  const SCRIPT = parseDeliverConfig('deliver:\n  script: ./livrer.sh "$CADENCE_SHORT"\n', 'cadence.yaml');

  it('lit script seul (vérifications facultatives), refuse script avec ci ou deploy, script vide', () => {
    expect(SCRIPT).toMatchObject({ script: './livrer.sh "$CADENCE_SHORT"', ci: 'none', deploy: [], verify: [] });
    expect(() => parseDeliverConfig('deliver:\n  script: x\n  deploy: [y]\n', 'f')).toThrow(/script remplace ci et deploy/);
    expect(() => parseDeliverConfig('deliver:\n  script: x\n  ci: github\n', 'f')).toThrow(/script remplace ci et deploy/);
    expect(() => parseDeliverConfig('deliver:\n  script: " "\n', 'f')).toThrow(/script/);
    expect(() => parseDeliverConfig('deliver:\n  script: [a]\n', 'f')).toThrow(/script/);
  });

  it('appelle le script avec les arguments de la ligne de commande, sans gh, puis journalise', async () => {
    const dir = pushedRepo();
    const { deps, execs } = fakeDeps({ gh: () => { throw new Error('gh appelé'); }, ghReady: () => 'absent' });
    const { c, out } = ctx(dir, { config: SCRIPT, args: ['api', 'frontend:nouvelle page', '--news', "l'entrée.md", '--', 'map'] });
    expect(await deliver(c, deps)).toBe(0);
    expect(execs.map((e) => e.cmd)).toEqual([`./livrer.sh "$CADENCE_SHORT" api 'frontend:nouvelle page' --news 'l'\\''entrée.md' -- map`]);
    expect(execs[0].env.CADENCE_SHORT).toBe(headSha(dir)!.slice(0, 7));
    expect(lastDelivery(stateDir(dir))).toBe(headSha(dir));
    expect(readLock(stateDir(dir))).toBeNull();
    expect(out.join('\n')).toContain('✓ livré');
  });

  it('refuse des arguments sans script (code 2, rien exécuté)', async () => {
    const dir = pushedRepo();
    const { deps, execs } = fakeDeps();
    const { c, err } = ctx(dir, { args: ['api'] });
    expect(await deliver(c, deps)).toBe(2);
    expect(err.join('\n')).toContain('deliver.script');
    expect(execs).toEqual([]);
  });

  it('script en échec : code 1, rien au journal, verrou retiré', async () => {
    const dir = pushedRepo();
    const { c, err } = ctx(dir, { config: SCRIPT });
    expect(await deliver(c, fakeDeps({ exec: () => 3 }).deps)).toBe(1);
    expect(err.join('\n')).toContain('script de livraison en échec (code 3)');
    expect(lastDelivery(stateDir(dir))).toBeNull();
    expect(readLock(stateDir(dir))).toBeNull();
  });

  it('vérifications de cadence.yaml jouées après le script', async () => {
    const dir = pushedRepo();
    const config = parseDeliverConfig('deliver:\n  script: ./livrer.sh\n  verifyTimeout: 20\n  verify:\n    - url: https://app.example/\n', 'f');
    const { c, err } = ctx(dir, { config });
    expect(await deliver(c, fakeDeps({ fetch: async () => ({ status: 502, text: '' }) }).deps)).toBe(1);
    expect(err.join('\n')).toContain('statut 502');
  });

  it('script qui commite et pousse (horodatage des Nouveautés) : le sha journalisé est la nouvelle tête', async () => {
    const dir = pushedRepo();
    expect(await deliver(ctx(dir, { config: SCRIPT }).c, fakeDeps().deps)).toBe(0);
    commit(dir, 'feat(L1): cache');
    git(dir, 'push', '-q');
    const { deps } = fakeDeps({
      exec: () => {
        commit(dir, 'nouveautés : horodatées');
        git(dir, 'push', '-q');
        return 0;
      },
    });
    const { c, out } = ctx(dir, { config: SCRIPT });
    expect(await deliver(c, deps)).toBe(0);
    expect(lastDelivery(stateDir(dir))).toBe(headSha(dir));
    expect(out.join('\n')).toMatch(/✓ livré : [0-9a-f]{7} \(tête déplacée par le script depuis [0-9a-f]{7}\)/);
    expect(out.join('\n')).toContain('livré : L1');
  });

  it('simulation : montre la commande complète, n’exécute rien', async () => {
    const dir = pushedRepo();
    const { deps, execs } = fakeDeps();
    const { c, out } = ctx(dir, { config: SCRIPT, args: ['api'], dryRun: true });
    expect(await deliver(c, deps)).toBe(0);
    expect(execs).toEqual([]);
    expect(out.join('\n')).toContain('Script du projet : ./livrer.sh "$CADENCE_SHORT" api');
  });

  it('plan en lecture seule : seuls les lots en cours au départ de la livraison sont annoncés livrés', async () => {
    // Cas du 03-10 (maritime-atlas) : « livré : Q4, R1, R2, R3, R4 » — R1 à R4 étaient les numéros des
    // réserves d'une revue UX cités dans les messages, pris pour les lots (clos) qui portent ce nom.
    const origin = tempDir();
    git(origin, 'init', '-q', '--bare', '-b', 'main');
    const dir = gitRepo();
    const file = join(dir, 'taches.yaml');
    const taches = (q4: string) =>
      `taches:\n- { id: Q4, titre: Mandat UX, etat: ${q4} }\n- { id: Q5, titre: Suite, etat: prevu }\n` +
      ['R1', 'R2', 'R3', 'R4'].map((id) => `- { id: ${id}, titre: Réserve close, etat: deploye }\n`).join('');
    writeFileSync(file, taches('en_cours'));
    git(dir, 'add', 'taches.yaml');
    commit(dir, 'plan: adoption');
    git(dir, 'remote', 'add', 'origin', origin);
    git(dir, 'push', '-q', '-u', 'origin', 'main');
    const format: PlanFormat = { lots: 'taches', fields: { title: ['titre'], status: ['etat'] }, statuses: { prevu: 'todo', en_cours: 'doing', deploye: 'done' }, estimates: {} };
    const load = () => Plan.load(file, { format });
    expect(await deliver(ctx(dir, { config: SCRIPT, plan: load() }).c, fakeDeps().deps)).toBe(0);
    commit(dir, 'fix(Q4): ux10 — réserves R1 et R2 de la revue levées');
    commit(dir, 'docs(Q4): registre UX — R3, R4 ; suite prévue en Q5');
    git(dir, 'push', '-q');
    // L'outil du projet ferme le lot pendant qu'il livre : cadence a lu le plan avant.
    const { deps } = fakeDeps({
      exec: () => {
        writeFileSync(file, taches('deploye'));
        return 0;
      },
    });
    const { c, out } = ctx(dir, { config: { ...SCRIPT, allowDirty: true }, plan: load() });
    expect(await deliver(c, deps)).toBe(0);
    expect(out.filter((l) => l.startsWith('livré :'))).toEqual(["livré : Q4 — à fermer avec l'outil du projet si l'effet est celui attendu"]);
  });

  it('(L15/t3) la portée décide des lots livrés : « chore(L1): … (L2) planifié » n\'annonce que L1', async () => {
    const dir = pushedRepo();
    const file = join(dir, 'docs/plan/raf.yaml');
    expect(await deliver(ctx(dir, { config: SCRIPT, plan: Plan.load(file) }).c, fakeDeps().deps)).toBe(0);
    const plan = Plan.load(file);
    plan.add('Suite', '2026-09-28');
    plan.save();
    writeFileSync(join(dir, 'README.md'), 'demo v2\n'); // un fichier source : pas de l'entretien du plan
    git(dir, 'add', '.');
    commit(dir, 'chore(L1): cache livré — (L2) planifié et (L2–L3) à suivre');
    git(dir, 'push', '-q');
    const { c, out } = ctx(dir, { config: SCRIPT, plan: Plan.load(file) });
    expect(await deliver(c, fakeDeps().deps)).toBe(0);
    expect(out.filter((l) => l.startsWith('livré :'))).toEqual(['livré : L1 — raf done si l\'effet est celui attendu']);
  });

  it('un commit d\'entretien du plan n\'annonce aucun lot livré (cas warhammer 883be18 : « rattaché à L2 »)', async () => {
    const dir = pushedRepo();
    expect(await deliver(ctx(dir).c, fakeDeps().deps)).toBe(0);
    commit(dir, 'feat(L1): cache');
    const plan = Plan.load(join(dir, 'docs/plan/raf.yaml'));
    plan.add('Suite', '2026-09-28');
    plan.save();
    git(dir, 'add', 'docs/plan/raf.yaml');
    commit(dir, 'plan: L1 terminé — mineur de relecture rattaché à L2');
    git(dir, 'push', '-q');
    const { c, out } = ctx(dir);
    expect(await deliver(c, fakeDeps().deps)).toBe(0);
    expect(out.filter((l) => l.startsWith('livré :'))).toEqual(['livré : L1 — raf done si l\'effet est celui attendu']);
  });

  it('plan en lecture seule : aucun lot en cours cité → aucune ligne de lots livrés', async () => {
    const dir = pushedRepo();
    const plan = Plan.load(join(dir, 'docs/plan/raf.yaml'), { format: { lots: 'lots', fields: {}, statuses: {}, estimates: {} } });
    expect(plan.lot('L1').status).toBe('todo');
    expect(await deliver(ctx(dir, { config: SCRIPT, plan }).c, fakeDeps().deps)).toBe(0);
    commit(dir, 'feat(L1): cache');
    git(dir, 'push', '-q');
    const { c, out } = ctx(dir, { config: SCRIPT, plan });
    expect(await deliver(c, fakeDeps().deps)).toBe(0);
    expect(out.join('\n')).toContain('✓ livré');
    expect(out.join('\n')).not.toContain('livré : L1');
  });

  it('plan au format de raf : inchangé, un lot cité est annoncé quel que soit son statut', async () => {
    const dir = pushedRepo();
    expect(await deliver(ctx(dir).c, fakeDeps().deps)).toBe(0);
    commit(dir, 'feat(L1): cache');
    git(dir, 'push', '-q');
    const { c, out } = ctx(dir);
    expect(c.plan.lot('L1').status).toBe('todo');
    expect(await deliver(c, fakeDeps().deps)).toBe(0);
    expect(out.join('\n')).toContain('livré : L1 — raf done si l\'effet est celui attendu');
  });

  it('plan en lecture seule : pas de conseil « raf done »', async () => {
    const dir = pushedRepo();
    const path = join(dir, 'docs/plan/raf.yaml');
    writeFileSync(path, readFileSync(path, 'utf8').replace('status: todo', 'status: doing'));
    git(dir, 'commit', '-qam', 'plan: lot en cours');
    git(dir, 'push', '-q');
    const plan = Plan.load(join(dir, 'docs/plan/raf.yaml'), { format: { lots: 'lots', fields: {}, statuses: {}, estimates: {} } });
    expect(await deliver(ctx(dir, { config: SCRIPT, plan }).c, fakeDeps().deps)).toBe(0);
    commit(dir, 'feat(L1): cache');
    git(dir, 'push', '-q');
    const { c, out } = ctx(dir, { config: SCRIPT, plan });
    expect(await deliver(c, fakeDeps().deps)).toBe(0);
    expect(out.join('\n')).toContain('livré : L1');
    expect(out.join('\n')).not.toContain('raf done');
  });
});

describe('deliver : sha choisi et arbre partagé (L2)', () => {
  const SCRIPT = parseDeliverConfig('deliver:\n  script: ./livrer.sh "$CADENCE_SHORT"\n  allowDirty: true\n', 'cadence.yaml');

  it('--sha livre un commit antérieur à la tête : variables, journal, lots jusqu’à lui seulement', async () => {
    const dir = pushedRepo();
    expect(await deliver(ctx(dir, { config: SCRIPT }).c, fakeDeps().deps)).toBe(0);
    commit(dir, 'feat(L1): api');
    const api = headSha(dir)!;
    commit(dir, 'feat(L9): frontend');
    git(dir, 'push', '-q');
    const { deps, execs } = fakeDeps();
    const { c, out } = ctx(dir, { config: SCRIPT, sha: api.slice(0, 7) });
    expect(await deliver(c, deps)).toBe(0);
    expect(execs[0].env).toMatchObject({ CADENCE_SHA: api, CADENCE_SHORT: api.slice(0, 7) });
    expect(lastDelivery(stateDir(dir))).toBe(api);
    expect(out.join('\n')).toContain('livré : L1');
  });

  it('--sha inconnu ou non poussé : refus (code 2)', async () => {
    const dir = pushedRepo();
    const a = ctx(dir, { config: SCRIPT, sha: 'deadbeef' });
    expect(await deliver(a.c, fakeDeps().deps)).toBe(2);
    expect(a.err.join('\n')).toContain('deadbeef');
    commit(dir, 'feat(L1): local');
    const b = ctx(dir, { config: SCRIPT, sha: 'HEAD' });
    expect(await deliver(b.c, fakeDeps().deps)).toBe(2);
    expect(b.err.join('\n')).toContain('non poussé');
  });

  it('allowDirty : un arbre modifié est signalé, pas refusé ; sans la clé il reste refusé', async () => {
    const dir = pushedRepo();
    writeFileSync(join(dir, 'README.md'), 'autre session');
    const { c, err } = ctx(dir, { config: SCRIPT });
    expect(await deliver(c, fakeDeps().deps)).toBe(0);
    expect(err.join('\n')).toContain('1 fichier(s) suivi(s) modifié(s) : non livré(s)');
    expect(() => parseDeliverConfig('deliver:\n  script: x\n  allowDirty: oui\n', 'f')).toThrow(/allowDirty/);
  });
});

describe('cadence deliver (CLI)', () => {
  async function cad(dir: string, ...argv: string[]) {
    const out: string[] = [];
    const err: string[] = [];
    const code = await run(argv, { cwd: dir, env: { RAF_TODAY: '2026-09-28' }, out: (l) => out.push(l), err: (l) => err.push(l), now: () => new Date() });
    return { code, out: out.join('\n'), err: err.join('\n') };
  }

  it('refuse sans cadence.yaml', async () => {
    const r = await cad(pushedRepo(), 'deliver');
    expect(r.code).toBe(2);
    expect(r.err).toContain('cadence.yaml');
  });

  it('livre pour de vrai avec des commandes shell', async () => {
    const dir = pushedRepo();
    writeFileSync(
      join(dir, 'cadence.yaml'),
      'deliver:\n  deploy:\n    - echo "$CADENCE_SHORT" > .git/deployed-$CADENCE_BRANCH\n  verify:\n    - command: test -s .git/deployed-main\n',
    );
    git(dir, 'add', 'cadence.yaml');
    commit(dir, 'chore: config');
    git(dir, 'push', '-q');
    expect((await cad(dir, 'deliver', '--dry-run')).code).toBe(0);
    expect(existsSync(join(dir, '.git/deployed-main'))).toBe(false);
    const r = await cad(dir, 'deliver');
    expect(r.code).toBe(0);
    expect(readFileSync(join(dir, '.git/deployed-main'), 'utf8').trim()).toBe(headSha(dir)!.slice(0, 7));
  });

  it('tue une vérification qui dépasse le délai', async () => {
    const dir = pushedRepo();
    writeFileSync(join(dir, 'cadence.yaml'), 'deliver:\n  verify:\n    - command: exec sleep 30\n  verifyTimeout: 1\n');
    git(dir, 'add', 'cadence.yaml');
    commit(dir, 'chore: config');
    git(dir, 'push', '-q');
    const t = Date.now();
    const r = await cad(dir, 'deliver');
    expect(r.code).toBe(1);
    expect(r.err).toContain('délai dépassé');
    expect(Date.now() - t).toBeLessThan(10_000);
  });

  it('script du projet : les arguments après « -- » lui sont passés tels quels', async () => {
    const dir = pushedRepo();
    writeFileSync(join(dir, 'cadence.yaml'), 'deliver:\n  script: sh -c \'printf "%s\\n" "$@" > .git/args\' livrer "$CADENCE_SHORT"\n');
    git(dir, 'add', 'cadence.yaml');
    commit(dir, 'chore: config');
    git(dir, 'push', '-q');
    const r = await cad(dir, 'deliver', '--', 'api', 'frontend:deux mots', '--news', 'a.md', '--', 'map');
    expect(r.code).toBe(0);
    expect(readFileSync(join(dir, '.git/args'), 'utf8').trim().split('\n')).toEqual([headSha(dir)!.slice(0, 7), 'api', 'frontend:deux mots', '--news', 'a.md', '--', 'map']);
  });
});

describe('deliver : Ctrl-C et raccrochage (revue L19)', () => {
  const alive = (pid: number) => {
    try {
      process.kill(pid, 0);
      return true;
    } catch {
      return false;
    }
  };
  const until = async (ok: () => boolean, ms: number) => {
    for (let t = 0; t < ms && !ok(); t += 50) await new Promise((r) => setTimeout(r, 50));
    return ok();
  };

  it('une commande de deliver reste dans la session et le groupe de premier plan de cadence (tty, Ctrl-C)', async () => {
    const [sid, pgid] = execFileSync('ps', ['-o', 'sid=,pgid=', '-p', String(process.pid)], { encoding: 'utf8' }).trim().split(/\s+/);
    const probe = 'test "$(ps -o sid= -p $$ | tr -d " ")" = "$WANT_SID" && test "$(ps -o pgid= -p $$ | tr -d " ")" = "$WANT_PGID"';
    expect(await realDeps(tempDir()).exec(probe, { WANT_SID: sid!, WANT_PGID: pgid! }, 5_000)).toBe(0);
  });

  it('relevé des processus indisponible : le message part une seule fois sur stderr, la commande va au bout', async () => {
    const write = vi.spyOn(process.stderr, 'write');
    try {
      const d = realDeps(tempDir(), () => null);
      expect(await d.exec('sleep 1; exit 3', {}, 5_000)).toBe(3); // plusieurs relevés (200 ms) pendant la commande
      const said = write.mock.calls.filter(([m]) => String(m).includes('relevé des processus indisponible'));
      expect(said).toHaveLength(1);
      expect(String(said[0]![0])).toContain('seule la commande racine');
    } finally {
      write.mockRestore();
    }
  });

  it('garde les codes de sortie (une commande à la fois, attendue)', async () => {
    const d = realDeps(tempDir());
    expect(await d.exec('true', {}, 5_000)).toBe(0);
    expect(await d.exec('exit 7', {}, 5_000)).toBe(7);
    expect(await d.exec('test "$CADENCE_X" = oui', { CADENCE_X: 'oui' }, 5_000)).toBe(0);
    expect(await d.exec('sleep 5', {}, 300)).toBe(TIMED_OUT);
  });

  it.each(['SIGINT', 'SIGHUP'] as const)(
    '%s au groupe de premier plan pendant le script : le script meurt avec cadence, jamais deux livraisons à la fois',
    async (sig) => {
      const logs = tempDir();
      const dir = pushedRepo();
      // le sh du script note son pid, dort, puis « bumpe » : ce qu'ont fait deux livraisons concurrentes le 04-10
      writeFileSync(join(dir, 'cadence.yaml'), `deliver:\n  script: sh -c 'echo $$ >> ${logs}/pids; sleep 3; echo bumped >> ${logs}/log'\n`);
      git(dir, 'add', 'cadence.yaml');
      commit(dir, 'chore: config');
      git(dir, 'push', '-q');

      const probe = join(logs, 'probe.ts');
      writeFileSync(
        probe,
        `import { run } from ${JSON.stringify(join(process.cwd(), 'src/cli.ts'))};\n` +
          `process.exitCode = await run(['deliver'], { cwd: ${JSON.stringify(dir)}, env: process.env, out: () => {}, err: () => {}, now: () => new Date() });\n`,
      );
      // groupe à lui, comme un terminal donne le sien à la commande de premier plan
      const first = spawn(join(process.cwd(), 'node_modules/.bin/vite-node'), [probe], { detached: true, stdio: 'ignore' });
      const exited = new Promise<void>((r) => first.on('exit', () => r()));
      try {
        expect(await until(() => existsSync(join(logs, 'pids')), 15_000)).toBe(true);
        const scriptPid = Number(readFileSync(join(logs, 'pids'), 'utf8').trim());
        process.kill(-first.pid!, sig); // ce que fait le terminal : tout le groupe de premier plan
        await exited;
        const survived = !(await until(() => !alive(scriptPid), 2_000));
        if (survived) process.kill(scriptPid, 'SIGKILL');
        expect(survived).toBe(false);

        // seconde livraison : le verrou du mort est périmé, mais plus rien ne tourne en parallèle
        const second = await run(['deliver'], { cwd: dir, env: {}, out: () => {}, err: () => {}, now: () => new Date() });
        expect(second).toBe(0);
        await new Promise((r) => setTimeout(r, 500));
        expect(readFileSync(join(logs, 'log'), 'utf8').trim().split('\n')).toEqual(['bumped']);
      } finally {
        try {
          process.kill(-first.pid!, 'SIGKILL');
        } catch {
          // déjà mort
        }
      }
    },
    30_000,
  );
});

describe('deliver : délai dépassé et SIGTERM à cadence seul (L20)', () => {
  const alive = (pid: number) => {
    try {
      process.kill(pid, 0);
      return true;
    } catch {
      return false;
    }
  };
  const until = async (ok: () => boolean, ms: number) => {
    for (let t = 0; t < ms && !ok(); t += 50) await new Promise((r) => setTimeout(r, 50));
    return ok();
  };
  const pause = (ms: number) => new Promise((r) => setTimeout(r, ms));
  const lines = (file: string) => (existsSync(file) ? readFileSync(file, 'utf8').trim().split('\n') : []);

  /**
   * Dépôt poussé dont le script de livraison est un fichier ./livrer.sh — sh fait un fork pour chaque commande.
   * Première exécution : note son pid, dort `sleep` s puis « bumpe » ; les suivantes bumpent tout de suite.
   */
  function scriptRepo(logs: string, sleep: number, extra = '', grandchild = false): string {
    const dir = pushedRepo();
    // grandchild : le bump est fait par un PETIT-ENFANT (sous-shell puis `sh -c` imbriqué, comme livrer.sh qui pousse le gitops)
    const first = grandchild
      ? `echo $$ > '${logs}/first'; ( sh -c "sleep ${sleep}; echo bumped >> '${logs}/bumps'" ); exit 0`
      : `echo $$ > '${logs}/first'; sleep ${sleep}`;
    writeFileSync(join(dir, 'livrer.sh'), `#!/bin/sh\nif [ ! -e '${logs}/first' ]; then ${first}; fi\necho bumped >> '${logs}/bumps'\n`, {
      mode: 0o755,
    });
    writeFileSync(join(dir, 'cadence.yaml'), `deliver:\n  script: ./livrer.sh\n${extra}`);
    git(dir, 'add', 'livrer.sh', 'cadence.yaml');
    commit(dir, 'chore: config');
    git(dir, 'push', '-q');
    return dir;
  }

  it('realDeps.exec : au délai, aucun descendant de la commande ne survit (le fork de sh compris)', async () => {
    const dir = tempDir();
    writeFileSync(join(dir, 'livrer.sh'), `#!/bin/sh\nsleep 3\necho bumped > '${dir}/bumped'\n`, { mode: 0o755 });
    const t = Date.now();
    expect(await realDeps(dir).exec('./livrer.sh', {}, 1_000)).toBe(TIMED_OUT);
    expect(Date.now() - t).toBeLessThan(2_500);
    await pause(3_000);
    expect(existsSync(join(dir, 'bumped'))).toBe(false);
  }, 15_000);

  it.each([false, true])('(a) script tué au deployTimeout (bump par un petit-enfant : %s) : ses descendants meurent avec lui, une seconde livraison ne court jamais en même temps', async (grandchild) => {
    const logs = tempDir();
    const dir = scriptRepo(logs, 3, '  deployTimeout: 1\n', grandchild);
    const cad = () => run(['deliver'], { cwd: dir, env: {}, out: () => {}, err: () => {}, now: () => new Date() });
    expect(await cad()).toBe(1); // délai dépassé
    expect(await cad()).toBe(0); // la seconde bumpe tout de suite
    await pause(3_000); // au-delà du réveil du sleep du premier script
    expect(lines(join(logs, 'bumps'))).toEqual(['bumped']);
  }, 20_000);

  it('SIGINT au groupe de premier plan : le trap du script a le temps de finir (délai de grâce), puis plus aucun descendant ni livraison concurrente', async () => {
    const logs = tempDir();
    const dir = pushedRepo();
    writeFileSync(
      join(dir, 'livrer.sh'),
      `#!/bin/sh\nif [ ! -e '${logs}/first' ]; then\n  echo $$ > '${logs}/first'\n  trap 'echo trap-start >> '${logs}/trap'; sleep 0.2; echo trap-done >> '${logs}/trap'; exit 130' INT\n  sleep 3\n  ( sh -c "sleep 0; echo bumped >> '${logs}/bumps'" )\nelse\n  echo bumped >> '${logs}/bumps'\nfi\n`,
      { mode: 0o755 },
    );
    writeFileSync(join(dir, 'cadence.yaml'), 'deliver:\n  script: ./livrer.sh\n');
    git(dir, 'add', 'livrer.sh', 'cadence.yaml');
    commit(dir, 'chore: config');
    git(dir, 'push', '-q');
    const probe = join(logs, 'probe.ts');
    writeFileSync(
      probe,
      `import { run } from ${JSON.stringify(join(process.cwd(), 'src/cli.ts'))};\n` +
        `process.exitCode = await run(['deliver'], { cwd: ${JSON.stringify(dir)}, env: process.env, out: () => {}, err: () => {}, now: () => new Date() });\n`,
    );
    const first = spawn(join(process.cwd(), 'node_modules/.bin/vite-node'), [probe], { detached: true, stdio: 'ignore' });
    const exited = new Promise<void>((r) => first.on('exit', () => r()));
    try {
      expect(await until(() => existsSync(join(logs, 'first')), 15_000)).toBe(true);
      await pause(300); // le trap est posé
      const scriptPid = Number(readFileSync(join(logs, 'first'), 'utf8').trim());
      process.kill(-first.pid!, 'SIGINT'); // ce que fait le terminal
      await exited;
      expect(lines(join(logs, 'trap'))).toEqual(['trap-start', 'trap-done']); // le trap est allé au bout
      expect(alive(scriptPid)).toBe(false);

      const second = await run(['deliver'], { cwd: dir, env: {}, out: () => {}, err: () => {}, now: () => new Date() });
      expect(second).toBe(0);
      await pause(3_000);
      expect(lines(join(logs, 'bumps'))).toEqual(['bumped']);
    } finally {
      try {
        process.kill(-first.pid!, 'SIGKILL');
      } catch {
        // déjà mort
      }
    }
  }, 30_000);

  it.each([false, true])('(b) SIGTERM envoyé à cadence seul pendant le script (bump par un petit-enfant : %s) : le script et ses descendants meurent, un seul bump', async (grandchild) => {
    const logs = tempDir();
    const dir = scriptRepo(logs, 3, '', grandchild);
    const probe = join(logs, 'probe.ts');
    writeFileSync(
      probe,
      `import { run } from ${JSON.stringify(join(process.cwd(), 'src/cli.ts'))};\n` +
        `process.exitCode = await run(['deliver'], { cwd: ${JSON.stringify(dir)}, env: process.env, out: () => {}, err: () => {}, now: () => new Date() });\n`,
    );
    const first = spawn(join(process.cwd(), 'node_modules/.bin/vite-node'), [probe], { detached: true, stdio: 'ignore' });
    const exited = new Promise<void>((r) => first.on('exit', () => r()));
    try {
      expect(await until(() => existsSync(join(logs, 'first')), 15_000)).toBe(true);
      const scriptPid = Number(readFileSync(join(logs, 'first'), 'utf8').trim());
      const t = Date.now();
      process.kill(first.pid!, 'SIGTERM'); // à cadence SEUL, pas au groupe
      await exited;
      expect(Date.now() - t).toBeLessThan(2_000); // tué sans attendre la fin du script
      const survived = !(await until(() => !alive(scriptPid), 2_000));
      expect(survived).toBe(false);

      const second = await run(['deliver'], { cwd: dir, env: {}, out: () => {}, err: () => {}, now: () => new Date() });
      expect(second).toBe(0);
      await pause(3_000);
      expect(lines(join(logs, 'bumps'))).toEqual(['bumped']);
    } finally {
      try {
        process.kill(-first.pid!, 'SIGKILL');
      } catch {
        // déjà mort
      }
    }
  }, 30_000);
});

describe('deliver : suivi continu des descendants, verrou tenu jusqu’à l’arbre vide (re-revue L20)', () => {
  const pause = (ms: number) => new Promise((r) => setTimeout(r, ms));
  const until = async (ok: () => boolean, ms: number) => {
    for (let t = 0; t < ms && !ok(); t += 50) await pause(50);
    return ok();
  };
  const lines = (file: string) => (existsSync(file) ? readFileSync(file, 'utf8').trim().split('\n') : []);
  const cad = (dir: string) => run(['deliver'], { cwd: dir, env: {}, out: () => {}, err: () => {}, now: () => new Date() });

  /** Dépôt poussé dont ./livrer.sh joue `first` à la première livraison, et bumpe tout de suite aux suivantes. */
  function scriptRepo(logs: string, first: string): string {
    const dir = pushedRepo();
    writeFileSync(
      join(dir, 'livrer.sh'),
      `#!/bin/sh\nif [ ! -e '${logs}/first' ]; then\n  echo $$ > '${logs}/first'\n${first}\nelse\n  echo bumped >> '${logs}/bumps'\nfi\n`,
      { mode: 0o755 },
    );
    writeFileSync(join(dir, 'cadence.yaml'), 'deliver:\n  script: ./livrer.sh\n');
    git(dir, 'add', 'livrer.sh', 'cadence.yaml');
    commit(dir, 'chore: config');
    git(dir, 'push', '-q');
    return dir;
  }

  /** Première livraison dans un groupe à elle (le groupe de premier plan d'un terminal), lancée par vite-node. */
  function startFirst(logs: string, dir: string) {
    const probe = join(logs, 'probe.ts');
    writeFileSync(
      probe,
      `import { run } from ${JSON.stringify(join(process.cwd(), 'src/cli.ts'))};\n` +
        `process.exitCode = await run(['deliver'], { cwd: ${JSON.stringify(dir)}, env: process.env, out: () => {}, err: () => {}, now: () => new Date() });\n`,
    );
    const child = spawn(join(process.cwd(), 'node_modules/.bin/vite-node'), [probe], { detached: true, stdio: 'ignore' });
    const exited = new Promise<number>((r) => child.on('exit', () => r(Date.now())));
    const cleanup = () => {
      try {
        process.kill(-child.pid!, 'SIGKILL');
      } catch {
        // déjà mort
      }
    };
    return { child, exited, cleanup };
  }

  it('(a) Ctrl-C : un enfant en arrière-plan qui ignore SIGINT, son shell mort, est tué au plus tard à l’échéance de la grâce — un seul bump', async () => {
    const logs = tempDir();
    // `&` dans un sh non interactif : l'enfant ignore SIGINT ; le script, lui, meurt du signal dans `wait`
    const dir = scriptRepo(logs, `  sh -c "sleep 3; echo bumped >> '${logs}/bumps'" &\n  wait`);
    const first = startFirst(logs, dir);
    try {
      expect(await until(() => existsSync(join(logs, 'first')), 15_000)).toBe(true);
      await pause(600); // au moins deux relevés du suivi : l'enfant est connu
      const t = Date.now();
      process.kill(-first.child.pid!, 'SIGINT'); // ce que fait le terminal
      const end = await first.exited;
      expect(end - t).toBeLessThan(2_000 + 1_000); // la grâce, pas la fin de l'enfant
      expect(await cad(dir)).toBe(0); // seconde livraison : bumpe tout de suite
      await pause(3_500); // au-delà du réveil de l'enfant de la première
      expect(lines(join(logs, 'bumps'))).toEqual(['bumped']);
    } finally {
      first.cleanup();
    }
  }, 30_000);

  it('(b) Ctrl-C : le verrou reste tenu pendant la grâce, même après la sortie du script — une seconde livraison est refusée, un seul bump', async () => {
    const logs = tempDir();
    // le script sort après son trap (0,3 s) ; son enfant en arrière-plan (SIGINT ignoré) bumpe ~1 s après Ctrl-C, dans la grâce
    const dir = scriptRepo(
      logs,
      `  trap 'sleep 0.3; exit 130' INT\n  sh -c "sleep 1.4; echo bumped >> '${logs}/bumps'" &\n  while :; do wait; done`,
    );
    const first = startFirst(logs, dir);
    try {
      expect(await until(() => existsSync(join(logs, 'first')), 15_000)).toBe(true);
      await pause(400);
      const t = Date.now();
      process.kill(-first.child.pid!, 'SIGINT');
      await pause(Math.max(0, t + 600 - Date.now())); // le trap est fini, le script est sorti ; l'enfant vit encore
      const second = await cad(dir);
      expect(second).toBe(2); // verrou vivant : refusée
      await first.exited;
      await pause(1_500);
      expect(lines(join(logs, 'bumps'))).toEqual(['bumped']);
    } finally {
      first.cleanup();
    }
  }, 30_000);

  it('(c) Ctrl-C : un descendant qui ignore SIGINT sous un parent vivant est tué à l’échéance de la grâce (~2 s) — un seul bump', async () => {
    const logs = tempDir();
    // le script attend son enfant (trap posé : il ne meurt pas du signal) ; l'enfant ignore SIGINT et bumperait à 4 s
    const dir = scriptRepo(logs, `  trap 'echo int' INT\n  sh -c "trap '' INT; sleep 4; echo bumped >> '${logs}/bumps'"`);
    const first = startFirst(logs, dir);
    try {
      expect(await until(() => existsSync(join(logs, 'first')), 15_000)).toBe(true);
      await pause(400);
      const t = Date.now();
      process.kill(-first.child.pid!, 'SIGINT');
      const end = await first.exited;
      expect(end - t).toBeGreaterThanOrEqual(1_800); // la grâce entière
      expect(end - t).toBeLessThan(3_000); // mais pas la fin de l'enfant (4 s)
      expect(await cad(dir)).toBe(0);
      await pause(3_000);
      expect(lines(join(logs, 'bumps'))).toEqual(['bumped']);
    } finally {
      first.cleanup();
    }
  }, 30_000);
});
