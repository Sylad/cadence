import { describe, expect, it } from 'vitest';
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { runLot } from '../src/orchestrate/cycle.js';
import { claudeOut, commitFile, git, harness, probeReport, reviewReport, workReport, type Handler } from './orchestrate-harness.js';

const impl = (...files: string[]): Handler => (call) => claudeOut(workReport({ commits: files.map((f) => commitFile(call.opts.cwd, f, `feat(L1): ${f}`)) }));
const fix = (file: string): Handler => (call) => claudeOut(workReport({ commits: [commitFile(call.opts.cwd, file, `fix(L1): ${file}`)] }));
const ok: Handler = () => claudeOut(reviewReport());
const kinds = (h: ReturnType<typeof harness>) => h.calls.map((c) => c.kind);
const stage = (cwd: string, file: string, body = "it('rouge', () => {});\n") => {
  mkdirSync(join(cwd, file, '..'), { recursive: true });
  writeFileSync(join(cwd, file), body);
  git(cwd, 'add', '--', file);
};

describe('bords du fichier de sonde indexé retiré (L614, issue #39)', () => {
  it('indexé dans un sous-dossier : retiré, arbre propre, la revue part', async () => {
    const p: Handler = (call) => { stage(call.opts.cwd, 'sonde/deep/x.spec.ts'); return claudeOut(probeReport()); };
    const h = harness({ script: { implement: [impl('a.ts')], probe: [p], review: [ok] } });
    const c = h.lot('L1', {}, { probe: true });
    await runLot(c);
    expect(kinds(h)).toEqual(['implement', 'probe', 'review']);
    expect(existsSync(join(h.repo, 'sonde/deep/x.spec.ts'))).toBe(false);
    expect(git(h.repo, 'status', '--porcelain')).toBe('');
  });

  it('indexé puis supprimé du disque (AD) : retiré de l\'index, la revue part', async () => {
    const p: Handler = (call) => { stage(call.opts.cwd, 'gone.spec.ts'); rmSync(join(call.opts.cwd, 'gone.spec.ts')); return claudeOut(probeReport()); };
    const h = harness({ script: { implement: [impl('a.ts')], probe: [p], review: [ok] } });
    const c = h.lot('L1', {}, { probe: true });
    await runLot(c);
    expect(kinds(h)).toEqual(['implement', 'probe', 'review']);
    expect(git(h.repo, 'status', '--porcelain')).toBe('');
  });

  it('nom avec guillemet double : retiré et nommé décodé', async () => {
    const p: Handler = (call) => { stage(call.opts.cwd, 'a"b.spec.ts'); return claudeOut(probeReport()); };
    const h = harness({ script: { implement: [impl('a.ts')], probe: [p], review: [ok] } });
    const c = h.lot('L1', {}, { probe: true });
    await runLot(c);
    expect(kinds(h)).toEqual(['implement', 'probe', 'review']);
    expect(git(h.repo, 'status', '--porcelain')).toBe('');
    expect(c.lot.warnings.some((w) => w.includes('retirés (a"b.spec.ts)'))).toBe(true);
  });

  it('echecs blancs seulement + fichier retiré avec orchestrate.test : aucun constat', async () => {
    const p: Handler = (call) => { stage(call.opts.cwd, 's.spec.ts'); return claudeOut(probeReport({ echecs: ['  ', ''] })); };
    const h = harness({ script: { implement: [impl('a.ts')], probe: [p], review: [ok] } });
    const c = h.lot('L1', {}, { probe: true, test: 'true' });
    await runLot(c);
    expect(kinds(h)).toEqual(['implement', 'probe', 'review']);
  });

  it('deux cas annoncés, deux fichiers indexés : deux constats majeurs', async () => {
    const p: Handler = (call) => { stage(call.opts.cwd, 'u.spec.ts'); stage(call.opts.cwd, 'v.spec.ts'); return claudeOut(probeReport({ echecs: ['u > cas 1', 'v > cas 2'] })); };
    const h = harness({ script: { implement: [impl('a.ts')], probe: [p], fix: [fix('f.ts')], review: [ok] } });
    const c = h.lot('L1', {}, { probe: true, test: 'true' });
    await runLot(c);
    expect(kinds(h)).toEqual(['implement', 'probe', 'fix', 'review']);
    expect(c.lot.steps.find((s) => s.kind === 'probe')!.constats).toHaveLength(2);
  });

  it('indexé neuf ET fichier suivi modifié : le lot est rendu, le fichier suivi nommé, l\'indexé retiré quand même', async () => {
    const p: Handler = (call) => { stage(call.opts.cwd, 's.spec.ts'); writeFileSync(join(call.opts.cwd, 'a.ts'), '// sale\n'); return claudeOut(probeReport()); };
    const h = harness({ script: { implement: [impl('a.ts')], probe: [p], review: [ok] } });
    const c = h.lot('L1', {}, { probe: true });
    await runLot(c);
    expect(c.lot.status).toBe('handed-back');
    expect(c.lot.outcome).toContain('dépôt sale après probe : a.ts');
    expect(c.lot.outcome).not.toContain('s.spec.ts');
  });

  it('fichier suivi à nom accentué modifié : le message de dépôt sale le nomme décodé', async () => {
    const p: Handler = (call) => { writeFileSync(join(call.opts.cwd, 'é.ts'), '// sale\n'); return claudeOut(probeReport()); };
    const h = harness({ script: { implement: [impl('é.ts')], probe: [p], review: [ok] } });
    const c = h.lot('L1', {}, { probe: true });
    await runLot(c);
    expect(c.lot.status).toBe('handed-back');
    expect(c.lot.outcome).toContain('dépôt sale après probe : é.ts');
  });
});
