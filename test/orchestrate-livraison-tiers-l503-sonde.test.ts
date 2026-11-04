import { describe, expect, it } from 'vitest';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { runLot } from '../src/orchestrate/cycle.js';
import { tierMoved, type TierRead } from '../src/orchestrate/tiers.js';
import { appendDelivery, sharedStateDir } from '../src/state.js';
import { claudeOut, commitFile, git, harness, reviewReport, workReport, type Handler } from './orchestrate-harness.js';
import { tempDir } from './helpers.js';

/** Sonde L503 : les bords de la tolérance du commit de livraison (tierMoved et ligne de journal). */
function gitopsRepo() {
  const tier = join(tempDir(), 'gitops');
  mkdirSync(tier);
  git(tier, 'init', '-q', '-b', 'main');
  git(tier, 'config', 'user.email', 'test@example.com');
  git(tier, 'config', 'user.name', 'Test');
  git(tier, 'config', 'commit.gpgsign', 'false');
  commitFile(tier, 'README.md', 'init');
  return tier;
}
const head = (r: string) => git(r, 'rev-parse', 'HEAD').trim();
const read = (sha: string): TierRead => ({ branch: 'main', mains: { main: sha } });

describe('sonde L503 — tierMoved, bords', () => {
  it('delivered absent : le comportement L458 est inchangé (commit citant un lot = constat)', () => {
    const t = gitopsRepo();
    const b = head(t);
    commitFile(t, 'x', 'chore: bump L1');
    expect(tierMoved(t, read(b), read(head(t)), { lots: ['L1'] })).not.toBeNull();
  });

  it('delivered vide : rien n\'est toléré, onDelivered n\'est jamais appelé', () => {
    const t = gitopsRepo();
    const b = head(t);
    commitFile(t, 'x', 'chore: bump L1');
    const seen: string[] = [];
    expect(tierMoved(t, read(b), read(head(t)), { lots: ['L1'], delivered: [], onDelivered: (l) => seen.push(l) })).not.toBeNull();
    expect(seen).toEqual([]);
  });

  it('« L1 » livré ne tolère pas un commit qui cite « L10 » (préfixe)', () => {
    const t = gitopsRepo();
    const b = head(t);
    commitFile(t, 'x', 'chore: bump L10');
    expect(tierMoved(t, read(b), read(head(t)), { lots: ['L1', 'L10'], delivered: ['L1'] })).not.toBeNull();
  });

  it('un commit qui cite un lot livré et un identifiant hors vague est toléré (seuls les lots de la vague comptent)', () => {
    const t = gitopsRepo();
    const b = head(t);
    commitFile(t, 'x', 'chore: bump L1 (L999 ailleurs)');
    expect(tierMoved(t, read(b), read(head(t)), { lots: ['L1'], delivered: ['L1'] })).toBeNull();
  });

  it('une branche principale créée (a, pas de b) portant seulement un commit de livraison : toléré, ni « branche créée » ni constat', () => {
    const t = gitopsRepo();
    const base = head(t);
    git(t, 'checkout', '-q', '-b', 'master');
    commitFile(t, 'x', 'chore: bump L1');
    const seen: string[] = [];
    const r = tierMoved(t, { branch: 'main', mains: { main: base } }, { branch: 'master', mains: { main: base, master: head(t) } }, { lots: ['L1'], delivered: ['L1'], onDelivered: (l) => seen.push(l) });
    expect(r).toBeNull();
    expect(seen).toHaveLength(1);
  });

  it('deux commits de livraison puis un commit du lot en cours : seul le dernier est nommé', () => {
    const t = gitopsRepo();
    const b = head(t);
    commitFile(t, 'x', 'chore: bump L1');
    commitFile(t, 'y', 'chore: bump L1 encore');
    commitFile(t, 'z', 'feat(L2): main');
    const r = tierMoved(t, read(b), read(head(t)), { lots: ['L1', 'L2'], delivered: ['L1'] });
    expect(r?.detail).toMatch(/feat\(L2\)/);
    expect(r?.detail).not.toMatch(/bump L1/);
  });
});

describe('sonde L503 — ligne de journal', () => {
  function scenario(subject: string) {
    const tier = gitopsRepo();
    const parent = join(tier, '..');
    const impl: Handler = (call) => {
      commitFile(tier, 'chart.yaml', subject);
      return claudeOut(workReport({ commits: [commitFile(call.opts.cwd, 'b.txt', 'feat(L2): b')] }));
    };
    const h = harness({ parent, lots: [{ title: 'Un', status: 'doing' }, { title: 'Deux', status: 'doing' }, { title: 'Trois', status: 'doing' }, { title: 'Quatre', status: 'doing' }], script: { implement: [impl], review: [() => claudeOut(reviewReport())] } });
    commitFile(h.repo, 'a.txt', 'feat(L1): a');
    const ready = commitFile(h.repo, 'a4.txt', 'feat(L4): a4').sha;
    h.store.writeLot(h.lot('L1', { status: 'ready' }).lot);
    h.store.writeLot(h.lot('L4', { status: 'ready' }).lot);
    appendDelivery(sharedStateDir(h.repo), '2026-10-04', ready);
    const logs: string[] = [];
    h.wave.log = (l: string) => logs.push(l);
    return { c: h.lot('L2'), logs };
  }

  it('deux lots prêts livrés, le commit n\'en cite qu\'un : la ligne de journal ne nomme que celui-là', async () => {
    const { c, logs } = scenario('chore(deploy): bump demo L1');
    await runLot(c);
    expect(c.lot.status).toBe('ready');
    const line = logs.find((l) => /commit de livraison/.test(l)) ?? '';
    expect(line).toMatch(/demo:L1/);
    expect(line).not.toMatch(/L4/);
  });

  it('commit qui cite un lot prêt livré : la ligne reprend le sha court et le sujet', async () => {
    const { c, logs } = scenario('chore(deploy): bump demo L1');
    await runLot(c);
    const line = logs.find((l) => /commit de livraison/.test(l)) ?? '';
    expect(line).toMatch(/[0-9a-f]{7} chore\(deploy\): bump demo L1/);
  });
});
