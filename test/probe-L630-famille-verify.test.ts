import { describe, expect, it } from 'vitest';
import { join } from 'node:path';
import { existsSync, readdirSync } from 'node:fs';

type Projet = { test: Record<string, any> };

async function projets(): Promise<Projet[]> {
  return (await import('../vitest.workspace.js')).default as unknown as Projet[];
}

describe('probe L630 — la famille verify* dans « lourds »', () => {
  it('« lourds » n\'a aucun doublon et chaque fichier existe', async () => {
    const lourds = (await projets()).find((p) => p.test.name === 'lourds')!;
    const inc: string[] = lourds.test.include;
    expect(new Set(inc).size).toBe(inc.length);
    for (const f of inc) expect(existsSync(join(process.cwd(), f)), f).toBe(true);
  });

  it('tout test/verify*.test.ts est joué par « lourds » et exclu de « principal »', async () => {
    const [principal, lourds] = await projets();
    const verify = readdirSync(join(process.cwd(), 'test')).filter((f) => /^verify.*\.test\.ts$/.test(f)).map((f) => `test/${f}`);
    expect(verify.length).toBeGreaterThan(0);
    for (const f of verify) {
      expect(lourds.test.include, f).toContain(f);
      expect(principal.test.exclude, f).toContain(f);
    }
    expect(lourds.test.include).toContain('test/porte-deportee-creneau-l624.test.ts');
  });
});
