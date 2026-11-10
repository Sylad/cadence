import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { doitCompacter, SEUIL_CONTEXTE, tailleContexte } from '../src/run/suite.js';
import { dossierTemp } from './temp.js';

const home = (session: string, usage: Record<string, number>[]): string => {
  const h = dossierTemp('home-'); const d = join(h, '.claude', 'projects', '-x-clone'); mkdirSync(d, { recursive: true });
  writeFileSync(join(d, `${session}.jsonl`), [...usage.map((u) => JSON.stringify({ type: 'assistant', message: { usage: u } })), '{"type":"summary"}', 'illisible'].join('\n') + '\n');
  return h;
};
describe('suite de session au seuil (L690)', () => {
  it('la taille du contexte est celle de la dernière requête : entrée + cache lu + cache écrit', () => {
    const h = home('s1', [{ input_tokens: 1, cache_read_input_tokens: 10 }, { input_tokens: 5, cache_read_input_tokens: 90_000, cache_creation_input_tokens: 2_000 }]);
    expect(tailleContexte('s1', h)).toBe(92_005);
    expect(tailleContexte('absente', h)).toBe(0);
  });
  it('« seuil » ne compacte qu au-dessus de 150 k ; « compactee » toujours ; « gardee » jamais ; rien sans session précédente', () => {
    const petit = home('p', [{ input_tokens: 0, cache_read_input_tokens: 40_000 }]), gros = home('g', [{ input_tokens: 0, cache_read_input_tokens: SEUIL_CONTEXTE + 1 }]);
    expect(doitCompacter('seuil', 'p', petit)).toBe(false);
    expect(doitCompacter('seuil', 'g', gros)).toBe(true);
    expect(doitCompacter('compactee', 'p', petit)).toBe(true);
    expect(doitCompacter('gardee', 'g', gros)).toBe(false);
    expect(doitCompacter('seuil', undefined, gros)).toBe(false);
  });
});
