import { afterEach, describe, expect, it } from 'vitest';
import { existsSync, mkdirSync, readFileSync, utimesSync } from 'node:fs';
import { join } from 'node:path';
import { parseDeliverConfig, type CheckDeps } from '../src/deliver.js';
import { appendDelivery, appendFailedDelivery, recordVerifiedDelivery } from '../src/state.js';
import { verifyCommand } from '../src/verify.js';
import { cleanupTempDirs, tempDir } from './helpers.js';

afterEach(cleanupTempDirs);

const SHA = '3d6edf4' + 'a'.repeat(33);
const OTHER = 'b'.repeat(40);
const config = parseDeliverConfig('deliver:\n  verify:\n    - command: check\n', 'cadence.yaml');
const deps = (code: number): CheckDeps => ({ exec: async () => code, fetch: async () => ({ status: 200, text: '' }), sleep: async () => {}, now: () => 0 });
const stateDir = () => {
  const d = join(tempDir(), 'cadence');
  mkdirSync(d, { recursive: true });
  return d;
};
const journal = (d: string) => (existsSync(join(d, 'deliveries.log')) ? readFileSync(join(d, 'deliveries.log'), 'utf8') : '');
const touch = (file: string, at: number) => utimesSync(file, at, at);
async function verify(d: string, sha: string, code = 0) {
  const lines: string[] = [];
  const exit = await verifyCommand({ config, sha, retry: 0, out: (l) => lines.push(l), journal: { dir: d, day: '2026-10-29' } }, deps(code));
  return { exit, lines };
}

describe('L435 — verify vert après une livraison rouge du même sha', () => {
  it('R1 — un verify vert au sha de la dernière livraison rouge l\'inscrit au journal vert et le dit', async () => {
    const d = stateDir();
    appendFailedDelivery(d, '2026-10-29', SHA, 'vérification en échec');
    const { exit, lines } = await verify(d, SHA);
    expect(exit).toBe(0);
    expect(journal(d)).toBe(`2026-10-29 ${SHA}\n`);
    expect(lines.join('\n')).toContain('livraison rouge');
  });

  it('R2 — un verify rouge n\'écrit rien', async () => {
    const d = stateDir();
    appendFailedDelivery(d, '2026-10-29', SHA, 'vérification en échec');
    expect((await verify(d, SHA, 1)).exit).toBe(1);
    expect(journal(d)).toBe('');
  });

  it('R3 — sans livraison rouge, ou rouge d\'un autre sha, rien n\'est écrit', async () => {
    const d = stateDir();
    await verify(d, SHA);
    appendFailedDelivery(d, '2026-10-29', OTHER, 'CI en échec');
    await verify(d, SHA);
    expect(journal(d)).toBe('');
  });

  it('R4 — une livraison rouge plus récente d\'un autre sha n\'est pas effacée', async () => {
    const d = stateDir();
    appendFailedDelivery(d, '2026-10-28', SHA, 'CI en échec');
    appendFailedDelivery(d, '2026-10-29', OTHER, 'CI en échec');
    await verify(d, SHA);
    expect(journal(d)).toBe('');
  });

  it('R5 — deux verify de suite n\'écrivent qu\'une ligne', async () => {
    const d = stateDir();
    appendFailedDelivery(d, '2026-10-29', SHA, 'CI en échec');
    touch(join(d, 'deliveries-failed.log'), 1000);
    await verify(d, SHA);
    await verify(d, SHA);
    expect(journal(d)).toBe(`2026-10-29 ${SHA}\n`);
  });

  it('R6 — une livraison verte du même sha déjà postérieure au rouge : rien de plus', async () => {
    const d = stateDir();
    appendFailedDelivery(d, '2026-10-28', SHA, 'CI en échec');
    touch(join(d, 'deliveries-failed.log'), 1000);
    appendDelivery(d, '2026-10-28', SHA);
    touch(join(d, 'deliveries.log'), 2000);
    await verify(d, SHA);
    expect(journal(d)).toBe(`2026-10-28 ${SHA}\n`);
  });

  it('R7 — une livraison rouge nouvelle après une verte du même sha est de nouveau effaçable', async () => {
    const d = stateDir();
    appendDelivery(d, '2026-10-27', SHA);
    touch(join(d, 'deliveries.log'), 1000);
    appendFailedDelivery(d, '2026-10-29', SHA, 'CI en échec');
    touch(join(d, 'deliveries-failed.log'), 2000);
    expect(recordVerifiedDelivery(d, '2026-10-29', SHA)).toBe(true);
    expect(journal(d)).toBe(`2026-10-27 ${SHA}\n2026-10-29 ${SHA}\n`);
  });

  it('R8 — sans journal passé (verify hors dépôt de suivi) rien n\'est écrit et rien ne casse', async () => {
    const lines: string[] = [];
    expect(await verifyCommand({ config, sha: SHA, retry: 0, out: (l) => lines.push(l) }, deps(0))).toBe(0);
  });
});
