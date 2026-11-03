import { afterEach, describe, expect, it } from 'vitest';
import { run } from '../src/cli.js';
import { planOnlySince } from '../src/deliver-ci.js';
import { parseDeliverConfig } from '../src/deliver.js';
import { Plan } from '../src/plan.js';
import { appendFailedDelivery, lastDelivery, readDeliveryLines } from '../src/state.js';
import { verifyCommand } from '../src/verify.js';
import { DAY, edit, fx, go, head, planOf, sh, ship } from './l469-fixture.js';
import { cleanupTempDirs } from './helpers.js';

afterEach(cleanupTempDirs);

const closed = (...ids: string[]) => (p: Plan) => ids.forEach((id) => p.setStatus(id, 'done', '2026-10-05'));
const delivered = (f: ReturnType<typeof fx>) => ['L1', 'L2', 'L3'].filter((id) => planOf(f).lot(id).delivered);
async function started() {
  const f = fx({ blocks: true });
  expect(await go(f)).toBe(0);
  f.out.length = 0;
  return f;
}

describe('C3 — livrer un bloc', () => {
  it('R17 — commit touchant le bloc : lot marqué', async () => {
    const f = await started();
    ship(f, ['src/api/a.ts'], 'feat(L1): a');
    edit(f, closed('L1'));
    expect(await go(f, { block: 'api' })).toBe(0);
    expect(delivered(f)).toEqual(['L1']);
  });
  it('R17 — commit hors du bloc : lot non marqué', async () => {
    const f = await started();
    ship(f, ['docs/a.md'], 'feat(L1): a');
    edit(f, closed('L1'));
    await go(f, { block: 'api' });
    expect(delivered(f)).toEqual([]);
  });
  it('R17 — lot ne touchant que web, livraison --block api : non marqué', async () => {
    const f = await started();
    ship(f, ['src/api/a.ts'], 'feat(L1): a');
    ship(f, ['src/web/w.ts'], 'feat(L2): w');
    edit(f, closed('L1', 'L2'));
    await go(f, { block: 'api' });
    expect(delivered(f)).toEqual(['L1']);
  });
  it('R18 — src/api2/x.ts n\'appartient pas au bloc src/api', async () => {
    const f = await started();
    ship(f, ['src/api2/x.ts'], 'feat(L1): a');
    edit(f, closed('L1'));
    await go(f, { block: 'api' });
    expect(delivered(f)).toEqual([]);
  });
  it('R18 — commit sur deux blocs : lot retenu par chacun', async () => {
    const f = await started();
    ship(f, ['src/api/a.ts', 'src/web/w.ts'], 'feat(L1): a');
    edit(f, closed('L1'));
    await go(f, { block: 'web' });
    expect(delivered(f)).toEqual(['L1']);
  });
  it('R19 — lot done ancien touchant le bloc, absent de la plage : non marqué', async () => {
    const f = fx({ blocks: true });
    ship(f, ['src/api/old.ts'], 'feat(L3): ancien');
    edit(f, closed('L3'));
    await go(f); // première livraison : ligne S0, rien de marqué
    ship(f, ['src/api/a.ts'], 'feat(L1): a');
    edit(f, closed('L1'));
    await go(f, { block: 'api' });
    expect(delivered(f)).toEqual(['L1']);
  });
  it('R19 — plan de lots done sans delivered, première utilisation de --block : seuls les lots cités par la plage sont marqués', async () => {
    const f = fx({ blocks: true, prelude: (p) => { for (let i = 0; i < 29; i++) p.add(`Ancien ${i}`, '2026-10-01'); p.save(); } });
    for (let i = 4; i <= 32; i++) ship(f, ['src/api/old.ts'], `feat(L${i}): ancien ${i}`);
    edit(f, (p) => { for (let i = 4; i <= 32; i++) { p.setStatus(`L${i}`, 'doing', DAY); p.setStatus(`L${i}`, 'done', DAY); } });
    await go(f); // S0
    ship(f, ['src/api/a.ts'], 'feat(L1): a');
    edit(f, closed('L1'));
    await go(f, { block: 'api' });
    expect(delivered(f)).toEqual(['L1']);
    expect(planOf(f).lots().filter((l) => l.delivered)).toHaveLength(1);
  });
  it('R21 — blocs déclarés, sans --block : tous les lots de la plage marqués', async () => {
    const f = await started();
    ship(f, ['src/api/a.ts'], 'feat(L1): a');
    ship(f, ['docs/b.md'], 'feat(L2): b');
    edit(f, closed('L1', 'L2'));
    await go(f);
    expect(delivered(f)).toEqual(['L1', 'L2']);
  });
});

describe('R20 — refus du bloc', () => {
  const cli = (f: ReturnType<typeof fx>, ...argv: string[]) => {
    const out: string[] = [];
    const code = run(['deliver', ...argv], { cwd: f.dir, env: { RAF_TODAY: DAY }, out: (l) => out.push(l), err: (l) => out.push(l), now: () => new Date(`${DAY}T10:00:00`) });
    return Promise.resolve(code).then((c) => ({ code: c, out }));
  };
  it('R20 — bloc inconnu : refus, deliveries.log inchangé', async () => {
    const f = fx({ blocks: true });
    const r = await cli(f, '--block', 'worker');
    expect(r.code).toBe(1);
    expect(r.out).toContain('deliver : --block worker : bloc inconnu (déclarés : api, web)');
    expect(lastDelivery(f.state)).toBeNull();
  });
  it('R20 — aucun bloc déclaré : refus', async () => {
    const f = fx();
    const r = await cli(f, '--block', 'api');
    expect(r.code).toBe(1);
    expect(r.out).toContain('deliver : --block api : aucun bloc déclaré (deliver.blocks dans cadence.yaml)');
    expect(lastDelivery(f.state)).toBeNull();
  });
  it('R20 — --block vide : refus', async () => {
    const f = fx({ blocks: true });
    expect((await cli(f, '--block', '')).code).toBe(1);
    expect(lastDelivery(f.state)).toBeNull();
  });
  it('R20 — --block nomme un bloc déclaré : la livraison se joue et écrit « jour sha api »', async () => {
    const f = fx({ blocks: true });
    expect((await cli(f, '--block', 'api')).code).toBe(0);
    expect(readDeliveryLines(f.state)).toEqual([{ day: DAY, sha: sh(f.dir, 'rev-parse', 'HEAD'), block: 'api' }]);
  });
});

describe('R22 — deux blocs sur le même sha', () => {
  it('R22 — --block api puis --block web sur le même sha : chaque bloc marque ses lots', async () => {
    const f = await started();
    ship(f, ['src/api/a.ts'], 'feat(L1): a');
    ship(f, ['src/web/w.ts'], 'feat(L2): w');
    edit(f, closed('L1', 'L2'));
    await go(f, { block: 'api' });
    expect(delivered(f)).toEqual(['L1']);
    sh(f.dir, 'push', '-q');
    await go(f, { block: 'web' });
    expect(delivered(f)).toEqual(['L1', 'L2']);
  });
});

describe('R33 — livraison complète après un bloc', () => {
  it('R33 — « j S1 api » puis livraison complète à S2 : le lot web antérieur à S1 est marqué', async () => {
    const f = await started();
    ship(f, ['src/web/w.ts'], 'feat(L2): w');
    ship(f, ['src/api/a.ts'], 'feat(L1): a');
    edit(f, closed('L1', 'L2'));
    await go(f, { block: 'api' });
    expect(delivered(f)).toEqual(['L1']);
    sh(f.dir, 'push', '-q');
    await go(f);
    expect(delivered(f)).toEqual(['L1', 'L2']);
  });
  it('R33 — lot api déjà marqué par --block api : non relivré par la livraison complète', async () => {
    const f = await started();
    ship(f, ['src/api/a.ts'], 'feat(L1): a');
    edit(f, closed('L1'));
    await go(f, { block: 'api' });
    const first = planOf(f).lot('L1').delivered;
    sh(f.dir, 'push', '-q');
    await go(f);
    expect(planOf(f).lot('L1').delivered).toEqual(first);
  });
  it('R33 — journal sans ligne de bloc : plage depuis la dernière ligne, comme avant', async () => {
    const f = await started();
    ship(f, ['src/api/a.ts'], 'feat(L1): a');
    edit(f, closed('L1'));
    await go(f);
    expect(delivered(f)).toEqual(['L1']);
  });
});

describe('R34 — les lecteurs de la ligne précédente suivent le bloc', () => {
  it('R34 — garde deliver.ts:384 : --block web après --block api nomme les lots non livrés depuis la ligne valant pour web', async () => {
    const f = fx({ blocks: true });
    await go(f); // S0
    ship(f, ['src/web/w.ts'], 'feat(L2): w'); // non terminé, non relu
    await go(f, { block: 'api' });
    sh(f.dir, 'push', '-q');
    ship(f, ['src/api/b.ts'], 'feat(L3): b');
    f.err.length = 0;
    const config = parseDeliverConfig(f.yaml, 'cadence.yaml');
    // livraison d'un sha choisi (hors vague) : la garde part de la ligne valant pour web (S0), donc nomme L2 ; pour api elle partirait de S1
    const { deliver } = await import('../src/deliver.js');
    const { noDeps } = await import('./l469-fixture.js');
    const ctx = (block: string) => ({ root: f.dir, state: f.state, plan: planOf(f), config, today: DAY, dryRun: false, args: [] as string[], sha: head(f), block, out: (l: string) => f.out.push(l), err: (l: string) => f.err.push(l) });
    expect(await deliver(ctx('web'), noDeps())).toBe(2);
    expect(f.err.join('\n')).toContain('L2 (en cours, non relu)');
    f.err.length = 0;
    expect(await deliver(ctx('api'), noDeps())).toBe(2);
    expect(f.err.join('\n')).not.toContain('L2 (');
  });
  it('R34 — planOnlySince --block web après --block api : part de la ligne valant pour web, la CI n\'est pas sautée si un commit non plan seul s\'y trouve', async () => {
    const f = fx({ blocks: true });
    await go(f); // S0
    ship(f, ['src/web/w.ts'], 'feat(L2): w');
    await go(f, { block: 'api' }); // S1 api
    const config = parseDeliverConfig(f.yaml, 'cadence.yaml');
    const ctx = (block?: string) => ({ root: f.dir, state: f.state, plan: planOf(f), config, today: DAY, dryRun: false, args: [] as string[], ...(block ? { block } : {}), out: () => {}, err: () => {} });
    edit(f, closed('L1'), true); // un commit « plan seul » au-dessus de S1
    expect(planOnlySince(ctx('api'), head(f))).not.toBeNull();
    expect(planOnlySince(ctx('web'), head(f))).toBeNull();
  });
  it('R34 — planOnlySince sans bloc : plus ancienne des dernières lignes (R33)', async () => {
    const f = fx({ blocks: true });
    await go(f);
    ship(f, ['src/web/w.ts'], 'feat(L2): w');
    await go(f, { block: 'api' });
    edit(f, closed('L1'));
    const config = parseDeliverConfig(f.yaml, 'cadence.yaml');
    const base = { root: f.dir, state: f.state, plan: planOf(f), config, today: DAY, dryRun: false, args: [] as string[], out: () => {}, err: () => {} };
    expect(planOnlySince(base, head(f))).toBeNull();
  });
  it('R34 — prev de l\'annonce et deliveredIds suivent la même ligne', async () => {
    const f = await started();
    ship(f, ['src/web/w.ts'], 'feat(L2): w');
    ship(f, ['src/api/a.ts'], 'feat(L1): a');
    edit(f, closed('L1', 'L2'));
    await go(f, { block: 'api' });
    f.out.length = 0;
    sh(f.dir, 'push', '-q');
    await go(f, { block: 'web' });
    // web part de S0 (ligne valant pour lui) : L2, antérieur à la ligne api, est annoncé et marqué ; L1 (api) n'est pas du bloc
    expect(f.out).toContain('livré : L2 — raf done si l\'effet est celui attendu');
    expect(f.out.some((l) => l.startsWith('lots marqués livrés : L2'))).toBe(true);
  });
  it('R34 — journal sans bloc : les appelants rendent le même sha qu\'avant (annonce depuis la dernière ligne)', async () => {
    const f = fx();
    await go(f);
    ship(f, ['src/a.ts'], 'feat(L1): a');
    f.out.length = 0;
    await go(f);
    expect(f.out).toContain('livré : L1 — raf done si l\'effet est celui attendu');
  });
});

describe('R13 — cadence verify vert marque comme deliver', () => {
  it('R13 — cadence verify vert : lots done cités marqués livrés ; R30 — ligne écrite sans bloc', async () => {
    const f = fx({ blocks: true });
    await go(f); // S0
    ship(f, ['src/api/a.ts'], 'feat(L1): a');
    edit(f, closed('L1'));
    const sha = head(f);
    appendFailedDelivery(f.state, DAY, sha, 'vérification en échec', 'verification');
    const config = parseDeliverConfig(f.yaml, 'cadence.yaml');
    const out: string[] = [];
    const effects = () => ({ root: f.dir, plan: planOf(f), today: DAY, blocks: config.blocks, out: (l: string) => out.push(l), err: (l: string) => out.push(l) });
    const deps = { exec: async () => 0, fetch: async () => ({ status: 200, text: '' }), sleep: async () => {}, now: () => 0 };
    expect(await verifyCommand({ config, sha, retry: 0, out: (l) => out.push(l), journal: { dir: f.state, day: DAY, effects } }, deps)).toBe(0);
    expect(planOf(f).lot('L1').delivered).toEqual({ date: DAY, sha });
    expect(out.some((l) => l.startsWith('lots marqués livrés : L1'))).toBe(true);
    expect(lastDelivery(f.state)).toBe(sha);
    expect(sh(f.dir, 'status', '--porcelain')).toBe('');
  });
  it('R34 — prev de cadence verify : sans bloc, la plus ancienne des dernières lignes (lot web antérieur à une ligne api marqué)', async () => {
    const f = fx({ blocks: true });
    await go(f); // S0
    ship(f, ['src/web/w.ts'], 'feat(L2): w');
    ship(f, ['src/api/a.ts'], 'feat(L1): a');
    edit(f, closed('L1', 'L2'));
    await go(f, { block: 'api' }); // S1 api : marque L1 seul
    expect(delivered(f)).toEqual(['L1']);
    sh(f.dir, 'push', '-q');
    const sha = head(f);
    appendFailedDelivery(f.state, DAY, sha, 'vérification en échec', 'verification');
    const config = parseDeliverConfig(f.yaml, 'cadence.yaml');
    const out: string[] = [];
    const effects = () => ({ root: f.dir, plan: planOf(f), today: DAY, out: (l: string) => out.push(l), err: (l: string) => out.push(l) });
    const deps = { exec: async () => 0, fetch: async () => ({ status: 200, text: '' }), sleep: async () => {}, now: () => 0 };
    await verifyCommand({ config, sha, retry: 0, out: (l) => out.push(l), journal: { dir: f.state, day: DAY, effects } }, deps);
    expect(delivered(f)).toEqual(['L1', 'L2']);
  });
});
