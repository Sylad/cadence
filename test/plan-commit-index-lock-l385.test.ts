import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { runLot } from '../src/orchestrate/cycle.js';
import { git, harness } from './orchestrate-harness.js';

// L385 — un index.lock périmé fait échouer le commit du plan au démarrage du lot ; le plan doit alors redevenir ce qu'il était,
// sinon le lot suivant voit un « dépôt sale » et est rendu.

describe('L385 R2 — un échec du commit de plan remet le plan comme avant', () => {
  it('R2 — index.lock présent au démarrage : le lot échoue, le plan est identique à HEAD et le dépôt propre', async () => {
    const h = harness({ script: {} });
    const plan = join(h.repo, '.cadence/raf.yaml');
    const avant = readFileSync(plan, 'utf8');
    writeFileSync(join(h.repo, '.git/index.lock'), '');
    const c = h.lot('L1');
    await runLot(c);
    expect(c.lot.status).toBe('failed');
    expect(readFileSync(plan, 'utf8')).toBe(avant);
    expect(existsSync(join(h.repo, '.git/index.lock'))).toBe(true);
    expect(git(h.repo, 'status', '--porcelain', '--untracked-files=no')).toBe('');
  });
});
