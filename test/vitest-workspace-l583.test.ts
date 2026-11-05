import { describe, expect, it } from 'vitest';
import { loadConfigFromFile } from 'vite';
import { join } from 'node:path';
import { existsSync } from 'node:fs';

type Projet = { test: Record<string, any> };

// L583 : deux projets vitest. « lourds » (probe-L539-bords, mise-en-service L195) mesurés par L579 : 2 à 3 s seuls, 12 à 13 s sous une charge
// moyenne de 127 ; joués après les autres dans un seul fork, ils ne se disputent plus la machine avec le reste de la suite.
const LOURDS = ['test/probe-L539-bords.test.ts', 'test/mise-en-service.test.ts'];

async function projets(): Promise<Projet[]> {
  return (await import('../vitest.workspace.js')).default as unknown as Projet[];
}
const nom = (p: Projet) => p.test.name as string;

describe('L583 — vitest.workspace.ts : deux projets, les lourds joués après les autres dans un seul fork', () => {
  it('R1 — le workspace a deux projets, « principal » et « lourds »', async () => {
    expect((await projets()).map(nom)).toEqual(['principal', 'lourds']);
  });

  it('R2 — « lourds » joue exactement probe-L539-bords et mise-en-service', async () => {
    const lourds = (await projets()).find((p) => nom(p) === 'lourds')!;
    expect([...lourds.test.include].sort()).toEqual([...LOURDS].sort());
  });

  it('R3 — « lourds » tourne dans un seul fork, après les autres projets', async () => {
    const [principal, lourds] = (await projets()) as Projet[];
    expect(lourds.test.poolOptions.forks.singleFork).toBe(true);
    expect(lourds.test.pool).toBe('forks');
    // vitest 2 joue les projets multi-forks d'abord, puis les fichiers d'un projet à singleFork l'un après l'autre : « principal » ne doit pas l'être.
    expect(principal.test.poolOptions?.forks?.singleFork).toBeFalsy();
  });

  it('R4 — « principal » ne joue pas les lourds, et chaque test de la suite est joué par un projet et un seul', async () => {
    const [principal, lourds] = (await projets()) as Projet[];
    for (const f of LOURDS) {
      expect(principal.test.exclude).toContain(f);
      expect(existsSync(join(process.cwd(), f))).toBe(true); // le fichier existe : un renommage ne vide pas « lourds » en silence
    }
    expect(principal.test.exclude).toEqual(expect.arrayContaining(['plugins/**', '**/node_modules/**']));
    expect(lourds.test.include.filter((f: string) => principal.test.exclude.includes(f))).toHaveLength(LOURDS.length);
  });

  it('R5 — chaque projet reprend le réglage de vitest.config.ts (tsconfigRaw, délais, setup, workers) sans le globalSetup, porté une seule fois par la racine', async () => {
    const racine = (await loadConfigFromFile({ command: 'serve', mode: 'test' }, join(process.cwd(), 'vitest.config.ts')))!.config as any;
    expect(racine.test.globalSetup).toEqual(['test/global-setup.ts']);
    for (const p of (await projets()) as any[]) {
      expect(p.esbuild.tsconfigRaw).toBe('{}');
      expect(p.test.testTimeout).toBe(racine.test.testTimeout);
      expect(p.test.hookTimeout).toBe(racine.test.hookTimeout);
      expect(p.test.setupFiles).toEqual(racine.test.setupFiles);
      expect(p.test.globalSetup).toBeUndefined();
    }
  });
});
