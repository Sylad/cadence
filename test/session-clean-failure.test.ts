import { describe, expect, it, vi } from 'vitest';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { run } from '../src/cli.js';
import { commit, gitRepo } from './helpers.js';

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
    const git = (...a: string[]) => execFileSync('git', a, { cwd: dir, stdio: 'ignore' });
    await cad(dir, 'init', '--project', 'demo', '--no-hook');
    await cad(dir, 'add', 'Cache');
    git('add', '.');
    commit(dir, 'chore: plan', '2026-09-20T09:00:00');
    const configure = (yaml: string) => {
      writeFileSync(join(dir, 'cadence.yaml'), yaml);
      git('add', 'cadence.yaml');
      commit(dir, 'chore: configuration', '2026-09-21T09:00:00');
    };
    configure('session:\n  cleanDays: 7\n');
    // Référence à 0 : un échec compté dans les points ouverts ferait passer le verdict à « ✗ pas fermé ».
    const sans = await cad(dir, 'session', 'close');
    expect(sans.code).toBe(0);
    expect(sans.out).toMatch(/\n✓ prêt à fermer$/);
    configure('session:\n  clean: [ "tmp/*" ]\n');
    const { code, out } = await cad(dir, 'session', 'close');
    expect(out).toContain("Nettoyage : parcours interrompu, rien n'est proposé\n  parcours cassé");
    expect(out).toMatch(/\n✓ prêt à fermer$/);
    expect(code).toBe(0);
  });
});
