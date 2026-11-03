import { describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { realClaude, buildArgs, type StepSpec } from '../src/orchestrate/launch.js';
import { tempDir } from './helpers.js';

// L567 — bords : EPIPE sur l'écriture du brief (stdin non lu), répété, vide, sortie en échec ; délais du lot cohérents avec la config.

const spec = (brief: string): StepSpec => ({ brief, model: 'sonnet', effort: 'medium', schema: { type: 'object' }, cwd: '.', wave: 'w', permissionMode: 'auto', addDirs: [], timeoutMs: 30_000, sessionId: 'sid-1' }) as unknown as StepSpec;
const faux = (dir: string, body: string, name = 'fake.sh') => {
  const bin = join(dir, name);
  writeFileSync(bin, `#!/bin/sh\n${body}\n`, { mode: 0o755 });
  return bin;
};

describe('L567 — EPIPE sur le stdin d\'une session qui ne le lit pas', () => {
  it('brief énorme, session qui sort en échec sans lire : le code et la sortie de la session sont rendus, pas de rejet', async () => {
    const dir = tempDir();
    const bin = faux(dir, "echo oups >&2\nexit 3");
    const out = await realClaude(bin, process.env)(buildArgs(spec('x'.repeat(4_000_000)), {}), { cwd: dir, env: {}, timeoutMs: 30_000 });
    expect(out.code).toBe(3);
    expect(out.stderr).toContain('oups');
  });

  it('brief vide : la session sort normalement', async () => {
    const dir = tempDir();
    const bin = faux(dir, "echo '{}'");
    const out = await realClaude(bin, process.env)(buildArgs(spec(''), {}), { cwd: dir, env: {}, timeoutMs: 30_000 });
    expect(out.code).toBe(0);
  });

  it('vingt lancements simultanés avec EPIPE : tous aboutissent, aucun rejet non géré', async () => {
    const dir = tempDir();
    const bin = faux(dir, "echo '{}'");
    const outs = await Promise.all(Array.from({ length: 20 }, () => realClaude(bin, process.env)(buildArgs(spec('y'.repeat(1_000_000)), {}), { cwd: dir, env: {}, timeoutMs: 30_000 })));
    expect(outs.map((o) => o.code)).toEqual(Array(20).fill(0));
  });

  it('binaire absent : code 127 et pas d\'exception', async () => {
    const dir = tempDir();
    const out = await realClaude(join(dir, 'absent'), process.env)(buildArgs(spec('z'.repeat(200_000)), {}), { cwd: dir, env: {}, timeoutMs: 30_000 });
    expect(out.code).toBe(127);
  });

  it('spawnSync input vers un processus qui ne lit pas : le code de sortie du processus prime, EPIPE est rendu en error sans lever', () => {
    const r = spawnSync('sh', ['-c', 'exit 0'], { input: 'a'.repeat(3_000_000), encoding: 'utf8' });
    expect(r.status).toBe(0);
    if (r.error) expect((r.error as NodeJS.ErrnoException).code).toBe('EPIPE');
  });
});

describe('L567 — les délais relevés par le lot tiennent dans leurs bornes', () => {
  const lire = (f: string) => readFileSync(join(process.cwd(), 'test', f), 'utf8');
  it('R19 : la boucle d\'attente (300 × 100 ms) reste sous le délai du test (90 s)', () => {
    const src = lire('porte-deportee-signal.test.ts');
    const boucle = /i < (\d+) && !alive\(pattern\).*setTimeout\(r, (\d+)\)/.exec(src)!;
    const attente = Number(boucle[1]) * Number(boucle[2]);
    const delai = Number(/\}, ([\d_]+)\);\s*\}\);\s*$/.exec(src)![1]!.replace(/_/g, ''));
    expect(attente + 10_000).toBeLessThan(delai);
  });
  it('L195 : trois commandes npm asynchrones sans maxBuffer dépassé (sortie silencieuse) et délai explicite', () => {
    const src = lire('mise-en-service.test.ts');
    expect(src).toContain('}, 180_000);');
    expect(src).not.toMatch(/execFileSync\('npm', \['run', '--silent', '(build|prepare)'\]/);
  });
});
