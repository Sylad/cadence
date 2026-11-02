import { afterEach, describe, expect, it } from 'vitest';
import { existsSync, mkdirSync, readFileSync, utimesSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseDeliverConfig, type CheckDeps } from '../src/deliver.js';
import { appendDelivery, appendFailedDelivery, recordVerifiedDelivery } from '../src/state.js';
import { verifyCommand } from '../src/verify.js';
import { cleanupTempDirs, tempDir } from './helpers.js';

afterEach(cleanupTempDirs);

const SHA = '3d6edf4' + 'a'.repeat(33);
const config = parseDeliverConfig('deliver:\n  verify:\n    - command: check\n', 'cadence.yaml');
const deps = (code: number): CheckDeps => ({ exec: async () => code, fetch: async () => ({ status: 200, text: '' }), sleep: async () => {}, now: () => 0 });
const stateDir = () => {
  const d = join(tempDir(), 'cadence');
  mkdirSync(d, { recursive: true });
  return d;
};
const journal = (d: string) => (existsSync(join(d, 'deliveries.log')) ? readFileSync(join(d, 'deliveries.log'), 'utf8') : '');

describe('L435 limites — verify vert et journal des livraisons', () => {
  it('dossier d\'état absent : le verify vert reste vert (code 0), sans exception', async () => {
    const d = join(tempDir(), 'inexistant');
    const r = await verifyCommand({ config, sha: SHA, retry: 0, out: () => {}, journal: { dir: d, day: '2026-10-29' } }, deps(0));
    expect(r).toBe(0);
  });

  it('journal rouge vide : rien écrit, false', () => {
    const d = stateDir();
    writeFileSync(join(d, 'deliveries-failed.log'), '');
    expect(recordVerifiedDelivery(d, '2026-10-29', SHA)).toBe(false);
    expect(journal(d)).toBe('');
  });

  it('ligne rouge sans sha : un sha vide n\'est jamais inscrit', () => {
    const d = stateDir();
    writeFileSync(join(d, 'deliveries-failed.log'), '2026-10-29\n');
    expect(recordVerifiedDelivery(d, '2026-10-29', '')).toBe(false);
    expect(journal(d)).toBe('');
  });

  it('ligne rouge illisible en dernier : la dernière lisible décide, pas de crash', () => {
    const d = stateDir();
    appendFailedDelivery(d, '2026-10-29', SHA, 'CI en échec');
    writeFileSync(join(d, 'deliveries-failed.log'), `${readFileSync(join(d, 'deliveries-failed.log'), 'utf8')}pas une ligne\n`);
    expect(() => recordVerifiedDelivery(d, '2026-10-29', SHA)).not.toThrow();
  });

  it('sha court contre sha complet du journal rouge : pas d\'inscription fausse', () => {
    const d = stateDir();
    appendFailedDelivery(d, '2026-10-29', SHA, 'CI en échec');
    expect(recordVerifiedDelivery(d, '2026-10-29', SHA.slice(0, 7))).toBe(false);
    expect(journal(d)).toBe('');
  });

  it('vert strictement égal en date de modification au rouge : le rouge est effaçable une seule fois', () => {
    const d = stateDir();
    appendFailedDelivery(d, '2026-10-29', SHA, 'CI en échec');
    appendDelivery(d, '2026-10-28', SHA);
    utimesSync(join(d, 'deliveries-failed.log'), 1000, 1000);
    utimesSync(join(d, 'deliveries.log'), 1000, 1000);
    recordVerifiedDelivery(d, '2026-10-29', SHA);
    recordVerifiedDelivery(d, '2026-10-29', SHA);
    expect(journal(d).split('\n').filter(Boolean).length).toBeLessThanOrEqual(2);
  });

  it('journal rouge absent : false, aucun fichier créé', () => {
    const d = stateDir();
    expect(recordVerifiedDelivery(d, '2026-10-29', SHA)).toBe(false);
    expect(existsSync(join(d, 'deliveries.log'))).toBe(false);
  });

  it('verify sans --sha explicite : sha vide ne touche pas au journal', async () => {
    const d = stateDir();
    appendFailedDelivery(d, '2026-10-29', SHA, 'CI en échec');
    await verifyCommand({ config, sha: '', retry: 0, out: () => {}, journal: { dir: d, day: '2026-10-29' } }, deps(0));
    expect(journal(d)).toBe('');
  });
});
