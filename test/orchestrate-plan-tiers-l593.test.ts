import { describe, expect, it } from 'vitest';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { runLot } from '../src/orchestrate/cycle.js';
import { claudeOut, commitFile, git, harness, reviewReport, workReport, type Handler } from './orchestrate-harness.js';
import { tempDir } from './helpers.js';

/**
 * Le commit de plan du lead dans un dépôt voisin (L593) : `raf.py` y commite lui-même le plan, avec un sujet qui cite un lot de la vague ;
 * un commit qui ne touche que les fichiers du plan de CE dépôt (plan.path, plan.files de son cadence.yaml) n'est pas un incident.
 */
function scenario(bump: (tier: string) => void, config = 'plan:\n  path: plan/raf.yaml\n  files: [plan/extra.md]\n') {
  const parent = tempDir();
  const tier = join(parent, 'voisin');
  mkdirSync(join(tier, 'plan'), { recursive: true });
  git(tier, 'init', '-q', '-b', 'main');
  git(tier, 'config', 'user.email', 'test@example.com');
  git(tier, 'config', 'user.name', 'Test');
  git(tier, 'config', 'commit.gpgsign', 'false');
  writeFileSync(join(tier, 'cadence.yaml'), config);
  writeFileSync(join(tier, 'plan/raf.yaml'), 'project: voisin\nlots: []\n');
  git(tier, 'add', '-A');
  git(tier, 'commit', '-q', '-m', 'init');
  const impl: Handler = (call) => {
    bump(tier);
    return claudeOut(workReport({ commits: [commitFile(call.opts.cwd, 'b.txt', 'feat(L1): b')] }));
  };
  const h = harness({ parent, lots: [{ title: 'Un', status: 'doing' }], script: { implement: [impl], review: [() => claudeOut(reviewReport())] } });
  const logs: string[] = [];
  h.wave.log = (l: string) => logs.push(l);
  return { h, c: h.lot('L1'), logs };
}

describe('commit de plan dans un dépôt voisin (L593)', () => {
  it('R1 — un commit qui ne touche que plan.path, citant un lot de la vague, est toléré, avec une ligne au journal', async () => {
    const { c, logs, h } = scenario((t) => commitFile(t, 'plan/raf.yaml', 'plan: add L1 suite'));
    await runLot(c);
    expect(c.lot.status).toBe('ready');
    expect(h.wave.dirtyRepos?.size ?? 0).toBe(0);
    expect(logs.some((l) => /commit de plan toléré dans voisin : .*plan: add L1 suite/.test(l))).toBe(true);
  });

  it('R2 — un commit qui ne touche que plan.files est toléré', async () => {
    const { c } = scenario((t) => commitFile(t, 'plan/extra.md', 'plan: note L1'));
    await runLot(c);
    expect(c.lot.status).toBe('ready');
  });

  it('R3 — un commit qui touche le plan et un autre fichier reste un incident', async () => {
    const { c } = scenario((t) => {
      writeFileSync(join(t, 'plan/raf.yaml'), 'x: 1\n');
      writeFileSync(join(t, 'code.ts'), 'x\n');
      git(t, 'add', '--', 'plan/raf.yaml', 'code.ts');
      git(t, 'commit', '-q', '-m', 'plan: add L1 et code', '--', 'plan/raf.yaml', 'code.ts');
    });
    await runLot(c);
    expect(c.lot.status).toBe('handed-back');
  });

  it('R4 — un commit citant le lot qui ne touche qu\'un fichier hors plan reste un incident', async () => {
    const { c } = scenario((t) => commitFile(t, 'code.ts', 'plan: add L1'));
    await runLot(c);
    expect(c.lot.status).toBe('handed-back');
  });

  it('R5 — le dépôt voisin sans cadence.yaml : le plan par défaut (.cadence/raf.yaml) est celui du dépôt', async () => {
    const { c } = scenario((t) => {
      mkdirSync(join(t, '.cadence'), { recursive: true });
      commitFile(t, '.cadence/raf.yaml', 'plan: add L1');
    }, '# rien\n');
    await runLot(c);
    expect(c.lot.status).toBe('ready');
  });

  it('R6 — un cadence.yaml illisible : rien n\'est toléré, le commit reste un incident', async () => {
    const { c } = scenario((t) => commitFile(t, 'plan/raf.yaml', 'plan: add L1'), 'plan: [pas, un, objet\n');
    await runLot(c);
    expect(c.lot.status).toBe('handed-back');
  });
});
