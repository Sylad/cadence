import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

// 2.0.1 publiée sans v2/briefs/bras-A.md : tout cadence run en mode léger plantait chez un utilisateur npm.
// Ce que cadence run lit à l'exécution doit être dans le paquet, et la mise en service doit compiler v2/ comme prepare.
const root = join(import.meta.dirname, '..');
const lire = (f: string) => readFileSync(join(root, f), 'utf8');

describe('paquet : tout ce que cadence run lit est publié', () => {
  const publies = (): string[] => {
    const sortie = execFileSync('npm', ['pack', '--dry-run', '--json', '--ignore-scripts'], { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
    const j = JSON.parse(sortie) as { files: { path: string }[] }[] | Record<string, { files: { path: string }[] }>; // npm 10 : un tableau ; npm 11 : un objet par paquet
    return (Array.isArray(j) ? j[0] : Object.values(j)[0]).files.map((f) => f.path);
  };
  it('chaque brief et chaque réglage nommés par l aiguillage, le hook de lecture et le point d entrée de v2', () => {
    const src = lire('v2/src/run/aiguillage.ts');
    const noms = [...src.matchAll(/'((?:bras-[\w-]+\.md)|(?:settings-[\w-]+\.json))'/g)].map((m) => `v2/briefs/${m[1]}`);
    expect(noms.length).toBeGreaterThanOrEqual(3);
    const fichiers = publies();
    for (const f of [...noms, 'v2/hooks/lecture-obligatoire.mjs', 'v2/hooks/lecture.mjs', 'bin/cadence.js'])
      expect(fichiers, f).toContain(f);
    expect(lire('package.json')).toContain('"v2/dist"');
  }, 60_000);
  it('la mise en service compile v2/ comme prepare', () => {
    expect(JSON.parse(lire('package.json')).scripts.prepare).toContain('tsc -p v2/tsconfig.json');
    expect(lire('scripts/mise-en-service.mjs')).toContain("'tsc', '-p', 'v2/tsconfig.json'");
  });
});
