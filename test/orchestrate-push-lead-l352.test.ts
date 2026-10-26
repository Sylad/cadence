import { describe, expect, it } from 'vitest';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { runLot } from '../src/orchestrate/cycle.js';
import { remoteAdvances, snapshot, type Snapshot } from '../src/orchestrate/guard.js';
import { commit, gitRepo, tempDir } from './helpers.js';
import { claudeOut, commitFile, git, harness, reviewReport, workReport, type Handler } from './orchestrate-harness.js';

/**
 * Le push du lead pendant la vague (L352) : `git push origin <sha>:main` pour livrer un lot prêt (skill lead, « livrable jusqu'à »)
 * ne coupe pas le lot en cours ; tout autre push reste un incident.
 */
function scenario(push: (cwd: string, ready: string) => void, before: (repo: string, ready: string) => void = () => {}) {
  const impl: Handler = (call) => {
    push(call.opts.cwd, ready);
    const c = commitFile(call.opts.cwd, 'b.txt', 'feat(L2): b');
    return claudeOut(workReport({ commits: [c] }));
  };
  const h = harness({ lots: [{ title: 'Un', status: 'doing' }, { title: 'Deux', status: 'doing' }], script: { implement: [impl], review: [() => claudeOut(reviewReport())] } });
  const bare = join(h.launch, 'origin.git');
  git(h.launch, 'init', '-q', '--bare', '-b', 'main', bare);
  git(h.repo, 'remote', 'add', 'origin', bare);
  git(h.repo, 'push', '-q', '-u', 'origin', 'main');
  // L1 est prêt : son commit est dans l'histoire, la session du lot L2 tourne par-dessus
  const ready = commitFile(h.repo, 'a.txt', 'feat(L1): a').sha;
  before(h.repo, ready);
  const done = h.lot('L1', { status: 'ready' });
  h.store.writeLot(done.lot);
  const logs: string[] = [];
  h.wave.log = (l: string) => logs.push(l);
  return { h, c: h.lot('L2'), logs, bare };
}

describe('push du lead pendant la vague (L352)', () => {
  it('R1 — un push du sha d\'un lot prêt, ancêtre de HEAD, ne coupe pas le lot et le journal le dit', async () => {
    const { h, c, logs } = scenario((cwd, ready) => git(cwd, 'push', '-q', 'origin', `${ready}:main`));
    await runLot(c);
    expect(h.wave.incident).toBeNull();
    expect(c.lot.status).not.toBe('failed');
    expect(logs.some((l) => /push du lead \(livraison de demo:L1\) toléré/.test(l))).toBe(true);
  });

  it('R2 — un push dont l\'histoire contient un commit d\'un lot pas prêt reste un incident', async () => {
    const { h, c } = scenario((cwd) => {
      commitFile(cwd, 'c.txt', 'feat(L2): avance');
      git(cwd, 'push', '-q', 'origin', 'HEAD:main');
    });
    await runLot(c);
    expect(c.lot.status).toBe('failed');
    expect(h.wave.incident).toMatch(/push détecté/);
  });

  it('R3 — un push d\'un sha qui n\'est pas un ancêtre de HEAD reste un incident', async () => {
    const { h, c } = scenario((cwd) => {
      const orphan = git(cwd, 'commit-tree', 'HEAD^{tree}', '-p', 'HEAD', '-m', 'chore: ailleurs');
      git(cwd, 'push', '-q', 'origin', `${orphan}:main`);
    });
    await runLot(c);
    expect(c.lot.status).toBe('failed');
    expect(h.wave.incident).toMatch(/push détecté/);
  });

  it('R4 — un push qui supprime une branche distante reste un incident', async () => {
    const { h, c } = scenario(
      (cwd) => git(cwd, 'push', '-q', 'origin', ':refs/heads/autre'),
      (repo, ready) => git(repo, 'push', '-q', 'origin', `${ready}:refs/heads/autre`),
    );
    await runLot(c);
    expect(c.lot.status).toBe('failed');
    expect(h.wave.incident).toMatch(/push détecté/);
  });

  it('R5 — un push qui ne contient que des commits du plan est toléré (livraison du plan)', async () => {
    const { h, c, logs } = scenario(
      (cwd) => git(cwd, 'push', '-q', 'origin', 'HEAD:main'),
      (repo, ready) => {
        git(repo, 'push', '-q', 'origin', `${ready}:main`);
        planCommit(repo);
      },
    );
    await runLot(c);
    expect(h.wave.incident).toBeNull();
    expect(logs.some((l) => /push du lead \(livraison du plan\) toléré/.test(l))).toBe(true);
  });

  it('R6 — un push forcé qui rembobine main vers un ancêtre de HEAD reste un incident', async () => {
    const { h, c } = scenario(
      (cwd, ready) => git(cwd, 'push', '-q', '-f', 'origin', `${ready}~1:main`),
      (repo, ready) => git(repo, 'push', '-q', 'origin', `${ready}:main`),
    );
    await runLot(c);
    expect(c.lot.status).toBe('failed');
    expect(h.wave.incident).toMatch(/push détecté/);
  });

  it('R7 — un push quand un lot de la vague est illisible dans le plan reste un incident', async () => {
    const { h, c } = scenario((cwd, ready) => git(cwd, 'push', '-q', 'origin', `${ready}:main`));
    // un lot de la vague que le plan ne connaît pas : ses commits ne peuvent pas être lus
    h.store.writeLot({ ...h.lot('L1').lot, lot: 'L9', status: 'doing' });
    await runLot(c);
    expect(c.lot.status).toBe('failed');
    expect(h.wave.incident).toMatch(/push détecté/);
  });

  it('R8 — un commit qui ne cite aucun lot passe : la garde ne vise que les lots de la vague pas prêts', async () => {
    const { h, c, logs } = scenario(
      (cwd) => git(cwd, 'push', '-q', 'origin', 'HEAD:main'),
      (repo, ready) => {
        git(repo, 'push', '-q', 'origin', `${ready}:main`);
        commitFile(repo, 'sans-lot.txt', 'chore: sans lot');
      },
    );
    await runLot(c);
    expect(h.wave.incident).toBeNull();
    expect(logs.some((l) => /push du lead \(livraison du plan\) toléré/.test(l))).toBe(true);
  });
});

/** Un commit qui ne touche que le plan. */
function planCommit(repo: string) {
  writeFileSync(join(repo, '.cadence/raf.yaml'), `${readFileSync(join(repo, '.cadence/raf.yaml'), 'utf8')}# note\n`);
  git(repo, 'add', '--', '.cadence/raf.yaml');
  git(repo, 'commit', '-q', '-m', 'plan: note', '--', '.cadence/raf.yaml');
}

describe('remoteAdvances (L352)', () => {
  const snap = (remote: string | null): Snapshot => ({ head: null, tracked: [], untracked: [], upstream: null, upstreamRef: null, branch: null, reflog: 0, remote, guard: false });
  const a = 'a'.repeat(40);
  const b = 'b'.repeat(40);

  it('une branche qui avance, une branche créée : listées', () => {
    expect(remoteAdvances(snap(`${a}\trefs/heads/main`), snap(`${b}\trefs/heads/main\n${b}\trefs/heads/x`))).toEqual([
      { ref: 'refs/heads/main', from: a, to: b },
      { ref: 'refs/heads/x', from: null, to: b },
    ]);
  });

  it('une branche supprimée ou un distant illisible : null', () => {
    expect(remoteAdvances(snap(`${a}\trefs/heads/main\n${a}\trefs/heads/x`), snap(`${a}\trefs/heads/main`))).toBeNull();
    expect(remoteAdvances(snap(null), snap(`${a}\trefs/heads/main`))).toBeNull();
  });

  it('rien n\'a bougé sur le distant : null', () => {
    expect(remoteAdvances(snap(`${a}\trefs/heads/main`), snap(`${a}\trefs/heads/main`))).toBeNull();
  });
});

describe('snapshot réel', () => {
  it('remoteAdvances lit un vrai ls-remote', async () => {
    const dir = gitRepo();
    commit(dir, 'chore: init');
    git(dir, 'branch', '-M', 'main');
    const bare = join(tempDir(), 'o.git');
    git(dir, 'init', '-q', '--bare', '-b', 'main', bare);
    git(dir, 'remote', 'add', 'origin', bare);
    git(dir, 'push', '-q', '-u', 'origin', 'main');
    const before = await snapshot(dir);
    commit(dir, 'feat(L1): x');
    git(dir, 'push', '-q');
    const adv = remoteAdvances(before, await snapshot(dir));
    expect(adv).toHaveLength(1);
    expect(adv![0]).toMatchObject({ ref: 'refs/heads/main', to: git(dir, 'rev-parse', 'HEAD') });
  });
});
