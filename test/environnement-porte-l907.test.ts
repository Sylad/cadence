// L907 : le 26-11, verify --gate fbc8dd08 de maritime a vu services/api mais pas frontend/node_modules en retard (maplibre-gl 5.24.0 installé, 6.19.0 au
// package-lock.json) : rouges trompeurs. Chaque package-lock.json du dépôt est comparé à son node_modules voisin, au moins par la version installée
// (node_modules/<nom>/package.json) de chaque dépendance directe, même sans lockfile caché.
import { afterEach, describe, expect, it } from 'vitest';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { ecartsLockfile, environnementPerime } from '../scripts/environnement-porte.mjs';
import { cleanupTempDirs, tempDir } from './helpers.js';

afterEach(cleanupTempDirs);

/** Un projet npm : package-lock.json v3 dont les dépendances directes sont `directes`, et node_modules/<nom>/package.json pour chaque paquet `installe`. */
function projet(d: string, directes: Record<string, string>, installe: Record<string, string>): string {
  mkdirSync(join(d, 'node_modules'), { recursive: true });
  const packages: Record<string, unknown> = { '': { name: 'x', dependencies: Object.fromEntries(Object.keys(directes).map((n) => [n, `^${directes[n]}`])) } };
  for (const [n, v] of Object.entries(directes)) packages[`node_modules/${n}`] = { version: v };
  writeFileSync(join(d, 'package-lock.json'), JSON.stringify({ lockfileVersion: 3, packages }));
  writeFileSync(join(d, 'package.json'), JSON.stringify({ name: 'x' }));
  for (const [n, v] of Object.entries(installe)) {
    mkdirSync(join(d, 'node_modules', n), { recursive: true });
    writeFileSync(join(d, 'node_modules', n, 'package.json'), JSON.stringify({ name: n, version: v }));
  }
  return d;
}

describe('L907 : chaque package-lock.json du dépôt, chaque dépendance directe', () => {
  it('deux package-lock.json dont un seul en retard (cas maritime) : seul frontend est signalé, avec sa remise à niveau', () => {
    const racine = tempDir();
    projet(join(racine, 'services', 'api'), { '@nestjs/core': '11.1.0' }, { '@nestjs/core': '11.1.0' });
    const front = projet(join(racine, 'frontend'), { 'maplibre-gl': '6.19.0', '@angular/core': '19.2.0' }, { 'maplibre-gl': '5.24.0', '@angular/core': '19.2.0' });
    const p = environnementPerime(racine, process.env, null);
    expect(p).toHaveLength(1);
    expect(p[0].probleme).toBe('frontend/node_modules n\'est pas à jour de frontend/package-lock.json (1 écart(s) : maplibre-gl 5.24.0 installé, 6.19.0 au lockfile)');
    expect(p[0].remede).toBe(`cd ${front} && npm ci`);
  });

  it('sans lockfile caché, une dépendance directe absente compte ; à jour, rien', () => {
    const d = projet(join(tempDir(), 'p'), { 'maplibre-gl': '6.19.0' }, {});
    expect(ecartsLockfile(d)).toEqual(['maplibre-gl absent (6.19.0 au lockfile)']);
    const ok = projet(join(tempDir(), 'q'), { 'maplibre-gl': '6.19.0' }, { 'maplibre-gl': '6.19.0' });
    expect(ecartsLockfile(ok)).toEqual([]);
  });

  it('lockfile caché à jour mais package.json installé en retard : le retard réel est dit, une seule fois', () => {
    const d = projet(join(tempDir(), 'p'), { 'maplibre-gl': '6.19.0' }, { 'maplibre-gl': '5.24.0' });
    writeFileSync(join(d, 'node_modules', '.package-lock.json'), JSON.stringify({ lockfileVersion: 3, packages: { 'node_modules/maplibre-gl': { version: '6.19.0' } } }));
    expect(ecartsLockfile(d)).toEqual(['maplibre-gl 5.24.0 installé, 6.19.0 au lockfile']);
  });

  it('un package-lock.json au-delà de trois niveaux est lu ; ceux sous node_modules ou un dossier caché ne le sont pas', () => {
    const racine = tempDir();
    projet(join(racine, 'apps', 'web', 'packages', 'carte'), { 'maplibre-gl': '6.19.0' }, { 'maplibre-gl': '5.24.0' });
    projet(join(racine, 'node_modules', 'vendu'), { a: '2.0.0' }, { a: '1.0.0' });
    projet(join(racine, '.cache', 'x'), { a: '2.0.0' }, { a: '1.0.0' });
    const p = environnementPerime(racine, process.env, null);
    expect(p.map((x) => x.probleme)).toEqual(['apps/web/packages/carte/node_modules n\'est pas à jour de apps/web/packages/carte/package-lock.json (1 écart(s) : maplibre-gl 5.24.0 installé, 6.19.0 au lockfile)']);
  });
});

describe('L907 : la version lue est celle que Node résout', () => {
  it('un node_modules qui ne garde que des caches (v2/ de cadence) : la dépendance est trouvée au-dessus, à jour ou en retard', () => {
    const racine = tempDir();
    projet(racine, { yaml: '2.9.1' }, { yaml: '2.9.1' });
    const v2 = projet(join(racine, 'v2'), { yaml: '2.9.1', vitest: '2.1.9' }, {});
    mkdirSync(join(v2, 'node_modules', '.vite'));
    expect(ecartsLockfile(v2)).toEqual(['vitest absent (2.1.9 au lockfile)']);
    projet(racine, { yaml: '2.9.1', vitest: '2.1.9' }, { vitest: '2.1.8' });
    expect(ecartsLockfile(v2)).toEqual(['vitest 2.1.8 installé, 2.1.9 au lockfile']);
  });
});
