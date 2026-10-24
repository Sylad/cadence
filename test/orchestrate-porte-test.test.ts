import { describe, expect, it } from 'vitest';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { readOrchestrateConfig } from '../src/config.js';
import { testGateMissing } from '../src/testgate.js';
import { runLot } from '../src/orchestrate/cycle.js';
import { tempDir } from './helpers.js';
import { claudeOut, commitFile, harness, reviewReport, workReport, type Handler } from './orchestrate-harness.js';
import { docText } from './docs-text.js';

const GATE = { code: ['*.ts'], tests: ['*.spec.ts'], except: [] as string[], threshold: 1 };
const impl = (file: string, ...more: string[]): Handler => (call) => claudeOut(workReport({ commits: [file, ...more].map((f) => commitFile(call.opts.cwd, f, `feat(L1): ${f}`)) }));
const fix = (file: string): Handler => (call) => claudeOut(workReport({ commits: [commitFile(call.opts.cwd, file, `fix(L1): ${file}`)] }));
const ok: Handler = () => claudeOut(reviewReport());
const kinds = (h: ReturnType<typeof harness>) => h.calls.map((c) => c.kind);

describe('porte « code modifié sans test » (L287)', () => {
  it('R1 — du code touché sans aucun fichier de test : la porte rend les fichiers de code', () => {
    expect(testGateMissing(GATE, new Set(['b.ts', 'a.ts', 'notes.md']))).toEqual(['a.ts', 'b.ts']);
  });

  it('R2 — un fichier de test touché lève la porte', () => {
    expect(testGateMissing(GATE, new Set(['a.ts', 'a.spec.ts']))).toEqual([]);
  });

  it('R3 — un fichier de test n\'est jamais du code, même quand il correspond aux motifs de code', () => {
    expect(testGateMissing(GATE, new Set(['a.spec.ts']))).toEqual([]);
  });

  it('R4 — les exceptions écartent des fichiers de code (types, config, migrations…)', () => {
    expect(testGateMissing({ ...GATE, except: ['types.ts'] }, new Set(['types.ts']))).toEqual([]);
    expect(testGateMissing({ ...GATE, except: ['types.ts'] }, new Set(['types.ts', 'a.ts']))).toEqual(['a.ts']);
  });

  it('R5 — le seuil : sous le nombre de fichiers de code déclaré, la porte ne joue pas', () => {
    const gate = { ...GATE, threshold: 3 };
    expect(testGateMissing(gate, new Set(['a.ts', 'b.ts']))).toEqual([]);
    expect(testGateMissing(gate, new Set(['a.ts', 'b.ts', 'c.ts']))).toEqual(['a.ts', 'b.ts', 'c.ts']);
  });

  it('R6 — cadence.yaml : orchestrate.testGate se lit avec ses défauts, absent ou false = pas de porte', () => {
    const dir = tempDir();
    const file = join(dir, 'cadence.yaml');
    expect(readOrchestrateConfig(file).testGate).toBeUndefined();
    writeFileSync(file, 'orchestrate:\n  testGate: false\n');
    expect(readOrchestrateConfig(file).testGate).toBeUndefined();
    writeFileSync(file, 'orchestrate:\n  testGate:\n    code: [src/**]\n');
    const g = readOrchestrateConfig(file).testGate!;
    expect(g.code).toEqual(['src/**']);
    expect(g.threshold).toBe(1);
    expect(g.except).toEqual([]);
    expect(g.tests).toContain('**/*.test.*');
    writeFileSync(file, 'orchestrate:\n  testGate:\n    code: [src/**]\n    tests: [spec/**]\n    except: [src/types/**]\n    threshold: 2\n');
    expect(readOrchestrateConfig(file).testGate).toEqual({ code: ['src/**'], tests: ['spec/**'], except: ['src/types/**'], threshold: 2 });
  });

  it('R7 — cadence.yaml : testGate invalide est refusé avec le nom de la clé', () => {
    const dir = tempDir();
    const file = join(dir, 'cadence.yaml');
    for (const [yaml, mot] of [
      ['testGate: true', 'testGate'],
      ['testGate: {}', 'testGate.code'],
      ['testGate: { code: [] }', 'testGate.code'],
      ['testGate: { code: [a], threshold: 0 }', 'testGate.threshold'],
      ['testGate: { code: [a], threshold: 1.5 }', 'testGate.threshold'],
      ['testGate: { code: [a], except: [""] }', 'testGate.except'],
      ['testGate: { code: [a], nope: 1 }', 'testGate.nope'],
    ] as const) {
      writeFileSync(file, `orchestrate:\n  ${yaml}\n`);
      expect(() => readOrchestrateConfig(file), yaml).toThrow(mot);
    }
  });

  it('R8 — code sans test après implement : passe de correction directe, sans session de revue avant', async () => {
    const h = harness({ script: { implement: [impl('a.ts')], fix: [fix('a.spec.ts')], review: [ok] } });
    const c = h.lot('L1', {}, { testGate: GATE });
    await runLot(c);
    expect(kinds(h)).toEqual(['implement', 'fix', 'review']);
    expect(h.calls[1].brief).toContain('a.ts');
    expect(h.calls[1].brief).toContain('testGate');
    expect(c.lot.pass).toBe(1);
    expect(c.lot.status).toBe('ready');
  });

  it('R9 — un test touché dans le lot : pas de passe de correction, la revue part', async () => {
    const h = harness({ script: { implement: [impl('a.ts', 'a.spec.ts')], review: [ok] } });
    await runLot(h.lot('L1', {}, { testGate: GATE }));
    expect(kinds(h)).toEqual(['implement', 'review']);
  });

  it('R10 — la porte ne joue qu\'une fois : la correction qui n\'ajoute pas de test ne boucle pas, la revue part', async () => {
    const h = harness({ script: { implement: [impl('a.ts')], fix: [fix('b.md')], review: [ok] } });
    const c = h.lot('L1', {}, { testGate: GATE });
    await runLot(c);
    expect(kinds(h)).toEqual(['implement', 'fix', 'review']);
    expect(c.lot.pass).toBe(1);
  });

  it('R11 — sans testGate déclaré, le cycle est celui d\'avant', async () => {
    const h = harness({ script: { implement: [impl('a.ts')], review: [ok] } });
    await runLot(h.lot('L1'));
    expect(kinds(h)).toEqual(['implement', 'review']);
  });

  it('R13 — budget du lot : la porte ne joue pas quand la correction et la revue qui la suit ne sont plus payées, avertissement et revue', async () => {
    const h = harness({ script: { implement: [impl('a.ts')], review: [ok] } });
    const c = h.lot('L1', { budget: 100 }, { testGate: GATE });
    await runLot(c);
    expect(kinds(h)).toEqual(['implement', 'review']);
    expect(c.lot.status).toBe('ready');
    expect(c.lot.warnings.join('\n')).toContain('porte « code sans test » non jouée');
    expect(c.lot.warnings.join('\n')).toContain('budget');
  });

  it('R14 — deux passes de correction déjà faites : avertissement, pas de troisième passe, la revue part', async () => {
    const h = harness({ script: { implement: [impl('a.ts')], review: [ok] } });
    const c = h.lot('L1', { pass: 2 }, { testGate: GATE });
    await runLot(c);
    expect(kinds(h)).toEqual(['implement', 'review']);
    expect(c.lot.warnings.join('\n')).toContain('porte « code sans test » non jouée');
    expect(c.lot.warnings.join('\n')).toContain('2 passe(s)');
  });

  it('R14b — une passe de correction déjà faite (tests rouges) : la correction de la porte prendrait la dernière, la revue arriverait sans passe restante → avertissement, la revue part', async () => {
    const h = harness({ script: { implement: [impl('a.ts')], review: [ok] } });
    const c = h.lot('L1', { pass: 1 }, { testGate: GATE });
    await runLot(c);
    expect(kinds(h)).toEqual(['implement', 'review']);
    expect(c.lot.warnings.join('\n')).toContain('porte « code sans test » non jouée');
    expect(c.lot.warnings.join('\n')).toContain('1 passe(s)');
  });

  it('R15 — la passe des mineurs ne joue pas la porte : du code sans test y passe, la revue courte part', async () => {
    const h = harness({ script: { fix: [fix('b.ts')], 'review-small': [ok] } });
    const c = h.lot('L1', {}, { testGate: GATE });
    commitFile(h.repo, 'a.ts', 'feat(L1): a');
    c.lot.minorPass = true;
    c.lot.minorFix = true;
    c.lot.constats = [{ source: 'code', gravite: 'mineur', fichier: 'a.ts', ligne: 1, texte: 'nommage' }];
    c.lot.next = 'fix';
    await runLot(c);
    expect(kinds(h)).toEqual(['fix', 'review-small']);
    expect(c.lot.warnings.join('\n')).not.toContain('porte');
  });

  it('R12 — docs/orchestrate.md et le README décrivent la porte et sa clé', () => {
    const doc = docText();
    expect(doc).toContain('testGate');
    expect(doc).toMatch(/code changed without a test/);
  });
});
