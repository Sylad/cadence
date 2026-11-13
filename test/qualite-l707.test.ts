import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { appliquer, BASELINE, type Mesure } from '../scripts/qualite.mjs';
import { cleanupTempDirs, tempDir } from './helpers.js';

afterAll(cleanupTempDirs);

// L707 : une clé d'un fichier neuf restée au-dessus de sa mesure (gain non figé, ou clé fabriquée sous le total du départ) devenait au lot suivant
// la clé d'un fichier « qui existait » et le laissait grossir jusqu'à elle. La porte exige maintenant qu'un fichier neuf entre dans main à sa mesure.
type Fichiers = Record<string, string>;
const lignes = (n: number, depart = 0, prefixe = 'x') => Array.from({ length: n }, (_, i) => `${prefixe} += ${depart + i};`).join('\n');
const cle = (f: string) => `eslint|${f}|max-lines|total`;
const carte = (m: Record<string, number>): Mesure => Object.fromEntries(Object.entries(m).map(([f, n]) => [cle(f), n]));
const refSur = (base: Mesure, depart: Fichiers) => ({ nom: 'main (abc1234)', base, existe: (c: string) => c in depart, contenu: (c: string) => depart[c] ?? null });
function ecrire(dir: string, fichiers: Fichiers) {
  for (const [f, t] of Object.entries(fichiers)) {
    mkdirSync(join(dir, f, '..'), { recursive: true });
    writeFileSync(join(dir, f), t);
  }
}
const lire = (dir: string) => JSON.parse(readFileSync(join(dir, BASELINE), 'utf8'));

describe('L707 — un fichier neuf entre dans main à sa mesure', () => {
  const depart = carte({ 'src/cli.ts': 1000 });
  const ref = refSur(depart, { 'src/cli.ts': lignes(1000) });
  const fabriquee = carte({ 'src/cli.ts': 350, 'src/x.ts': 650 });

  it('R11 — clé fabriquée à mesure nulle sous le total du départ ({cli.ts:350, x.ts:650}) : la porte refuse, --ecrire la retire, la porte repasse', () => {
    const dir = tempDir();
    ecrire(dir, { 'src/cli.ts': lignes(350, 650), 'src/x.ts': 'const a = 1;' });
    writeFileSync(join(dir, BASELINE), JSON.stringify(fabriquee));
    const mesure = carte({ 'src/cli.ts': 350 });
    const r = appliquer(dir, 'verifier', mesure, ref);
    expect(r.code).toBe(1);
    expect(r.texte).toContain(`${cle('src/x.ts')} : 650 → 0`);
    expect(r.texte).toContain('npm run qualite:cliquet');
    expect(appliquer(dir, 'ecrire', mesure, ref).code).toBe(0);
    expect(lire(dir)).toEqual(mesure);
    expect(appliquer(dir, 'verifier', mesure, ref).code).toBe(0);
  });

  it('au lot suivant, x.ts (qui existait, sans clé) ne peut plus grossir de 0 à 650 lignes', () => {
    const dir = tempDir();
    const suivant = refSur(carte({ 'src/cli.ts': 350 }), { 'src/cli.ts': lignes(350, 650), 'src/x.ts': 'const a = 1;' });
    ecrire(dir, { 'src/cli.ts': lignes(350, 650), 'src/x.ts': lignes(650, 9000, 'y') });
    writeFileSync(join(dir, BASELINE), JSON.stringify(carte({ 'src/cli.ts': 350 })));
    const r = appliquer(dir, 'verifier', carte({ 'src/cli.ts': 350, 'src/x.ts': 650 }), suivant);
    expect(r.code).toBe(1);
    expect(r.texte).toContain(`${cle('src/x.ts')} : 0 → 650`);
  });

  it('R11 — clé fabriquée pour un petit fichier neuf lié à la source (10 lignes copiées, clé 650) : la porte refuse, --ecrire la ramène à sa mesure', () => {
    const dir = tempDir();
    ecrire(dir, { 'src/cli.ts': lignes(350, 650), 'src/x.ts': lignes(10) });
    writeFileSync(join(dir, BASELINE), JSON.stringify(fabriquee));
    const mesure = carte({ 'src/cli.ts': 350, 'src/x.ts': 10 });
    const r = appliquer(dir, 'verifier', mesure, ref);
    expect(r.code).toBe(1);
    expect(r.texte).toContain(`${cle('src/x.ts')} : 650 → 10`);
    expect(appliquer(dir, 'ecrire', mesure, ref).code).toBe(0);
    expect(lire(dir)).toEqual(mesure);
    expect(appliquer(dir, 'verifier', mesure, ref).code).toBe(0);
  });

  it('morceau migré puis supprimé sans figer : la porte demande de figer, --ecrire passe (la base n\'est pas coincée)', () => {
    const dir = tempDir();
    ecrire(dir, { 'src/cli.ts': lignes(350, 650), 'src/cli-plan.ts': lignes(650) });
    writeFileSync(join(dir, BASELINE), JSON.stringify(carte({ 'src/cli.ts': 350, 'src/cli-plan.ts': 650 })));
    rmSync(join(dir, 'src/cli-plan.ts'));
    const sans = carte({ 'src/cli.ts': 350 });
    expect(appliquer(dir, 'verifier', sans, ref).code).toBe(1);
    expect(appliquer(dir, 'ecrire', sans, ref).code).toBe(0);
    expect(appliquer(dir, 'verifier', sans, ref).code).toBe(0);
  });

  it('un fichier qui existait au départ garde son gain non figé : la porte reste verte', () => {
    const dir = tempDir();
    ecrire(dir, { 'src/cli.ts': lignes(300) });
    writeFileSync(join(dir, BASELINE), JSON.stringify(carte({ 'src/cli.ts': 350 })));
    expect(appliquer(dir, 'verifier', carte({ 'src/cli.ts': 300 }), ref).code).toBe(0);
  });

  it('sans --contre, rien ne distingue un fichier neuf : la porte locale reste verte', () => {
    const dir = tempDir();
    writeFileSync(join(dir, BASELINE), JSON.stringify(fabriquee));
    expect(appliquer(dir, 'verifier', carte({ 'src/cli.ts': 350 }), null).code).toBe(0);
  });
});
