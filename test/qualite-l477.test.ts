import { spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, readFileSync, renameSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';
import { appliquer, BASELINE, comparer, comparerMigration, creerLien, lireRef, type Mesure } from '../scripts/qualite.mjs';
import { cleanupTempDirs, tempDir } from './helpers.js';

const REPO = fileURLToPath(new URL('..', import.meta.url));
afterAll(cleanupTempDirs);

type Fichiers = Record<string, string>;
const lignes = (n: number, depart = 0, prefixe = 'x') => Array.from({ length: n }, (_, i) => `${prefixe} += ${depart + i};`).join('\n');
const cle = (f: string, regle = 'max-lines') => `eslint|${f}|${regle}|total`;
const carte = (m: Record<string, number>, regle = 'max-lines'): Mesure => Object.fromEntries(Object.entries(m).map(([f, n]) => [cle(f, regle), n]));
const existant = (...fs: string[]) => (c: string) => fs.includes(c);
/** Le lien sur des contenus donnés : `depart` (point de départ), `courant` (arbre ou commit contrôlé). */
const lienSur = (base: Mesure, depart: Fichiers, courant: Fichiers) => creerLien(base, { depart: (c) => depart[c] ?? null, courant: (c) => courant[c] ?? null, neuf: (c) => courant[c] ?? null });
const noms = (p: { cle: string }[]) => p.map((x) => x.cle);

describe('L477 — le crédit d\'un fichier neuf', () => {
  const cli = lignes(1000);
  const depart = carte({ 'src/cli.ts': 1000 });

  it('R1 — trois fonctions de complexité 463, 20 et 18 dont la troisième passe à 400 : le total monte et la comparaison refuse', () => {
    const [a, b] = [{ 'eslint|f.ts|complexity': 3, 'eslint|f.ts|complexity|total': 501 }, { 'eslint|f.ts|complexity': 3, 'eslint|f.ts|complexity|total': 883 }];
    expect(comparer(a, b).pires.map((p) => p.cle)).toEqual(['eslint|f.ts|complexity|total']);
  });

  it('R2 — le total qui monte est refusé et nomme « … (total, tous fichiers) »', () => {
    const p = comparerMigration(carte({ 'src/a.ts': 10 }), carte({ 'src/a.ts': 10, 'src/n.ts': 5 }), existant('src/a.ts'), () => null);
    expect(noms(p)).toContain('eslint|max-lines|total (total, tous fichiers)');
  });

  it('R2 — une clé d\'un fichier qui existait qui monte est refusée même si le total baisse', () => {
    const p = comparerMigration(carte({ 'src/a.ts': 10, 'src/b.ts': 10 }), carte({ 'src/a.ts': 12, 'src/b.ts': 1 }), existant('src/a.ts', 'src/b.ts'), () => null);
    expect(noms(p)).toEqual([cle('src/a.ts')]);
  });

  it('R3 — fichier neuf de 650 lignes sans parenté et fichier ancien de 700 corrigé à 0 : le fichier neuf est refusé alors que le total baisse', () => {
    const p = comparerMigration(carte({ 'src/a.ts': 700 }), carte({ 'src/n.ts': 650 }), existant('src/a.ts'), lienSur(carte({ 'src/a.ts': 700 }), { 'src/a.ts': lignes(700) }, { 'src/n.ts': lignes(650, 9000, 'y') }));
    expect(p).toEqual([expect.objectContaining({ cle: cle('src/n.ts'), avant: 0, apres: 650 })]);
  });

  it('R3 — un morceau lié de 400 et un fichier neuf sans lien de 600 pour une source qui a perdu 1000 : le fichier sans lien est refusé', () => {
    const base = carte({ 'src/cli.ts': 1000 });
    const lien = lienSur(base, { 'src/cli.ts': cli }, { 'src/morceau.ts': lignes(400), 'src/libre.ts': lignes(600, 9000, 'y') });
    const p = comparerMigration(base, carte({ 'src/morceau.ts': 400, 'src/libre.ts': 600 }), existant('src/cli.ts'), lien);
    expect(noms(p)).toEqual([cle('src/libre.ts')]);
  });

  it('R3 — deux morceaux liés à la même source dont la somme (700) dépasse sa perte (650) : refusés', () => {
    const base = carte({ 'src/cli.ts': 1000 });
    const lien = lienSur(base, { 'src/cli.ts': cli }, { 'src/cli.ts': lignes(350, 650), 'src/m1.ts': lignes(350), 'src/m2.ts': lignes(350, 350) });
    const p = comparerMigration(base, carte({ 'src/cli.ts': 350, 'src/m1.ts': 350, 'src/m2.ts': 350 }), existant('src/cli.ts'), lien);
    expect(noms(p)).toEqual(expect.arrayContaining([cle('src/m1.ts'), cle('src/m2.ts')]));
    expect(noms(p)).not.toContain(cle('src/cli.ts'));
  });

  it('R3 — découper 3047 lignes en trois de 1000 liés à la source passe toujours', () => {
    const gros = lignes(3047);
    const base = carte({ 'src/gros.ts': 3047 });
    const courant = { 'src/gros.ts': lignes(47, 3000), 'a.ts': lignes(1000), 'b.ts': lignes(1000, 1000), 'c.ts': lignes(1000, 2000) };
    const apres = carte({ 'src/gros.ts': 47, 'a.ts': 1000, 'b.ts': 1000, 'c.ts': 1000 });
    const lien = lienSur(base, { 'src/gros.ts': gros }, courant);
    expect(comparerMigration(base, apres, existant('src/gros.ts'), lien)).toEqual([]);
  });

  it('R4 — un fichier de 1000 lignes renommé à l\'identique (git mv) : accepté', () => {
    const lien = lienSur(depart, { 'src/cli.ts': cli }, { 'src/neuf.ts': cli });
    expect(comparerMigration(depart, carte({ 'src/neuf.ts': 1000 }), existant('src/cli.ts'), lien)).toEqual([]);
  });

  it('R4 — un fichier coupé en deux morceaux de 600 et 300 : accepté', () => {
    const lien = lienSur(depart, { 'src/cli.ts': cli }, { 'src/cli.ts': lignes(100, 900), 'src/m1.ts': lignes(600), 'src/m2.ts': lignes(300, 600) });
    expect(comparerMigration(depart, carte({ 'src/cli.ts': 100, 'src/m1.ts': 600, 'src/m2.ts': 300 }), existant('src/cli.ts'), lien)).toEqual([]);
  });

  it('R4 — un morceau d\'un chiffre au-dessus de la perte (601 pour 600) : refusé', () => {
    const lien = lienSur(depart, { 'src/cli.ts': cli }, { 'src/cli.ts': lignes(400, 600), 'src/m.ts': lignes(600) });
    const p = comparerMigration(depart, carte({ 'src/cli.ts': 400, 'src/m.ts': 601 }), existant('src/cli.ts'), lien);
    expect(noms(p)).toContain(cle('src/m.ts'));
  });

  it('R5 — fonction de complexité 30 déplacée avec le reste de son fichier copié (lié par le contenu), la source garde une autre fonction en défaut : acceptée', () => {
    const src = `${lignes(20, 0, 'a')}\n${lignes(20, 0, 'f')}`;
    const base = carte({ 'src/s.ts': 30 + 20 }, 'complexity');
    const courant = { 'src/s.ts': lignes(20, 0, 'a'), 'src/n.ts': lignes(20, 0, 'f') };
    const lien = lienSur(base, { 'src/s.ts': src }, courant);
    expect(comparerMigration(base, carte({ 'src/s.ts': 20, 'src/n.ts': 30 }, 'complexity'), existant('src/s.ts'), lien)).toEqual([]);
  });

  it('R5 — le même déplacement avec une fonction qui a grossi au passage (31 pour 30 perdus) : refusé', () => {
    const src = `${lignes(20, 0, 'a')}\n${lignes(20, 0, 'f')}`;
    const base = carte({ 'src/s.ts': 50 }, 'complexity');
    const lien = lienSur(base, { 'src/s.ts': src }, { 'src/s.ts': lignes(20, 0, 'a'), 'src/n.ts': lignes(20, 0, 'f') });
    const p = comparerMigration(base, carte({ 'src/s.ts': 20, 'src/n.ts': 31 }, 'complexity'), existant('src/s.ts'), lien);
    expect(noms(p)).toContain(cle('src/n.ts', 'complexity'));
  });

  it('R5 — source corrigée et figée par --ecrire avant le découpage : sa perte depuis le départ crédite encore le morceau lié', () => {
    // la base du lot (avant) est à 400 pour cli.ts ; le gain de 100 d'un autre fichier paie le total, mais seule la perte de cli.ts depuis le départ (1000) crédite le morceau
    const avant = { ...carte({ 'src/cli.ts': 400, 'src/autre.ts': 100 }) };
    const apres = carte({ 'src/cli.ts': 350, 'src/m.ts': 150 });
    const lien = lienSur(depart, { 'src/cli.ts': cli }, { 'src/cli.ts': lignes(350, 650), 'src/m.ts': lignes(150) });
    expect(comparerMigration(avant, apres, existant('src/cli.ts', 'src/autre.ts'), lien, { ...depart, ...carte({ 'src/autre.ts': 100 }) })).toEqual([]);
    expect(noms(comparerMigration(avant, apres, existant('src/cli.ts', 'src/autre.ts'), lien, avant))).toEqual([cle('src/m.ts')]);
  });

  it('R6 — cli.ts de 1000 lignes ramené à 350 et cli-plan.ts de 650 lignes copiées de cli.ts : accepté, la perte de cli.ts crédite cli-plan.ts', () => {
    const lien = lienSur(depart, { 'src/cli.ts': cli }, { 'src/cli.ts': lignes(350, 650), 'src/cli-plan.ts': lignes(650) });
    expect(lien('src/cli-plan.ts')).toBe('src/cli.ts');
    expect(comparerMigration(depart, carte({ 'src/cli.ts': 350, 'src/cli-plan.ts': 650 }), existant('src/cli.ts'), lien)).toEqual([]);
  });

  it('R6 — le même découpage où cli-plan.ts réécrit le code (moins de 50 % de ses lignes figuraient dans cli.ts) : refusé, le message nomme cli-plan.ts et cli.ts', () => {
    const dir = tempDir();
    const neuf = `${lignes(300)}\n${lignes(350, 9000, 'y')}`; // 300 lignes sur 650 : 46 %
    ecrire(dir, { 'src/cli.ts': lignes(350, 650), 'src/cli-plan.ts': neuf });
    writeFileSync(join(dir, BASELINE), JSON.stringify(carte({ 'src/cli.ts': 1000 })));
    const r = appliquer(dir, 'migrer', carte({ 'src/cli.ts': 350, 'src/cli-plan.ts': 650 }), refSur(depart, { 'src/cli.ts': cli }));
    expect(r.code).toBe(1);
    expect(r.texte).toContain('src/cli-plan.ts');
    expect(r.texte).toContain('aucune source');
    expect(readFileSync(join(dir, BASELINE), 'utf8')).toBe(JSON.stringify(carte({ 'src/cli.ts': 1000 })));
  });

  it('R6 — fichier de 700 lignes corrigé à 0 et fichier neuf de 650 lignes sans parenté : refusé, le message nomme le fichier neuf et « aucune source »', () => {
    const dir = tempDir();
    const base = carte({ 'src/a.ts': 700 });
    ecrire(dir, { 'src/a.ts': 'rien();', 'src/n.ts': lignes(650, 9000, 'y') });
    writeFileSync(join(dir, BASELINE), JSON.stringify(base));
    const r = appliquer(dir, 'migrer', carte({ 'src/n.ts': 650 }), refSur(base, { 'src/a.ts': lignes(700) }));
    expect(r.code).toBe(1);
    expect(r.texte).toMatch(/src\/n\.ts\|max-lines\|total : 0 → 650 .*aucune source/);
  });

  it('R6 — fichier corrigé sans fichier neuf : --ecrire fige le gain', () => {
    const dir = tempDir();
    writeFileSync(join(dir, BASELINE), JSON.stringify(carte({ 'src/a.ts': 700 })));
    expect(appliquer(dir, 'ecrire', {}, refSur(carte({ 'src/a.ts': 700 }), { 'src/a.ts': lignes(700) })).code).toBe(0);
    expect(JSON.parse(readFileSync(join(dir, BASELINE), 'utf8'))).toEqual({});
  });

  it('R7 — un fichier neuf à 0 n\'est pas refusé et n\'entre pas dans la somme', () => {
    const lien = () => { throw new Error('aucun lien ne se calcule pour un fichier à 0'); };
    expect(comparerMigration(carte({ 'src/a.ts': 10 }), carte({ 'src/a.ts': 10, 'src/n.ts': 0 }), existant('src/a.ts'), lien)).toEqual([]);
  });

  it('R7 — le nombre de dépassements d\'un fichier neuf n\'est pas ajouté à la somme des chiffres', () => {
    const base = carte({ 'src/cli.ts': 1000 });
    const lien = lienSur(base, { 'src/cli.ts': cli }, { 'src/n.ts': cli });
    const apres = { ...carte({ 'src/n.ts': 1000 }), 'eslint|src/n.ts|max-lines': 7 };
    expect(comparerMigration({ ...base, 'eslint|src/cli.ts|max-lines': 1 }, apres, existant('src/cli.ts'), lien)).toEqual([]);
  });
});

describe('L477 — le lien de contenu', () => {
  const src = lignes(1000);
  const base = carte({ 'src/s.ts': 1000, 'src/t.ts': 1000 });

  it('R14 — petite fonction de 12 lignes déplacée d\'une grosse source (1000 lignes) vers un petit fichier neuf : liée, acceptée', () => {
    const lien = lienSur(base, { 'src/s.ts': src }, { 'src/s.ts': lignes(988, 12), 'src/p.ts': lignes(12) });
    expect(lien('src/p.ts')).toBe('src/s.ts');
    expect(comparerMigration(carte({ 'src/s.ts': 1000 }), carte({ 'src/s.ts': 988, 'src/p.ts': 12 }), existant('src/s.ts'), lien)).toEqual([]);
  });

  it('R14 — fichier neuf dont 49 % des lignes viennent de la source : non lié, refusé ; à 50 % : lié', () => {
    const dep = { 'src/s.ts': lignes(100) };
    const cour = (n: number) => ({ 'src/s.ts': '', 'src/n.ts': `${lignes(n)}\n${lignes(100 - n, 9000, 'y')}` });
    expect(lienSur(base, dep, cour(49))('src/n.ts')).toBeNull();
    expect(lienSur(base, dep, cour(50))('src/n.ts')).toBe('src/s.ts');
  });

  it('R14 — fichier neuf dont les lignes viennent de deux sources : lié à celle qui en a perdu le plus', () => {
    const dep = { 'src/s.ts': lignes(100), 'src/t.ts': lignes(100, 500) };
    const cour = { 'src/s.ts': '', 'src/t.ts': '', 'src/n.ts': `${lignes(40)}\n${lignes(60, 500)}` };
    expect(lienSur(base, dep, cour)('src/n.ts')).toBe('src/t.ts');
  });

  it('R14 — les lignes vides et les espaces de bord ne comptent pas : un fichier réindenté reste lié', () => {
    const lien = lienSur(base, { 'src/s.ts': `a();\n\n  b();\n` }, { 'src/s.ts': '', 'src/n.ts': '\n    a();\nb();   \n\n' });
    expect(lien('src/n.ts')).toBe('src/s.ts');
  });

  it('R14 — un fichier neuf illisible ou vide n\'est lié à rien', () => {
    expect(lienSur(base, { 'src/s.ts': src }, {})('src/absent.ts')).toBeNull();
    expect(lienSur(base, { 'src/s.ts': src }, { 'src/vide.ts': '\n\n' })('src/vide.ts')).toBeNull();
  });

  it('R16 — deux fichiers neufs et la même source : un seul git show de cette source (cache)', () => {
    const lus: string[] = [];
    const lien = creerLien(carte({ 'src/s.ts': 10 }), { depart: (c) => { lus.push(c); return lignes(10); }, courant: () => '', neuf: () => lignes(10) });
    lien('src/n1.ts');
    lien('src/n2.ts');
    expect(lus).toEqual(['src/s.ts']);
  });

  it('R16 — dépôt sans fichier neuf qui porte un chiffre : aucun git show lancé', () => {
    const lien = () => { throw new Error('git show lancé'); };
    expect(comparerMigration(carte({ 'src/a.ts': 10 }), carte({ 'src/a.ts': 5 }), existant('src/a.ts'), lien)).toEqual([]);
    const lus: string[] = [];
    const vrai = creerLien(carte({ 'src/s.ts': 10 }), { depart: (c) => { lus.push(c); return ''; }, courant: () => '', neuf: () => '' });
    comparerMigration(carte({ 'src/a.ts': 10 }), { ...carte({ 'src/a.ts': 5, 'src/z.ts': 0 }) }, existant('src/a.ts'), vrai);
    expect(lus).toEqual([]);
  });

  it('R16 — un fichier de la base du départ absent de l\'arbre du départ n\'est pas une source', () => {
    const lien = lienSur(carte({ 'src/fantome.ts': 10 }), {}, { 'src/n.ts': lignes(10) });
    expect(lien('src/n.ts')).toBeNull();
  });
});

describe('L477 — la source doit avoir perdu les lignes', () => {
  const dep = lignes(100);
  const base = carte({ 'src/s.ts': 100 });

  it('R18 — fonction A de la source corrigée et fonction B copiée en défaut dans un fichier neuf sans que la source la perde : refusé', () => {
    const departS = `${lignes(50, 0, 'a')}\n${lignes(50, 0, 'b')}`;
    const courant = { 'src/s.ts': lignes(50, 0, 'b'), 'src/n.ts': lignes(50, 0, 'b') }; // a corrigée, b copiée et gardée
    const lien = lienSur(base, { 'src/s.ts': departS }, courant);
    expect(lien('src/n.ts')).toBeNull();
    const p = comparerMigration(base, carte({ 'src/s.ts': 50, 'src/n.ts': 40 }), existant('src/s.ts'), lien);
    expect(p).toEqual([expect.objectContaining({ cle: cle('src/n.ts'), note: expect.stringContaining('aucune source') })]);
  });

  it('R18 — coupe où la source perd les lignes copiées : accepté', () => {
    const lien = lienSur(base, { 'src/s.ts': dep }, { 'src/s.ts': lignes(40, 60), 'src/n.ts': lignes(60) });
    expect(comparerMigration(base, carte({ 'src/s.ts': 40, 'src/n.ts': 60 }), existant('src/s.ts'), lien)).toEqual([]);
  });

  it('R18 — copie dont la source ne perd que 49 % des lignes du fichier neuf : refusée ; 50 % : acceptée', () => {
    const neuf = lignes(100);
    const copie = (perdues: number) => lienSur(base, { 'src/s.ts': dep }, { 'src/s.ts': lignes(100 - perdues, perdues), 'src/n.ts': neuf })('src/n.ts');
    expect(copie(49)).toBeNull();
    expect(copie(50)).toBe('src/s.ts');
  });

  it('R18 — source supprimée (renommage) : toutes ses lignes sont perdues, accepté', () => {
    const lien = lienSur(base, { 'src/s.ts': dep }, { 'src/n.ts': dep });
    expect(comparerMigration(base, carte({ 'src/n.ts': 100 }), existant('src/s.ts'), lien)).toEqual([]);
  });

  it('R18 — crédit plus grand que la perte réelle de la source : refusé au-delà de la perte', () => {
    const lien = lienSur(base, { 'src/s.ts': dep }, { 'src/s.ts': lignes(50, 50), 'src/n.ts': lignes(50) });
    const p = comparerMigration(base, carte({ 'src/s.ts': 90, 'src/n.ts': 50 }), existant('src/s.ts'), lien);
    expect(noms(p)).toContain(cle('src/n.ts')); // la source n'a perdu que 10
  });
});

/** Une `ref` synthétique : la base du départ et le contenu des fichiers du départ ; un fichier hors `depart` n'y existait pas. */
const refSur = (base: Mesure, depart: Fichiers) => ({ nom: 'main (abc1234)', base, existe: (c: string) => c in depart, contenu: (c: string) => depart[c] ?? null });
function ecrire(dir: string, fichiers: Fichiers) {
  for (const [f, t] of Object.entries(fichiers)) {
    mkdirSync(join(dir, f, '..'), { recursive: true });
    writeFileSync(join(dir, f), t);
  }
}
const lire = (dir: string) => readFileSync(join(dir, BASELINE), 'utf8');

describe('L477 — --migrer et la porte', () => {
  const depart = carte({ 'src/cli.ts': 1000 });
  const cli = lignes(1000);
  const ref = refSur(depart, { 'src/cli.ts': cli });
  const coupe = (dir: string) => ecrire(dir, { 'src/cli.ts': lignes(350, 650), 'src/cli-plan.ts': lignes(650) });
  const apresCoupe = carte({ 'src/cli.ts': 350, 'src/cli-plan.ts': 650 });

  it('R8 — --migrer sans --contre : code 2, base intacte', () => {
    const dir = tempDir();
    writeFileSync(join(dir, BASELINE), JSON.stringify(depart));
    expect(appliquer(dir, 'migrer', apresCoupe, null).code).toBe(2);
    expect(lire(dir)).toBe(JSON.stringify(depart));
  });

  it('R9 — gain figé par --ecrire puis fichier neuf sans lien du même montant : --migrer refuse', () => {
    const dir = tempDir();
    ecrire(dir, { 'src/cli.ts': lignes(400, 600), 'src/n.ts': lignes(600, 9000, 'y') });
    writeFileSync(join(dir, BASELINE), JSON.stringify(carte({ 'src/cli.ts': 400 })));
    const r = appliquer(dir, 'migrer', carte({ 'src/cli.ts': 400, 'src/n.ts': 600 }), ref);
    expect(r.code).toBe(1);
    expect(r.texte).toContain('src/n.ts');
  });

  it('R9 — départ à 700, base du lot à 100 après un gain figé de 600, fichier neuf de mesure 50 lié à une source qui n\'a rien perdu : refusé, le total (150) dépasse la base du lot (100) et la source n\'a pas de perte', () => {
    const dir = tempDir();
    const dep = carte({ 'src/a.ts': 700 });
    ecrire(dir, { 'src/a.ts': lignes(700), 'src/n.ts': lignes(50) });
    writeFileSync(join(dir, BASELINE), JSON.stringify(carte({ 'src/a.ts': 100 })));
    const r = appliquer(dir, 'migrer', carte({ 'src/a.ts': 100, 'src/n.ts': 50 }), refSur(dep, { 'src/a.ts': lignes(700) }));
    expect(r.code).toBe(1);
    expect(r.texte).toContain('(total, tous fichiers) : 100 → 150');
    expect(r.texte).toContain('src/n.ts');
  });

  it('R9 — la base écrite par --migrer n\'a aucune clé au-dessus de la base du lot avant l\'appel', () => {
    const dir = tempDir();
    coupe(dir);
    writeFileSync(join(dir, BASELINE), JSON.stringify(depart));
    expect(appliquer(dir, 'migrer', apresCoupe, ref).code).toBe(0);
    expect(comparer(depart, JSON.parse(lire(dir))).pires.filter((p) => p.cle.includes('src/cli.ts'))).toEqual([]);
  });

  it('R10 — premier --migrer accepté, source corrigée, --ecrire, second --migrer : le morceau est gardé', () => {
    const dir = tempDir();
    coupe(dir);
    writeFileSync(join(dir, BASELINE), JSON.stringify(depart));
    expect(appliquer(dir, 'migrer', apresCoupe, ref).code).toBe(0);
    ecrire(dir, { 'src/cli.ts': lignes(100, 650) });
    const corrigee = carte({ 'src/cli.ts': 100, 'src/cli-plan.ts': 650 });
    expect(appliquer(dir, 'ecrire', corrigee, ref).code).toBe(0);
    expect(appliquer(dir, 'migrer', corrigee, ref).code).toBe(0);
    expect(JSON.parse(lire(dir))).toEqual(corrigee);
  });

  it('R10 — cli-plan.ts coupé de nouveau en deux après un premier --migrer et --ecrire (sources du départ : cli.ts) : accepté, la somme des morceaux reste dans la perte de cli.ts', () => {
    const dir = tempDir();
    coupe(dir);
    writeFileSync(join(dir, BASELINE), JSON.stringify(depart));
    expect(appliquer(dir, 'migrer', apresCoupe, ref).code).toBe(0);
    ecrire(dir, { 'src/cli-plan.ts': lignes(400), 'src/cli-plan-b.ts': lignes(250, 400) });
    const deux = carte({ 'src/cli.ts': 350, 'src/cli-plan.ts': 400, 'src/cli-plan-b.ts': 250 });
    expect(appliquer(dir, 'migrer', deux, ref).code).toBe(0);
    expect(JSON.parse(lire(dir))).toEqual(deux);
  });

  it('R10 — deux --migrer successifs de morceaux dont la somme dépasse la perte de la source : le second est refusé', () => {
    const dir = tempDir();
    ecrire(dir, { 'src/cli.ts': lignes(400, 600), 'src/m1.ts': lignes(400), 'src/m2.ts': lignes(200, 400) });
    writeFileSync(join(dir, BASELINE), JSON.stringify(depart));
    const un = carte({ 'src/cli.ts': 400, 'src/m1.ts': 400 });
    expect(appliquer(dir, 'migrer', un, ref).code).toBe(0);
    // 400 + 300 > 600 perdus : le second morceau est compté avec le premier
    const deux = carte({ 'src/cli.ts': 400, 'src/m1.ts': 400, 'src/m2.ts': 300 });
    expect(appliquer(dir, 'migrer', deux, ref).code).toBe(1);
    expect(JSON.parse(lire(dir))).toEqual(un);
  });

  it('R11 — migrer, corriger la source, --ecrire : la porte reste verte', () => {
    const dir = tempDir();
    coupe(dir);
    writeFileSync(join(dir, BASELINE), JSON.stringify(apresCoupe));
    expect(appliquer(dir, 'verifier', apresCoupe, ref).code).toBe(0);
    ecrire(dir, { 'src/cli.ts': lignes(100, 650) });
    const corrigee = carte({ 'src/cli.ts': 100, 'src/cli-plan.ts': 650 });
    writeFileSync(join(dir, BASELINE), JSON.stringify(corrigee));
    expect(appliquer(dir, 'verifier', corrigee, ref).code).toBe(0);
  });

  it('R11 — base éditée à la main avec un fichier neuf sans lien et un fichier corrigé de même montant : la porte refuse', () => {
    const dir = tempDir();
    ecrire(dir, { 'src/cli.ts': '', 'src/n.ts': lignes(1000, 9000, 'y') });
    const truquee = carte({ 'src/n.ts': 1000 });
    writeFileSync(join(dir, BASELINE), JSON.stringify(truquee));
    const r = appliquer(dir, 'verifier', truquee, ref);
    expect(r.code).toBe(1);
    expect(r.texte).toContain('remonte');
    expect(r.texte).toContain('aucune source');
  });

  it('R11 — base éditée à la main avec un fichier neuf lié mais plus grand que la perte de sa source : la porte refuse', () => {
    const dir = tempDir();
    coupe(dir);
    const truquee = carte({ 'src/cli.ts': 350, 'src/cli-plan.ts': 700 });
    writeFileSync(join(dir, BASELINE), JSON.stringify(truquee));
    const r = appliquer(dir, 'verifier', truquee, ref);
    expect(r.code).toBe(1);
    expect(r.texte).toContain('source la plus proche : src/cli.ts');
  });

  it('R12 — migration refusée : code 1, base inchangée, chaque clé en cause nommée avec « avant → après »', () => {
    const dir = tempDir();
    coupe(dir);
    writeFileSync(join(dir, BASELINE), JSON.stringify(depart));
    const mesure = carte({ 'src/cli.ts': 1200, 'src/cli-plan.ts': 650 });
    const r = appliquer(dir, 'migrer', mesure, ref);
    expect(r.code).toBe(1);
    expect(r.texte).toContain('la migration empire');
    expect(r.texte).toContain(`${cle('src/cli.ts')} : 1000 → 1200`);
    expect(r.texte).toContain('(total, tous fichiers)');
    expect(lire(dir)).toBe(JSON.stringify(depart));
  });

  it('R15 — fichier neuf refusé : le texte nomme la clé, « 0 → n », la mention et la source la plus proche ou « aucune source »', () => {
    const dir = tempDir();
    ecrire(dir, { 'src/cli.ts': lignes(500, 500), 'src/m.ts': lignes(700), 'src/l.ts': lignes(100, 9000, 'y') });
    writeFileSync(join(dir, BASELINE), JSON.stringify(depart));
    const r = appliquer(dir, 'migrer', carte({ 'src/cli.ts': 500, 'src/m.ts': 700, 'src/l.ts': 100 }), ref);
    expect(r.code).toBe(1);
    expect(r.texte).toContain(`${cle('src/m.ts')} : 0 → 700 — fichier neuf : au-delà de ce que sa source a perdu (source la plus proche : src/cli.ts)`);
    expect(r.texte).toContain(`${cle('src/l.ts')} : 0 → 100 — fichier neuf : au-delà de ce que sa source a perdu (aucune source)`);
  });

  it('R15 — le préfixe du refus reste « Qualité : la migration empire N mesure(s) »', () => {
    const dir = tempDir();
    ecrire(dir, { 'src/cli.ts': '', 'src/n.ts': lignes(5, 9000, 'y') });
    writeFileSync(join(dir, BASELINE), JSON.stringify(depart));
    const r = appliquer(dir, 'migrer', carte({ 'src/n.ts': 5 }), ref);
    expect(r.texte).toMatch(/^Qualité : la migration empire \d+ mesure\(s\) \(ni un fichier qui existait ni le total ne peuvent monter\) :/);
  });

  it('R17 — --migrer sans qualite-baseline.json au départ : code 1, message nommant la référence et --init, base intacte, aucune exception', () => {
    const dir = tempDir();
    writeFileSync(join(dir, BASELINE), '{"a":1}');
    const r = appliquer(dir, 'migrer', { a: 1 }, { nom: 'main (abc1234)', base: null });
    expect(r.code).toBe(1);
    expect(r.texte).toContain('main (abc1234)');
    expect(r.texte).toContain('--init');
    expect(lire(dir)).toBe('{"a":1}');
  });

  it('R17 — --migrer sans base au départ avec un fichier neuf en défaut : aucun crédit, refus, pas de plantage', () => {
    const dir = tempDir();
    ecrire(dir, { 'src/n.ts': lignes(10) });
    writeFileSync(join(dir, BASELINE), '{}');
    const lus: string[] = [];
    const r = appliquer(dir, 'migrer', carte({ 'src/n.ts': 10 }), { nom: 'main (abc1234)', base: null, contenu: (c) => { lus.push(c); return ''; } });
    expect(r.code).toBe(1);
    expect(lus).toEqual([]);
  });

  it('R17 — la porte sans base au départ : code 0 comme avant', () => {
    const dir = tempDir();
    writeFileSync(join(dir, BASELINE), JSON.stringify({ a: 5 }));
    expect(appliquer(dir, 'verifier', { a: 5 }, { nom: 'main (abc1234)', base: null }).code).toBe(0);
  });
});

/** Un dépôt git réel : tout ce qui touche git (lireRef, git show, fichier non suivi, renommage, CLI). */
describe('L477 — dépôt réel', () => {
  const qualite = (dir: string, ...args: string[]) => spawnSync(process.execPath, [join(REPO, 'scripts/qualite.mjs'), ...args], { cwd: dir, encoding: 'utf8' });
  const git = (dir: string, ...a: string[]) => spawnSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...a], { cwd: dir, encoding: 'utf8' });
  const fonction = (nom: string, n: number, depart = 0) => `export function ${nom}(): number {\n  let x = 0;\n${lignes(n, depart)}\n  return x;\n}\n`;

  /** Un projet avec les vrais ESLint, knip, jscpd ; src/gros.ts (1000 lignes) est le fichier à découper, src/cli.ts l'importe. */
  function projet(avecBase = true) {
    const dir = tempDir();
    mkdirSync(join(dir, 'src'));
    for (const f of ['eslint.config.mjs', 'knip.json']) cpSync(join(REPO, f), join(dir, f));
    ecrire(dir, { '.jscpd.json': readFileSync(join(REPO, '.jscpd.json'), 'utf8').replace(/"path": \[[^\]]*\]/, '"path": ["src"]') });
    symlinkSync(join(REPO, 'node_modules'), join(dir, 'node_modules'));
    // jscpd n'écrit pas de rapport sans doublon : b.ts en porte un, copié dans cli.ts
    const copie = Array.from({ length: 30 }, (_, i) => `console.log(${i});`).join('\n');
    ecrire(dir, {
      'package.json': '{"name":"p","type":"module"}\n',
      'src/cli.ts': `import { a } from './gros.js';\nimport { b } from './b.js';\nconsole.log(a(), b());\n${copie}\n`,
      'src/gros.ts': fonction('a', 1000),
      'src/b.ts': `export const b = (): number => 1;\n${copie}\n`,
    });
    git(dir, 'init', '-q', '-b', 'main');
    if (avecBase) expect(qualite(dir, '--init').stderr).toBe('');
    git(dir, 'add', 'src', '.jscpd.json', 'eslint.config.mjs', 'knip.json', 'package.json', ...(avecBase ? [BASELINE] : []));
    git(dir, 'commit', '-q', '-m', 'départ');
    git(dir, 'switch', '-q', '-c', 'lot');
    return { dir, copie };
  }
  // gros.ts (1000 lignes de x += i) coupé : 450 lignes restent, les autres partent dans a2.ts (même corps, autre en-tête : 550 lignes mesurées pour 550 perdues)
  const decoupe = (dir: string) => {
    ecrire(dir, { 'src/gros.ts': fonction('a', 450), 'src/a2.ts': `export function a2(): number {\n  let x = 0;\n${lignes(546, 450)}\n  return x;\n}\n` });
    ecrire(dir, { 'src/cli.ts': readFileSync(join(dir, 'src/cli.ts'), 'utf8').replace("import { b }", "import { a2 } from './a2.js';\nimport { b }").replace('console.log(a(), b());', 'console.log(a(), a2(), b());') });
  };

  it('R1 — une fonction qui grossit de 18 à 19 sous la pire du fichier est refusée par la porte sur un dépôt réel', () => {
    const dir = tempDir();
    mkdirSync(join(dir, 'src'));
    for (const f of ['eslint.config.mjs', 'knip.json']) cpSync(join(REPO, f), join(dir, f));
    ecrire(dir, { '.jscpd.json': readFileSync(join(REPO, '.jscpd.json'), 'utf8').replace(/"path": \[[^\]]*\]/, '"path": ["src"]'), 'package.json': '{"name":"p","type":"module"}\n' });
    symlinkSync(join(REPO, 'node_modules'), join(dir, 'node_modules'));
    const branches = (n: number) => Array.from({ length: n }, (_, i) => `  if (v === ${i}) x += ${i};`).join('\n');
    const fn = (nom: string, n: number) => `export function ${nom}(v: number): number {\n  let x = 0;\n${branches(n)}\n  return x;\n}\n`;
    const ecrireFns = (n3: number) => ecrire(dir, { 'src/cli.ts': `import { f1, f2, f3 } from './f.js';\nconsole.log(f1(1), f2(1), f3(1));\n`, 'src/f.ts': `${fn('f1', 30)}${fn('f2', 20)}${fn('f3', n3)}` });
    ecrireFns(18);
    expect(qualite(dir, '--init').status).toBe(0);
    ecrireFns(19);
    const r = qualite(dir);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('complexity|total');
  });

  it('R6 — gros.ts coupé en gros.ts et a2.ts (lignes copiées de gros.ts) : --migrer accepte, la porte est verte ; un a2.ts réécrit est refusé', () => {
    const { dir } = projet();
    decoupe(dir);
    expect(qualite(dir, '--contre', 'main').status).toBe(1);
    expect(qualite(dir, '--migrer', '--contre', 'main').status).toBe(0);
    expect(qualite(dir, '--contre', 'main').status).toBe(0);
    ecrire(dir, { 'src/a2.ts': `export function a2(): number {\n  let x = 0;\n${lignes(550, 90000, 'z')}\n  return x;\n}\n` });
    const refus = qualite(dir, '--contre', 'main');
    expect(refus.status).toBe(1);
    expect(refus.stderr).toContain('src/a2.ts');
  });

  it('R14 — fichier neuf non suivi par git : lié, l\'index du lot reste inchangé', () => {
    const { dir } = projet();
    decoupe(dir);
    const avant = git(dir, 'status', '--porcelain').stdout;
    const index = git(dir, 'ls-files', '-s').stdout;
    expect(git(dir, 'ls-files', '--others', '--exclude-standard').stdout).toContain('src/a2.ts');
    expect(qualite(dir, '--migrer', '--contre', 'main').status).toBe(0);
    expect(git(dir, 'ls-files', '-s').stdout).toBe(index);
    expect(git(dir, 'status', '--porcelain').stdout.replace(` M ${BASELINE}\n`, '')).toBe(avant);
  });

  it('R14 — fichier renommé (git mv) : lié à son ancien chemin', () => {
    const { dir } = projet();
    git(dir, 'mv', 'src/gros.ts', 'src/gros2.ts');
    renameSync(join(dir, 'src/cli.ts'), join(dir, 'src/cli.ts'));
    ecrire(dir, { 'src/cli.ts': readFileSync(join(dir, 'src/cli.ts'), 'utf8').replace('./gros.js', './gros2.js') });
    expect(qualite(dir, '--migrer', '--contre', 'main').status).toBe(0);
    expect(Object.keys(JSON.parse(lire(dir))).some((k) => k.includes('src/gros2.ts'))).toBe(true);
  });

  it('R14 — à l\'intégration, le lien se calcule sur le commit contrôlé sans arbre de travail', () => {
    const { dir } = projet();
    decoupe(dir);
    expect(qualite(dir, '--migrer', '--contre', 'main').status).toBe(0);
    git(dir, 'add', '-A', 'src', BASELINE);
    git(dir, 'commit', '-q', '-m', 'feat(L1): découpe');
    const ref = lireRef(dir, 'main');
    expect(ref.contenu?.('src/gros.ts')).toContain('x += 999;');
    expect(ref.contenu?.('src/a2.ts')).toBeNull();
  });

  it('R16 — clone superficiel sans merge-base : code 2, rien n\'est écrit', () => {
    const { dir } = projet();
    const avant = lire(dir);
    git(dir, 'switch', '-q', '--orphan', 'etranger');
    ecrire(dir, { 'x.txt': 'x', [BASELINE]: avant });
    git(dir, 'add', 'x.txt');
    git(dir, 'commit', '-q', '-m', 'sans parenté');
    const r = qualite(dir, '--migrer', '--contre', 'main');
    expect(r.status).toBe(2);
    expect(r.stderr).toContain('main');
    expect(lire(dir)).toBe(avant);
  });

  /** Un `git` qui échoue (code 1) quand ses arguments contiennent `motif`, et délègue au vrai sinon : l'échec de git au milieu d'une commande, sans toucher au dépôt. */
  function gitQuiEchoue(motif: string) {
    const bin = join(tempDir(), 'bin');
    mkdirSync(bin);
    const vrai = spawnSync('which', ['git'], { encoding: 'utf8' }).stdout.trim();
    writeFileSync(join(bin, 'git'), `#!/bin/sh\ncase "$*" in *'${motif}'*) echo 'échec simulé' >&2; exit 1;; esac\nexec ${vrai} "$@"\n`, { mode: 0o755 });
    return { ...process.env, PATH: `${bin}:${process.env.PATH}` };
  }
  const migrerAvec = (dir: string, env: NodeJS.ProcessEnv) => spawnSync(process.execPath, [join(REPO, 'scripts/qualite.mjs'), '--migrer', '--contre', 'main'], { cwd: dir, encoding: 'utf8', env });

  it('R16 — git show en échec pour une source : code 2, message nommant le fichier et la référence, base intacte', () => {
    const { dir } = projet();
    decoupe(dir);
    const avant = lire(dir);
    const r = migrerAvec(dir, gitQuiEchoue(':src/'));
    expect(r.status).toBe(2);
    expect(r.stderr).toMatch(/le contenu de src\/\S+ au point de départ main est illisible/);
    expect(r.stderr).not.toContain('fichier neuf');
    expect(lire(dir)).toBe(avant);
  });

  it('R16 — l\'arbre du départ illisible (ls-tree en échec) : code 2 nommant le fichier et la référence, jamais un fichier du départ pris pour neuf', () => {
    const { dir } = projet();
    decoupe(dir);
    const avant = lire(dir);
    const r = migrerAvec(dir, gitQuiEchoue('ls-tree -z'));
    expect(r.status).toBe(2);
    expect(r.stderr).toMatch(/src\/\S+ au point de départ main est illisible/);
    expect(r.stderr).not.toContain('fichier neuf');
    expect(lire(dir)).toBe(avant);
  });

  it('R16 — git absent : code 2, message qui nomme la référence, aucun fichier neuf refusé', () => {
    const { dir } = projet();
    decoupe(dir);
    const avant = lire(dir);
    const r = migrerAvec(dir, { ...process.env, PATH: '/nonexistent' });
    expect(r.status).toBe(2);
    expect(r.stderr).toContain('« main »');
    expect(r.stderr).not.toContain('Cannot read properties');
    expect(r.stderr).not.toContain('fichier neuf');
    expect(lire(dir)).toBe(avant);
  });

  it('R17 — --migrer sans qualite-baseline.json au départ (lot qui amorce la base avec --init) : code 1, la base n\'est pas touchée', () => {
    const { dir } = projet(false);
    expect(qualite(dir, '--init', '--contre', 'main').status).toBe(0);
    const base = lire(dir);
    decoupe(dir);
    const r = qualite(dir, '--migrer', '--contre', 'main');
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('--init');
    expect(lire(dir)).toBe(base);
    expect(existsSync(join(dir, BASELINE))).toBe(true);
  });

  it('R13 — lireRef rend le contenu d\'un fichier du départ, null pour un fichier absent', () => {
    const { dir } = projet();
    expect(lireRef(dir, 'main').contenu?.('src/b.ts')).toContain('export const b');
    expect(lireRef(dir, 'main').contenu?.('src/jamais.ts')).toBeNull();
  });
});
