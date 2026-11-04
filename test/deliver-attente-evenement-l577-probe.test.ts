import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { realDeps } from '../src/deliver.js';
import { readProcs } from '../src/proc.js';
import { tempDir } from './helpers.js';

const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

describe('L577 probe : deliver exec, attente du descendant par événement', () => {
  it('un descendant déjà mort avant l’adoption ne retient pas la commande (code 0 rendu vite)', async () => {
    const logs = tempDir();
    const t0 = Date.now();
    const code = await realDeps(logs, readProcs, 2_000, 600).exec('sleep 0.1 & exit 0', {}, 20_000);
    expect(code).toBe(0);
    expect(Date.now() - t0).toBeLessThan(10_000);
  }, 30_000);

  it('le code non nul de la racine est rendu tel quel avec un descendant vivant, qui reste borné', async () => {
    const logs = tempDir();
    const code = await realDeps(logs, readProcs, 2_000, 300).exec('sleep 30 & echo $! > bg; sleep 0.3; exit 7', {}, 60_000);
    const bgFile = join(logs, 'bg');
    const bg = existsSync(bgFile) ? Number(readFileSync(bgFile, 'utf8').trim()) : 0;
    try {
      expect(code).toBe(7);
    } finally {
      if (bg > 1 && alive(bg)) process.kill(bg, 'SIGKILL');
    }
  }, 70_000);

  it('un relevé de processus refusé (null) ne bloque pas la commande', async () => {
    const logs = tempDir();
    const code = await realDeps(logs, () => null, 2_000, 300).exec('exit 0', {}, 20_000);
    expect(code).toBe(0);
  }, 30_000);

  it('deux commandes de suite sur les mêmes dépendances rendent chacune leur code', async () => {
    const logs = tempDir();
    const deps = realDeps(logs, readProcs, 2_000, 300);
    expect(await deps.exec('exit 0', {}, 20_000)).toBe(0);
    expect(await deps.exec('exit 3', {}, 20_000)).toBe(3);
  }, 60_000);
});

describe('L577 probe : la mesure documentée', () => {
  it('les lignes du tableau totalisent les 22 lignes que la commande de la mesure rend', () => {
    const doc = readFileSync(join(__dirname, '..', 'docs/mesures/instables-sous-charge-2026-11-04.md'), 'utf8');
    const rows = doc.split('\n').filter((l) => /^\| `/.test(l));
    const total = rows.reduce((s, l) => s + Number(l.split('|')[2].trim()), 0);
    expect(rows.length).toBe(12);
    expect(total).toBe(22);
  });
});
