import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { runLot } from '../src/orchestrate/cycle.js';
import { claudeOut, commitFile, git, harness, probeReport, reviewReport, workReport, type Handler } from './orchestrate-harness.js';

const root = join(import.meta.dirname, '..');
const impl = (...files: string[]): Handler => (call) => claudeOut(workReport({ commits: files.map((f) => commitFile(call.opts.cwd, f, `feat(L1): ${f}`)) }));
const fix = (file: string): Handler => (call) => claudeOut(workReport({ commits: [commitFile(call.opts.cwd, file, `fix(L1): ${file}`)] }));
const ok: Handler = () => claudeOut(reviewReport());
const kinds = (h: ReturnType<typeof harness>) => h.calls.map((c) => c.kind);
const CASE = 'staged.spec.ts > nom vide > rejette — borne : nom vide — attendu : une erreur';
/** La sonde écrit un fichier, l'indexe (`git add`) et ne le commite pas : « A  staged.spec.ts ». */
const stages = (file: string, over: Record<string, unknown> = {}, edit = false): Handler => (call) => {
  writeFileSync(join(call.opts.cwd, file), "it('rouge', () => {});\n");
  git(call.opts.cwd, 'add', '--', file);
  if (edit) writeFileSync(join(call.opts.cwd, file), "it('rouge, puis édité', () => {});\n");
  return claudeOut(probeReport(over));
};

describe("un fichier de sonde indexé et non commité est retiré de l'index et supprimé (L614, issue #39)", () => {
  it("R1 — un fichier INDEXÉ (A) laissé par la sonde : désindexé, supprimé, warning, la revue part au lieu de « dépôt sale après probe »", async () => {
    const h = harness({ script: { implement: [impl('a.ts')], probe: [stages('staged.spec.ts')], review: [ok] } });
    const c = h.lot('L1', {}, { probe: true });
    await runLot(c);
    expect(kinds(h)).toEqual(['implement', 'probe', 'review']);
    expect(c.lot.status).toBe('ready');
    expect(existsSync(join(h.repo, 'staged.spec.ts'))).toBe(false);
    expect(git(h.repo, 'status', '--porcelain')).toBe('');
    expect(c.lot.warnings).toContain('sonde de cas limites : fichiers non commités laissés par la session retirés (staged.spec.ts)');
  });

  it("R1 — indexé puis modifié (AM), nom accentué ou avec espace : tout est retiré, le warning nomme les chemins décodés", async () => {
    const two: Handler = (call) => {
      stages('sonde règle.spec.ts', {}, true)(call);
      return stages('sonde-é.spec.ts', {}, true)(call);
    };
    const h = harness({ script: { implement: [impl('a.ts')], probe: [two], review: [ok] } });
    const c = h.lot('L1', {}, { probe: true });
    await runLot(c);
    expect(kinds(h)).toEqual(['implement', 'probe', 'review']);
    expect(git(h.repo, 'status', '--porcelain')).toBe('');
    const w = c.lot.warnings.find((x) => x.includes('laissés par la session retirés'))!;
    expect(w).toContain('sonde règle.spec.ts');
    expect(w).toContain('sonde-é.spec.ts');
  });

  it("R2 — les cas rouges annoncés (echecs) d'un fichier retiré reviennent comme constats à la passe de correction, avec orchestrate.test", async () => {
    const h = harness({ script: { implement: [impl('a.ts')], probe: [stages('staged.spec.ts', { echecs: [CASE] })], fix: [fix('fixed.flag')], review: [ok] } });
    const c = h.lot('L1', {}, { probe: true, test: 'true' });
    await runLot(c);
    expect(kinds(h)).toEqual(['implement', 'probe', 'fix', 'review']);
    const step = c.lot.steps.find((s) => s.kind === 'probe')!;
    expect(step.constats).toHaveLength(1);
    expect(step.constats![0]).toContain(`sonde de cas limites : ${CASE}`);
    expect(step.constats![0]).toContain('staged.spec.ts');
    expect(step.constats![0]).toContain('non commité');
    const fixBrief = h.calls.find((k) => k.kind === 'fix')!.brief;
    expect(fixBrief).toContain(CASE);
    expect(git(h.repo, 'status', '--porcelain')).toBe('');
  });

  it("R2 — sans orchestrate.test, le cas n'est repris qu'une fois (pas de doublon avec les échecs annoncés)", async () => {
    const h = harness({ script: { implement: [impl('a.ts')], probe: [stages('staged.spec.ts', { echecs: [CASE] })], fix: [fix('b.ts')], review: [ok] } });
    const c = h.lot('L1', {}, { probe: true });
    await runLot(c);
    expect(kinds(h)).toEqual(['implement', 'probe', 'fix', 'review']);
    expect(c.lot.steps.find((s) => s.kind === 'probe')!.constats).toHaveLength(1);
  });

  it("R2 — fichier indexé retiré sans echecs annoncé : pas de constat, la revue part", async () => {
    const h = harness({ script: { implement: [impl('a.ts')], probe: [stages('staged.spec.ts')], review: [ok] } });
    const c = h.lot('L1', {}, { probe: true, test: 'true' });
    await runLot(c);
    expect(kinds(h)).toEqual(['implement', 'probe', 'review']);
  });

  it("R3 — un fichier SUIVI modifié et indexé reste un dépôt sale, le lot est rendu", async () => {
    const dirty: Handler = (call) => {
      writeFileSync(join(call.opts.cwd, 'a.ts'), '// modifié et indexé\n');
      git(call.opts.cwd, 'add', '--', 'a.ts');
      return claudeOut(probeReport());
    };
    const h = harness({ script: { implement: [impl('a.ts')], probe: [dirty], review: [ok] } });
    const c = h.lot('L1', {}, { probe: true });
    await runLot(c);
    expect(kinds(h)).toEqual(['implement', 'probe']);
    expect(c.lot.status).toBe('handed-back');
    expect(c.lot.outcome).toContain('dépôt sale après probe : a.ts');
  });

  it("R4 — la documentation décrit le fichier indexé retiré et ses cas rouges repris en constats", () => {
    expect(readFileSync(join(root, 'docs/orchestrate-gate.md'), 'utf8')).toContain('issue #39');
    expect(readFileSync(join(root, 'CHANGELOG.md'), 'utf8')).toContain('#39');
  });
});
