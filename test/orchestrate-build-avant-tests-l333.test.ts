import { describe, expect, it } from 'vitest';
import { runLot } from '../src/orchestrate/cycle.js';
import { claudeOut, commitFile, harness, reviewReport, workReport, type Handler } from './orchestrate-harness.js';

const impl = (): Handler => (call) => claudeOut(workReport({ commits: [commitFile(call.opts.cwd, 'a.txt', 'feat(L1): a')] }));
const fix = (file: string): Handler => (call) => claudeOut(workReport({ commits: [commitFile(call.opts.cwd, file, `fix(L1): ${file}`)] }));
const ok: Handler = () => claudeOut(reviewReport());
const kinds = (h: ReturnType<typeof harness>) => h.calls.map((c) => c.kind);
const BUILD = 'mkdir -p dist && echo x > dist/built';

describe('la porte joue le build avant les tests (L333)', () => {
  it('R1 — les tests qui lisent le dist du build passent : le build est joué en premier, une seule fois', async () => {
    const h = harness({ script: { implement: [impl()], review: [ok] } });
    const c = h.lot('L1', {}, { test: 'test -f dist/built', build: BUILD });
    await runLot(c);
    expect(kinds(h)).toEqual(['implement', 'review']);
    expect(c.lot.checks!.runs.map((r) => [r.label, r.code])).toEqual([['build', 0], ['tests', 0]]);
  });

  it('R2 — un build rouge rend le lot sans lancer les tests : un seul constat, « build »', async () => {
    const h = harness({ script: { implement: [impl()], fix: [fix('b.txt')], review: [ok] } });
    const c = h.lot('L1', {}, { test: 'echo TESTS_LANCES_$((1+1)) >&2; exit 3', build: 'test -f b.txt || { echo cassé >&2; exit 4; }' });
    await runLot(c);
    const brief = h.calls[1].brief;
    expect(kinds(h).slice(0, 2)).toEqual(['implement', 'fix']);
    expect(brief).toContain('en échec (code 4)');
    expect(brief).not.toContain('TESTS_LANCES_2'); // sortie des tests : la commande elle-même est dans le brief (L399), pas son résultat
    expect(brief).not.toContain('code 3');
  });

  it('R3 — la ligne de base joue aussi le build d\'abord dans son worktree : le départ n\'est pas rougi par l\'absence de dist', async () => {
    const h = harness({ script: { implement: [impl()], review: [ok] } });
    const c = h.lot('L1', {}, { test: "test -f dist/built || { echo ' FAIL  e2e > lit le dist'; exit 1; }; echo ' FAIL  autre-lot > cas ancien'; exit 1", build: BUILD });
    await runLot(c);
    expect(c.lot.status).toBe('ready');
    expect(c.lot.baseline?.failures).toEqual(['autre-lot > cas ancien']);
  });

  it('R4 — un build rouge au sha de départ ne donne pas de ligne de base : les tests rouges restent rouges, la correction a lieu', async () => {
    const h = harness({ script: { implement: [impl()], fix: [fix('b.txt')], review: [ok] } });
    const c = h.lot('L1', {}, {
      test: "test -f b.txt || { echo ' FAIL  cas > rouge'; exit 1; }",
      build: 'case "$PWD" in *cadence-baseline*) exit 5;; esac; true',
    });
    await runLot(c);
    expect(kinds(h).slice(0, 2)).toEqual(['implement', 'fix']);
    expect(c.lot.baseline).toBeUndefined();
  });
});
