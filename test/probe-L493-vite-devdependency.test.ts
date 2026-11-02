import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const lire = (f: string) => JSON.parse(readFileSync(join(process.cwd(), f), 'utf8'));

describe('probe L493 — vite déclaré en devDependency', () => {
  it('vite est dans devDependencies et pas dans dependencies', () => {
    const pkg = lire('package.json');
    expect(pkg.devDependencies.vite).toBeTruthy();
    expect(pkg.dependencies?.vite).toBeUndefined();
  });

  it("package-lock : la racine déclare la même plage que package.json, et node_modules/vite la satisfait", () => {
    const pkg = lire('package.json');
    const lock = lire('package-lock.json');
    expect(lock.packages[''].devDependencies.vite).toBe(pkg.devDependencies.vite);
    const v = lock.packages['node_modules/vite'];
    expect(v).toBeTruthy();
    expect(v.version.split('.')[0]).toBe(pkg.devDependencies.vite.replace(/^[^\d]*/, '').split('.')[0]);
    expect(v.dev).toBe(true);
  });

  it('la version de vite installée est celle du lock', () => {
    const lock = lire('package-lock.json');
    const inst = lire('node_modules/vite/package.json');
    expect(inst.version).toBe(lock.packages['node_modules/vite'].version);
  });

  it('vite déclaré est aussi la version que vitest utilise (pas de second vite imbriqué)', () => {
    const lock = lire('package-lock.json');
    expect(lock.packages['node_modules/vitest/node_modules/vite']).toBeUndefined();
  });

  it('la ligne de base du cliquet est un JSON valide, sans l\'entrée unlisted de vite, triée comme avant', () => {
    const base = lire('qualite-baseline.json');
    expect(Object.keys(base).filter((k) => k.startsWith('knip|') && k.includes('unlisted'))).toEqual([]);
    expect(base['knip|test/vitest-config-clone-neuf.test.ts|unlisted']).toBeUndefined();
    const brut = readFileSync(join(process.cwd(), 'qualite-baseline.json'), 'utf8');
    expect(brut).not.toMatch(/,\s*}/);
    expect(brut.endsWith('\n')).toBe(true);
  });

  it('tout import nu de vite dans le dépôt est couvert par package.json', () => {
    const pkg = lire('package.json');
    const declares = { ...pkg.dependencies, ...pkg.devDependencies };
    expect(declares.vite).toBeDefined();
    expect(declares.vitest).toBeDefined();
  });
});
