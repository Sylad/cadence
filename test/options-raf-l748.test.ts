// Revue L748, note 1 : cadence run (v2/src/run/escalade.ts) relit l'argv d'un `raf review` mis en attente. Il le lisait sans la table d'options de raf :
// `raf --file x.yaml review L1 "non conforme …"` faisait prendre x.yaml pour la commande, et la revue était ignorée. La table vit maintenant dans
// scripts/options-raf.mjs, importée par src/cli/context.ts et par escalade.ts ; sa déclaration (types littéraux, que parseArgs lit) doit dire la même chose.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { OPTIONS_RAF } from '../scripts/options-raf.mjs';
import { parseCli } from '../src/cli/context.js';
import { testPackage } from './helpers.js';

const source = (f: string) => readFileSync(join(import.meta.dirname, '..', f), 'utf8');

/** Les entrées de options-raf.d.mts : `readonly clé: { readonly type: 'x'; readonly multiple: true; … };` */
function declaration(): Record<string, Record<string, unknown>> {
  const d: Record<string, Record<string, unknown>> = {};
  for (const m of source('scripts/options-raf.d.mts').matchAll(/^ {2}readonly '?([\w-]+)'?: \{ (.*) \};$/gm)) {
    d[m[1]!] = Object.fromEntries(m[2]!.split('; ').map((p) => {
      const [k, v] = p.replace(/^readonly /, '').split(': ') as [string, string];
      return [k, v === 'true' ? true : v.replace(/^'|'$/g, '')];
    }));
  }
  return d;
}

describe('raf et cadence run lisent l argv avec la même table d options (revue L748)', () => {
  it('la déclaration options-raf.d.mts a les mêmes clés et les mêmes types que la table', () => {
    expect(declaration()).toEqual(JSON.parse(JSON.stringify(OPTIONS_RAF)));
  });

  it('src/cli/context.ts et v2/src/run/escalade.ts importent la table, aucun ne la recopie', () => {
    expect(source('src/cli/context.ts')).toMatch(/from '\.\.\/\.\.\/scripts\/options-raf\.mjs'/);
    expect(source('v2/src/run/escalade.ts')).toMatch(/from '\.\.\/\.\.\/\.\.\/scripts\/options-raf\.mjs'/);
    for (const f of ['src/cli/context.ts', 'v2/src/run/escalade.ts']) expect(source(f)).not.toMatch(/file: \{ type: 'string' \}/);
    expect(parseCli(['--file', 'x.yaml', 'review', 'L1', 'non conforme', '--vu', 'b'])).toMatchObject({ values: { file: 'x.yaml', vu: 'b' }, positionals: ['review', 'L1', 'non conforme'] });
  });

  it('le module est publié avec le paquet (dist/cli/context.js et v2/dist l importent à l exécution)', () => {
    const files = (JSON.parse(source('package.json')) as { files: string[] }).files;
    expect(files).toEqual(expect.arrayContaining(['scripts/options-raf.mjs', 'scripts/options-raf.d.mts']));
    expect(source('src/orchestrate/snapshot.ts')).toMatch(/'scripts\/options-raf\.mjs', 'scripts\/options-raf\.d\.mts'/);
    expect(readFileSync(join(testPackage(), 'scripts/options-raf.mjs'), 'utf8')).toMatch(/export const OPTIONS_RAF/);
  });
});
