import { mkdirSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { realDeps } from '../src/deliver.js';
import { appendFailedDelivery, readFailedEntries } from '../src/state.js';
import { tempDir } from './helpers.js';

const written = (reason: string, tail: string[] = []) => {
  const dir = tempDir();
  appendFailedDelivery(dir, '2026-10-24', 'abc1234', reason, 'deploiement', tail);
  return readFailedEntries(dir)[0]!;
};

describe('L289 — la raison d\'une livraison rouge', () => {
  it('ligne réécrite par \\r (barre de progression) : seule la dernière image est gardée, pas 5 images de la barre', async () => {
    const root = tempDir();
    mkdirSync(root, { recursive: true });
    const d = realDeps(root);
    await d.exec(String.raw`printf 'build\n10%%\r50%%\r100%%\ndone\n'; exit 1`, {}, 5_000);
    expect(d.lastOutput!()).toEqual(['build', '100%', 'done']);
  });

  it('ligne finissant par \\r sans dernière image : la dernière image non vide est gardée', async () => {
    const root = tempDir();
    mkdirSync(root, { recursive: true });
    const d = realDeps(root);
    await d.exec(String.raw`printf 'a\r\rb\r\r\n'; exit 1`, {}, 5_000);
    expect(d.lastOutput!()).toEqual(['b']);
  });

  it('jeton, clé, URL signée et VAR=valeur sensible sont masqués dans la raison et dans les lignes de sortie, avant l\'écriture du journal', () => {
    const first = written('livrer.sh code 1 Authorization: Bearer abcdef1234567890', [
      'push ghp_abcdefghijklmnopqrstuvwxyz0123456789',
      'key sk-ant-api03-AbCdEf_1234567890-xyz',
      'AKIAIOSFODNN7EXAMPLE utilisé',
    ]);
    const e = written('x', [
      'GET https://bucket.s3.amazonaws.com/f?X-Amz-Signature=deadbeef&X-Amz-Date=1 failed',
      'https://api.test/x?token=s3cr3t&page=2',
      'DB_PASSWORD=hunter2',
      'export API_KEY="abc def"',
      'https://user:pass@host.test/repo.git',
    ]);
    const all = [first.reason, ...first.tail, e.reason, ...e.tail].join('\n');
    for (const secret of ['abcdef1234567890', 'ghp_abcdef', 'sk-ant-api03', 'AKIAIOSFODNN7', 'deadbeef', 's3cr3t', 'hunter2', 'abc def', 'user:pass']) {
      expect(all).not.toContain(secret);
    }
    expect(e.tail[0]).toContain('failed');
    expect(e.tail[1]).toContain('page=2');
    expect(e.tail[2]).toBe('DB_PASSWORD=***');
  });

  it('une ligne sans secret probable reste intacte', () => {
    const lines = ['npm ERR! code ELIFECYCLE', 'exit code 1 at 12:03:44', 'KEYBOARD=azerty', 'https://example.test/a?page=2'];
    expect(written('script en échec', lines).tail).toEqual(lines);
  });
});
