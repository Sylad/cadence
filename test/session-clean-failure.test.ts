import { describe, expect, it, vi } from 'vitest';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { run } from '../src/cli.js';
import { gitRepo } from './helpers.js';

// Un défaut imprévu du parcours (bogue, erreur non rattrapée) ne doit jamais faire tomber la clôture.
vi.mock('../src/clean.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/clean.js')>()),
  scanStale: () => {
    throw new Error('parcours cassé');
  },
}));

async function cad(dir: string, ...argv: string[]) {
  const out: string[] = [];
  const code = await run(argv, {
    cwd: dir,
    env: { RAF_TODAY: '2026-09-28' },
    out: (l) => out.push(l),
    err: () => {},
    now: () => new Date('2026-09-28T18:30:00'),
  });
  return { code, out: out.join('\n') };
}

describe('session close — nettoyage en échec', () => {
  it('la clôture se termine, dit que rien n’est proposé et garde son verdict', async () => {
    const dir = gitRepo();
    await cad(dir, 'init', '--project', 'demo', '--no-hook');
    writeFileSync(join(dir, 'cadence.yaml'), 'session:\n  cleanDays: 7\n');
    const sans = await cad(dir, 'session', 'close');
    writeFileSync(join(dir, 'cadence.yaml'), 'session:\n  clean: [ "tmp/*" ]\n');
    const { code, out } = await cad(dir, 'session', 'close');
    expect(out).toContain("Nettoyage : parcours interrompu, rien n'est proposé\n  parcours cassé");
    expect(out).toMatch(/\n(✓ prêt à fermer|✗ pas fermé : \d+ point\(s\))$/);
    // Même verdict que sans motif : le nettoyage n'ajoute aucun point ouvert, même en échec.
    expect(code).toBe(sans.code);
  });
});
