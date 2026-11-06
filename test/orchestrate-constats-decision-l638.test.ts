import { describe, expect, it } from 'vitest';
import { mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { runLot } from '../src/orchestrate/cycle.js';
import { run } from '../src/cli.js';
import { claudeOut, commitFile, harness, reviewReport, workReport, type Handler } from './orchestrate-harness.js';
import { tempDir } from './helpers.js';
import { writeJournal, writeWave } from './perf-helpers.js';

// L638 : l'état de lot garde, pour chaque constat de chaque revue de code, son texte, son rang et la décision de L622 (compté ou écarté) ; `cadence perf` en tire le taux d'écartés.
type K = { gravite: string; texte: string; inchange?: boolean };
const impl: Handler = (call) => claudeOut(workReport({ commits: [commitFile(call.opts.cwd, 'a.txt', 'feat(L1): a')] }));
const fix = (file: string): Handler => (call) => claudeOut(workReport({ commits: [commitFile(call.opts.cwd, file, `fix(L1): ${file}`)] }));
const rev = (constats: K[]): Handler => () => {
  const n = (g: string) => constats.filter((k) => k.gravite === g).length;
  return claudeOut(reviewReport({ bloquants: n('bloquant'), majeurs: n('majeur'), mineurs: n('mineur'), constats, verdict: 'non conforme' }));
};

describe('R1 — chaque constat d’une revue garde texte, rang et décision L622 dans le pas', () => {
  it('R1 — revue 1 : tout est compté (rang 1) ; revue 2 : le majeur marqué est écarté, le bloquant et le mineur sont comptés (rang 2)', async () => {
    const h = harness({
      script: {
        implement: [impl],
        review: [rev([{ gravite: 'majeur', texte: 'premier', inchange: true }]), rev([{ gravite: 'majeur', texte: 'hors objectif', inchange: true }, { gravite: 'bloquant', texte: 'perte de données' }, { gravite: 'mineur', texte: 'nom' }]), () => claudeOut(reviewReport())],
        fix: [fix('b.txt'), fix('c.txt')],
      },
    });
    const c = h.lot('L1');
    await runLot(c);
    const reviews = c.lot.steps.filter((s) => s.kind === 'review');
    expect(reviews[0].constatsRevue).toEqual([{ texte: 'premier', gravite: 'majeur', rang: 1, decision: 'compte' }]);
    expect(reviews[1].constatsRevue).toEqual([
      { texte: 'hors objectif', gravite: 'majeur', rang: 2, decision: 'ecarte-inchange' },
      { texte: 'perte de données', gravite: 'bloquant', rang: 2, decision: 'compte' },
      { texte: 'nom', gravite: 'mineur', rang: 2, decision: 'compte' },
    ]);
    expect(reviews[2].constatsRevue).toEqual([]);
  });
  it('R1 — un majeur marqué qui répète la revue précédente porte une fausse marque : décision « compte »', async () => {
    const h = harness({ script: { implement: [impl], review: [rev([{ gravite: 'majeur', texte: 'même défaut' }]), rev([{ gravite: 'majeur', texte: 'même défaut', inchange: true }]), () => claudeOut(reviewReport())], fix: [fix('b.txt'), fix('c.txt')] } });
    const c = h.lot('L1');
    await runLot(c);
    expect(c.lot.steps.filter((s) => s.kind === 'review')[1].constatsRevue).toEqual([{ texte: 'même défaut', gravite: 'majeur', rang: 2, decision: 'compte' }]);
  });
});

describe('R2 — cadence perf donne le taux de constats écartés par vague', () => {
  const TODAY = '2026-10-26';
  const CUR = '2026-10-22';
  const step = (extra: object) => ({ kind: 'review', model: 'sonnet', started: `${CUR}T10:00:00`, ended: `${CUR}T10:30:00`, counted: 1000, ...extra });
  function ctx() {
    const root = tempDir();
    const runs = join(root, '.cadence', 'runs');
    mkdirSync(runs, { recursive: true });
    writeWave(runs, 'w1', '2026-10-01T08:00:00');
    writeWave(runs, 'w2', '2026-10-02T08:00:00');
    const dec = (decision: string) => ({ texte: 't', gravite: 'majeur', rang: 2, decision });
    writeJournal(runs, 'w1', 'alpha', 'L1', { steps: [step({ constatsRevue: [dec('compte'), dec('ecarte-inchange'), dec('ecarte-inchange'), dec('compte')] })] });
    writeJournal(runs, 'w2', 'alpha', 'L2', { steps: [step({ constatsRevue: [dec('compte')] }), step({})] });
    return root;
  }
  const perf = async (root: string, ...args: string[]) => {
    const out: string[] = [];
    await run(['perf', ...args], { cwd: root, env: { RAF_TODAY: TODAY }, out: (l) => out.push(l), err: () => {}, now: () => new Date(`${TODAY}T10:00:00`) });
    return out;
  };
  it('R2 — --json : constats et écartés de la fenêtre, et de chaque vague', async () => {
    const data = JSON.parse((await perf(ctx(), '--json')).join('\n'));
    expect(data.ecartes.current).toMatchObject({ constats: 5, ecartes: 2 });
    expect(data.ecartes.current.taux).toBeCloseTo(0.4);
    expect(data.ecartes.current.vagues).toEqual([{ wave: 'w1', constats: 4, ecartes: 2, taux: 0.5 }, { wave: 'w2', constats: 1, ecartes: 0, taux: 0 }]);
  });
  it('R2 — le rapport lisible le dit ; rien sans constat gardé (journal d’avant L638)', async () => {
    const text = (await perf(ctx())).join('\n');
    expect(text).toMatch(/constats de revue écartés par L622 : 2 sur 5 \(40 % ; précédente n\/d\)/);
    expect(text).toMatch(/w1 : 2 sur 4 \(50 %\)/);
    const root = tempDir();
    mkdirSync(join(root, '.cadence', 'runs'), { recursive: true });
    writeWave(join(root, '.cadence', 'runs'), 'w1', '2026-10-01T08:00:00');
    writeJournal(join(root, '.cadence', 'runs'), 'w1', 'alpha', 'L1', { steps: [step({})] });
    const none = (await perf(root)).join('\n');
    expect(none).not.toContain('écartés par L622');
    expect(JSON.parse((await perf(root, '--json')).join('\n')).ecartes.current).toEqual({ constats: 0, ecartes: 0, taux: null, vagues: [] });
  });
  it('R2 — des constatsRevue illisibles (null, texte, décision inconnue, pas un tableau) sont ignorés sans faire échouer perf', async () => {
    const root = tempDir();
    const runs = join(root, '.cadence', 'runs');
    mkdirSync(runs, { recursive: true });
    writeWave(runs, 'w1', '2026-10-01T08:00:00');
    writeJournal(runs, 'w1', 'alpha', 'L1', { steps: [step({ constatsRevue: [null, 'x', { decision: 'autre' }, { decision: 'ecarte-inchange' }] }), step({ constatsRevue: 'pas un tableau' })] });
    expect(JSON.parse((await perf(root, '--json')).join('\n')).ecartes.current).toMatchObject({ constats: 1, ecartes: 1, taux: 1 });
  });
  it('R2 — docs/perf.md liste la clé ecartes de --json', () => {
    const line = readFileSync(join(__dirname, '..', 'docs', 'perf.md'), 'utf8').split('\n').find((l) => l.startsWith('- **`--json`**')) ?? '';
    expect(line).toMatch(/[ ,]ecartes[:,} ]/);
  });
});
