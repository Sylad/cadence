import { describe, expect, it } from 'vitest';
import { readFileSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { run } from '../src/cli.js';
import { Plan } from '../src/plan.js';
import { needsPrecheck, precheckNothingToFind } from '../src/orchestrate/cycle.js';
import { commitFile, harness } from './orchestrate-harness.js';
import { gitRepo } from './helpers.js';

const root = new URL('..', import.meta.url).pathname;

/** L1 done avec un commit de code, L2 « suite de L1 » créé après : L1 part ensuite à l'archive. */
function suiteApresArchive() {
  const h = harness({ lots: [{ title: 'un' }, { title: 'suite de L1' }] });
  const file = join(h.repo, '.cadence/raf.yaml');
  writeFileSync(file, readFileSync(file, 'utf8').replace(/created: \d{4}-\d{2}-\d{2}/g, 'created: 2099-01-01'));
  execFileSync('git', ['commit', '-q', '--amend', '--no-edit', '--date', '2099-01-01T12:00:00Z', '--', '.cadence/raf.yaml'], { cwd: h.repo, env: { ...process.env, GIT_COMMITTER_DATE: '2099-01-01T12:00:00Z' } });
  commitFile(h.repo, 'a.txt', 'fix(L1): une correction');
  const plan = h.plan();
  plan.setStatus('L1', 'done', '2026-10-01', { force: true });
  plan.save();
  return h;
}

describe('L396 — corrections de revue', () => {
  it('R14 — le précheck voit les lots archivés : une suite de L1 archivé garde la garde L292/L322', () => {
    const h = suiteApresArchive();
    expect(needsPrecheck({ precheck: true }, h.plan(), h.repo, 'L2')).toBe(true);
    expect(precheckNothingToFind(h.plan(), h.repo, 'L2')).toBeNull();
    h.plan().archive('2026-10-28');
    expect(h.plan().lots().map((l) => l.id)).toEqual(['L2']);
    expect(needsPrecheck({ precheck: true }, h.plan(), h.repo, 'L2')).toBe(true);
    expect(precheckNothingToFind(h.plan(), h.repo, 'L2')).toBeNull();
  });

  it("R15 — les briefs d'implémentation, de fiche et de revue interdisent de lire l'archive", () => {
    for (const f of ['templates/orchestrate/implement.md', 'templates/orchestrate/spec.md', 'templates/orchestrate/spec-back.md', 'agents/code-reviewer.md']) {
      expect(readFileSync(join(root, f), 'utf8'), f).toMatch(/never read `\.cadence\/archive\//);
    }
  });

  it("R16 — raf archive prévient quand plan.onWrite republie le plan : l'historique publié doit lire l'archive", async () => {
    const dir = gitRepo();
    const lines: string[] = [];
    const errs: string[] = [];
    const plan = Plan.create(join(dir, '.cadence/raf.yaml'), 'demo', 'L', '2025-01-01');
    plan.add('un', '2025-01-01');
    plan.setStatus('L1', 'done', '2025-06-10', { force: true });
    plan.save();
    writeFileSync(join(dir, 'cadence.yaml'), "plan:\n  path: .cadence/raf.yaml\n  onWrite:\n    command: 'cp .cadence/raf.yaml publie.yaml'\n    files: [publie.yaml]\n");
    const io = { cwd: dir, env: { RAF_TODAY: '2026-10-28' }, out: (l: string) => lines.push(l), err: (l: string) => errs.push(l), now: () => new Date('2026-10-28T10:00:00') };
    expect(await run(['archive'], io)).toBe(0);
    expect(errs.join('\n')).toMatch(/plan\.onWrite.*\.cadence\/archive\/\*\.yaml/);
    errs.length = 0;
    expect(await run(['archive'], io)).toBe(0); // rien à archiver : pas d'avertissement
    expect(errs.join('\n')).toBe('');
  });
});
