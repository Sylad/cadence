import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { effortKey, stepAgent } from '../src/orchestrate/schemas.js';
import { readLockJson } from '../src/state.js';

describe('L486 — le choix de l’agent et de l’effort d’une étape est unique', () => {
  it('D4 — la passe du bibliothécaire prend doc-keeper, les autres étapes l’agent de leur genre', () => {
    expect(stepAgent('fix', true)).toBe('doc-keeper');
    expect(stepAgent('fix')).toBeUndefined();
    expect(stepAgent('fix', false)).toBeUndefined();
    expect(stepAgent('review', true)).toBe('code-reviewer');
    expect(stepAgent('review-small')).toBe('code-reviewer');
    expect(stepAgent('spec')).toBe('spec-writer');
    expect(stepAgent('implement', true)).toBeUndefined();
  });

  it('D4 — la revue d’un petit lot prend l’effort de la revue, les autres le leur', () => {
    expect(effortKey('review-small')).toBe('review');
    expect(effortKey('review')).toBe('review');
    expect(effortKey('fix')).toBe('fix');
  });
});

describe('L486 — lecture commune d’un verrou', () => {
  const dir = mkdtempSync(join(tmpdir(), 'l486-'));
  const lire = (texte: string | null) => {
    const f = join(dir, 'x.lock');
    if (texte !== null) writeFileSync(f, texte);
    else rmSync(f, { force: true });
    return readLockJson<{ pid: number }>(f, (r) => ({ pid: Number(r.pid) }), { pid: 0 });
  };

  it('D3 — absent : null ; lisible : le contenu et l’âge ; pas du JSON ou null : illisible', () => {
    expect(lire(null)).toBeNull();
    expect(lire('{"pid":42}')).toMatchObject({ pid: 42, ageMs: expect.any(Number) });
    expect(lire('{"pid":42}')?.unreadable).toBeUndefined();
    expect(lire('pas du json')).toMatchObject({ pid: 0, unreadable: true });
    expect(lire('null')).toMatchObject({ pid: 0, unreadable: true });
    rmSync(dir, { recursive: true, force: true });
  });
});
