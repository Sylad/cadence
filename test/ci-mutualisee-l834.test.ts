import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

// L834 (D-33) : la CI tests.yml jouait ~55 min par push, la suite 4 fois (npm test puis sous npm publish --dry-run, × Node 22 et 24),
// et chaque push sur main jouait son run en entier même dépassé par le suivant.
const root = join(import.meta.dirname, '..');
const wf = readFileSync(join(root, '.github/workflows/tests.yml'), 'utf8');
const publish = readFileSync(join(root, '.github/workflows/publish.yml'), 'utf8');
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
// Les commandes des étapes, commentaires retirés.
const commandes = wf.split('\n').filter((l) => !l.trim().startsWith('#')).join('\n');

describe('CI tests mutualisée (L834)', () => {
  it('R1 — un seul run par rafale : groupe de concurrence par branche, le run dépassé est annulé', () => {
    expect(wf).toMatch(/^concurrency:\n\s+group: tests-\$\{\{ github\.ref \}\}\n\s+cancel-in-progress: true$/m);
  });

  it('R2 — publish.yml garde son propre groupe, jamais annulé (une publication en cours ne s’interrompt pas)', () => {
    expect(publish).toMatch(/group: publish-\$\{\{ github\.ref \}\}\n\s+cancel-in-progress: false/);
    expect(publish).not.toContain('group: tests-');
  });

  it('R3 — la suite est jouée une seule fois par version de Node : un `npm test`, aucun prepublishOnly rejoué', () => {
    expect(commandes.match(/run: npm test\b/g)).toHaveLength(1);
    const publishes = commandes.match(/\$\(npm publish[^)]*\)/g) ?? [];
    expect(publishes.length).toBeGreaterThan(0);
    for (const p of publishes) expect(p).toContain('--ignore-scripts');
    expect(commandes).not.toMatch(/npm run prepublishOnly|npm pack(?![^\n]*--ignore-scripts)/);
  });

  it('R4 — ce que prepublishOnly garantissait reste joué une fois, avant le contrôle du paquet : typecheck, cliquet, suite', () => {
    expect(pkg.scripts.prepublishOnly).toBe('npm run typecheck && npm run qualite && npm test');
    const at = (s: string) => commandes.indexOf(s);
    expect(at('run: npm run typecheck')).toBeGreaterThan(0);
    expect(at('run: npm run qualite -- --contre origin/main')).toBeGreaterThan(at('run: npm run typecheck'));
    expect(at('run: npm test')).toBeGreaterThan(at('run: npm run qualite'));
    expect(at('- name: Paquet sous npm publish --dry-run')).toBeGreaterThan(at('run: npm test'));
  });

  it('R5 — le paquet contrôlé est celui que npm ci a construit : npm ci avant le dry-run, matrice Node 22 et 24 inchangée', () => {
    expect(commandes.indexOf('run: npm ci')).toBeGreaterThan(0);
    expect(commandes.indexOf('run: npm ci')).toBeLessThan(commandes.indexOf('npm publish --dry-run'));
    expect(pkg.scripts.prepare).toMatch(/tsc -p tsconfig\.build\.json/);
    expect(wf).toMatch(/matrix:\n\s+node:\s*\[22, 24\]/);
  });

  it('R6 — le commentaire dit où le rejeu de la suite dans le cycle de npm publish est encore fait', () => {
    const avant = wf.slice(0, wf.indexOf('- name: Paquet sous npm publish --dry-run'));
    expect(avant).toMatch(/cadence release/);
    expect(avant).toMatch(/publish\.yml/);
  });
});
