import { describe, expect, it, vi, afterEach } from 'vitest';
import { execFileSync } from 'node:child_process';

type Projet = { test: Record<string, any> };

// L583 — bords du workspace : bornes de workers (L350) reprises par projet, et partition réelle des fichiers de test.
async function projetsAvec(env: string | undefined): Promise<Projet[]> {
  vi.resetModules();
  if (env === undefined) vi.stubEnv('CADENCE_TEST_WORKERS', undefined as any);
  else vi.stubEnv('CADENCE_TEST_WORKERS', env);
  return (await import('../vitest.workspace.js')).default as unknown as Projet[];
}

afterEach(() => vi.unstubAllEnvs());

describe('L583 bords — vitest.workspace.ts', () => {
  it('CADENCE_TEST_WORKERS=3 : « principal » garde les bornes minForks 1 / maxForks 3', async () => {
    const [principal] = await projetsAvec('3');
    expect(principal.test.poolOptions.forks).toMatchObject({ minForks: 1, maxForks: 3 });
  });

  it.each(['', '0', '-2', 'abc', '2.5'])('CADENCE_TEST_WORKERS=%j : valeur refusée, aucune borne dans « principal »', async (v) => {
    const [principal] = await projetsAvec(v);
    expect(principal.test.poolOptions?.forks?.maxForks).toBeUndefined();
  });

  it('CADENCE_TEST_WORKERS absent : pas de borne, et « lourds » reste à singleFork', async () => {
    const [principal, lourds] = await projetsAvec(undefined);
    expect(principal.test.poolOptions?.forks?.maxForks).toBeUndefined();
    expect(lourds.test.poolOptions.forks.singleFork).toBe(true);
  });

  it('CADENCE_TEST_WORKERS=4 : « lourds » reste à un seul fork', async () => {
    const [, lourds] = await projetsAvec('4');
    expect(lourds.test.poolOptions.forks.singleFork).toBe(true);
  });

  it('la liste réelle des fichiers : chaque fichier de test est joué une seule fois, les deux lourds compris', () => {
    const sortie = execFileSync('npx', ['vitest', 'list', '--filesOnly'], { encoding: 'utf8', env: { ...process.env, CADENCE_TEST_WORKERS: '' } });
    const fichiers = sortie.split('\n').map((l) => l.trim()).filter((l) => /\.test\.ts$/.test(l));
    expect(new Set(fichiers).size).toBe(fichiers.length);
    expect(fichiers.filter((f) => f.endsWith('test/probe-L539-bords.test.ts'))).toHaveLength(1);
    expect(fichiers.filter((f) => f.endsWith('test/mise-en-service.test.ts'))).toHaveLength(1);
  }, 60_000);
});
