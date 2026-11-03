import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { RunStore } from '../src/orchestrate/state.js';
import { fake, run, setup, store, WAVE } from './orchestrate-worktree-harness.js';
import { tempDir } from './helpers.js';

// L557 — bords de consumeDrops : vide, absent, deux fois, préfixe, autres lignes, forme réelle du control.log.
const mk = () => new RunStore(tempDir(), 'w');
const log = (s: RunStore) => join(s.dir, 'control.log');

describe('R1 — consumeDrops, bords', () => {
  it('R1 — fichier control.log absent : ne crée rien, ne jette pas', () => {
    const s = mk();
    expect(() => s.consumeDrops(['a:L1'])).not.toThrow();
    expect(existsSync(log(s))).toBe(false);
  });
  it('R1 — liste de clés vide : le fichier reste intact', () => {
    const s = mk();
    s.requestDrop('a:L1');
    s.consumeDrops([]);
    expect(readFileSync(log(s), 'utf8')).toBe('drop a:L1\n');
  });
  it('R1 — fichier vide : reste vide, sans erreur', () => {
    const s = mk();
    writeFileSync(log(s), '');
    s.consumeDrops(['a:L1']);
    expect(readFileSync(log(s), 'utf8')).toBe('');
  });
  it('R1 — lot sans retrait : le fichier est octet pour octet inchangé (lignes vides comprises)', () => {
    const s = mk();
    writeFileSync(log(s), 'drop a:L2\n\nstop-after-current\n');
    s.consumeDrops(['a:L1']);
    expect(readFileSync(log(s), 'utf8')).toBe('drop a:L2\n\nstop-after-current\n');
  });
  it('R1 — deux fois de suite : idempotent', () => {
    const s = mk();
    s.requestDrop('a:L1');
    s.requestDrop('a:L2');
    s.consumeDrops(['a:L1']);
    s.consumeDrops(['a:L1']);
    expect(s.control().drops).toEqual(['a:L2']);
  });
  it('R1 — préfixe : a:L5 ne consomme pas a:L55 ni b:L5', () => {
    const s = mk();
    for (const k of ['a:L55', 'b:L5', 'a:L5']) s.requestDrop(k);
    s.consumeDrops(['a:L5']);
    expect(s.control().drops).toEqual(['a:L55', 'b:L5']);
  });
  it('R1 — le stop-after-current est gardé quand le retrait est consommé', () => {
    const s = mk();
    s.requestDrop('a:L1');
    s.requestStopAfterCurrent();
    s.consumeDrops(['a:L1']);
    expect(s.control()).toEqual({ drops: [], stopAfterCurrent: true });
  });
  it('R1 — fin de ligne CRLF (control.log édité à la main) : le retrait est consommé', () => {
    const s = mk();
    writeFileSync(log(s), 'drop a:L1\r\nstop-after-current\r\n');
    s.consumeDrops(['a:L1']);
    expect(s.control().drops).toEqual([]);
    expect(s.control().stopAfterCurrent).toBe(true);
  });
  it('R1 — plusieurs clés d\'un coup', () => {
    const s = mk();
    for (const k of ['a:L1', 'a:L2', 'a:L3']) s.requestDrop(k);
    s.consumeDrops(['a:L1', 'a:L3']);
    expect(s.control().drops).toEqual(['a:L2']);
  });
  it('R1 — un fichier sans retour final : la dernière ligne drop est consommée', () => {
    const s = mk();
    writeFileSync(log(s), 'stop-after-current\ndrop a:L1');
    s.consumeDrops(['a:L1']);
    expect(s.control().drops).toEqual([]);
  });
});

describe('R1 — resume, bords', () => {
  it('R1 — --integrate d\'un lot jamais retiré : control.log (retrait d\'un autre lot) intact', async () => {
    const { parent } = setup([{ title: 'un' }, { title: 'deux' }]);
    const first = await run(parent, ['a:L1', 'a:L2'], fake());
    if (first.code === 2) throw new Error(first.err);
    const s = store(parent);
    s.requestDrop('a:L2');
    await run(parent, ['--resume', WAVE, '--integrate', 'a:L1'], fake());
    expect(s.control().drops).toContain('a:L2');
  });
});
