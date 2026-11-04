import { describe, expect, it } from 'vitest';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { runLot } from '../src/orchestrate/cycle.js';
import { appendDelivery, sharedStateDir } from '../src/state.js';
import { claudeOut, commitFile, git, harness, reviewReport, workReport, type Handler } from './orchestrate-harness.js';
import { tempDir } from './helpers.js';

/**
 * Le commit gitops d'une livraison tolérée (L503) : `cadence deliver --sha` d'un lot prêt de la vague fait commiter le bump de tag par deploy.sh
 * dans le dépôt voisin, avec un message qui cite ce lot ; ce n'est pas un commit du lot en cours sur la branche principale d'un autre dépôt.
 */
function scenario(bump: (tier: string) => void, deliver: 'sha' | 'aucune' = 'sha') {
  const parent = tempDir();
  const tier = join(parent, 'gitops');
  mkdirSync(tier);
  git(tier, 'init', '-q', '-b', 'main');
  git(tier, 'config', 'user.email', 'test@example.com');
  git(tier, 'config', 'user.name', 'Test');
  git(tier, 'config', 'commit.gpgsign', 'false');
  commitFile(tier, 'README.md', 'init');
  const impl: Handler = (call) => {
    bump(tier);
    return claudeOut(workReport({ commits: [commitFile(call.opts.cwd, 'b.txt', 'feat(L2): b')] }));
  };
  const h = harness({ parent, lots: [{ title: 'Un', status: 'doing' }, { title: 'Deux', status: 'doing' }, { title: 'Trois', status: 'doing' }], script: { implement: [impl], review: [() => claudeOut(reviewReport())] } });
  const ready = commitFile(h.repo, 'a.txt', 'feat(L1): a').sha;
  h.store.writeLot(h.lot('L1', { status: 'ready' }).lot);
  h.store.writeLot(h.lot('L3', { status: 'implementing' }).lot);
  if (deliver !== 'aucune') appendDelivery(sharedStateDir(h.repo), '2026-10-04', ready);
  const logs: string[] = [];
  h.wave.log = (l: string) => logs.push(l);
  return { h, c: h.lot('L2'), logs, tier };
}

describe('commit gitops d\'une livraison tolérée (L503)', () => {
  it('R1 — un commit du dépôt voisin qui cite un lot prêt dont le sha est au journal des livraisons est toléré, avec une ligne au journal', async () => {
    const { c, logs, h } = scenario((t) => commitFile(t, 'chart.yaml', 'chore(deploy): bump demo L1 sha-abc1234'));
    await runLot(c);
    expect(c.lot.status).toBe('ready');
    expect(h.wave.dirtyRepos?.size ?? 0).toBe(0);
    expect(logs.some((l) => /commit de livraison \(demo:L1\) toléré dans gitops/.test(l))).toBe(true);
  });

  it('R2 — le lot prêt n\'est pas au journal des livraisons : le commit reste un incident', async () => {
    const { c } = scenario((t) => commitFile(t, 'chart.yaml', 'chore(deploy): bump demo L1'), 'aucune');
    await runLot(c);
    expect(c.lot.status).toBe('handed-back');
  });

  it('R3 — un commit qui cite aussi le lot en cours reste un incident', async () => {
    const { c } = scenario((t) => commitFile(t, 'chart.yaml', 'chore(deploy): bump L1 puis L2'));
    await runLot(c);
    expect(c.lot.status).toBe('handed-back');
  });

  it('R4 — un commit qui cite aussi un lot de la vague pas prêt reste un incident', async () => {
    const { c } = scenario((t) => commitFile(t, 'chart.yaml', 'chore(deploy): bump L1 et L3'));
    await runLot(c);
    expect(c.lot.status).toBe('handed-back');
  });

  it('R5 — un commit toléré puis un commit du lot en cours dans le même dépôt : incident, le constat ne nomme que le second', async () => {
    const { c, h } = scenario((t) => {
      commitFile(t, 'chart.yaml', 'chore(deploy): bump L1');
      commitFile(t, 'autre.yaml', 'feat(L2): a la main');
    });
    await runLot(c);
    expect(c.lot.status).toBe('handed-back');
    expect(h.wave.incident ?? '').not.toMatch(/bump L1/);
  });
});
