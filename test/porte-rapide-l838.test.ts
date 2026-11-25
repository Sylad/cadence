// L838 (D-33, étude L835) : la porte rapide de cadence run — pendant le run, seuls les tests touchés par le diff du lot ; la suite complète reste à la
// porte de livraison. Sélection déclarée par projet (run.fastGate), repli sûr sur la suite complète dès qu'elle est incertaine.
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, posix } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { aucunTest, commandeDerivee, etapeTests, jouer, lirePorteJouee, lirePorteRapide, selectionner, SCRIPT } from '../scripts/porte-rapide.mjs';
import { rejeuDeCommandeJouee, rejeuxDesTests } from '../scripts/rejeu-rouges.mjs';
import { lireRegeneration } from '../scripts/regeneration.mjs';
import { cleanupTempDirs, tempDir } from './helpers.js';

afterAll(cleanupTempDirs);

const git = (cwd: string, ...a: string[]) => execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', ...a], { cwd, encoding: 'utf8' }).trim();
const ecrire = (r: string, f: string, t = 'x\n') => { mkdirSync(join(r, f, '..'), { recursive: true }); writeFileSync(join(r, f), t); };
const CFG = { command: 'npx vitest related --run {files}', dir: '.', full: ['cadence.yaml', 'package.json'] };

/** Un dépôt avec du code, un test qui l'importe, une page et un test qui la lit ; rend la racine et le sha de départ du lot. */
function depot(): { r: string; depart: string } {
  const r = tempDir();
  git(r, 'init', '-q', '-b', 'main');
  ecrire(r, 'src/a.ts'); ecrire(r, 'src/b.ts'); ecrire(r, 'docs/guide.md');
  ecrire(r, 'test/a.test.ts', "import '../src/a';\n");
  ecrire(r, 'test/guide.test.ts', "readFileSync('docs/guide.md')\n");
  ecrire(r, 'test/autre-guide.test.ts', "readFileSync('docs/mon-guide.md')\n");
  ecrire(r, 'test/readme.test.ts', "readFileSync('README.md')\n");
  ecrire(r, 'README.md'); ecrire(r, 'cadence.yaml', 'orchestrate:\n  test: npx vitest run\n'); ecrire(r, 'package.json', '{}\n');
  git(r, 'add', '-A'); git(r, 'commit', '-qm', 'base');
  return { r, depart: git(r, 'rev-parse', 'HEAD') };
}
const commit = (r: string) => { git(r, 'add', '-A'); git(r, 'commit', '-qm', 'lot'); };

describe('lirePorteRapide : la clé run.fastGate de cadence.yaml', () => {
  it('absente ou false : null (rien ne change) ; true : la commande se dérive d\'une porte vitest run, options gardées', () => {
    expect(lirePorteRapide(undefined, {}, 'c.yaml')).toBeNull();
    expect(lirePorteRapide({ purgeAfterDays: 3 }, {}, 'c.yaml')).toBeNull();
    expect(lirePorteRapide({ fastGate: false }, {}, 'c.yaml')).toBeNull();
    expect(lirePorteRapide({ fastGate: true }, { test: 'npx vitest run --reporter=dot' }, 'c.yaml'))
      .toEqual({ command: 'npx vitest related --run --reporter=dot {files}', dir: '.', full: ['cadence.yaml'] });
  });

  it('commande déclarée (jest, pytest…), dossier et motifs « full » ; cadence.yaml toujours en tête de full', () => {
    expect(lirePorteRapide({ fastGate: { command: 'npx jest --findRelatedTests {files}', dir: 'backend/', full: ['backend/package.json'] } }, { test: 'npm test' }, 'c.yaml'))
      .toEqual({ command: 'npx jest --findRelatedTests {files}', dir: 'backend', full: ['cadence.yaml', 'backend/package.json'] });
  });

  it('refus nommés : commande non dérivable, sans {files}, clé inconnue, dossier qui sort, full mal formé', () => {
    expect(() => lirePorteRapide({ fastGate: true }, { test: 'npm test' }, 'c.yaml')).toThrow(/^c\.yaml : run\.fastGate\.command : à déclarer/);
    expect(() => lirePorteRapide({ fastGate: true }, { test: 'npx vitest run test/unit' }, 'c.yaml')).toThrow(/à déclarer/);
    expect(() => lirePorteRapide({ fastGate: { command: 'jest' } }, {}, 'c.yaml')).toThrow(/contenant \{files\}/);
    expect(() => lirePorteRapide({ fastGate: { cmd: 'x {files}' } }, {}, 'c.yaml')).toThrow(/run\.fastGate\.cmd inconnu/);
    expect(() => lirePorteRapide({ fastGate: { command: 'x {files}', dir: '../a' } }, {}, 'c.yaml')).toThrow(/run\.fastGate\.dir/);
    expect(() => lirePorteRapide({ fastGate: { command: 'x {files}', full: 'a' } }, {}, 'c.yaml')).toThrow(/run\.fastGate\.full/);
    expect(() => lirePorteRapide({ fastGate: 'oui' }, {}, 'c.yaml')).toThrow(/run\.fastGate : true, ou/);
  });

  it('revue L838 (m2) : chaque page de docs/ que docs/config.md lie est publiée avec le paquet (pas de lien mort dans le paquet installé)', () => {
    const racine = join(import.meta.dirname, '..'), files: string[] = JSON.parse(readFileSync(join(racine, 'package.json'), 'utf8')).files;
    const liees = [...readFileSync(join(racine, 'docs/config.md'), 'utf8').matchAll(/\]\(([^)#:]+\.md)(?:#[^)]*)?\)/g)].map((m) => posix.join('docs', m[1]));
    expect(liees).toContain('docs/mesures/porte-rapide-l838.md');
    expect(liees.filter((f) => !files.includes(f))).toEqual([]);
  });

  it('run.fastGate est une clé connue de run: (la validation de cadence.yaml l\'accepte)', () => {
    expect(lireRegeneration({ fastGate: true }, 'c.yaml')).toEqual([]);
  });

  it('commandeDerivee : seule la forme [npx ]vitest run[ options à tiret] se dérive', () => {
    expect(commandeDerivee('vitest run')).toBe('vitest related --run {files}');
    expect(commandeDerivee('npx vitest run && tsc')).toBeNull();
    expect(commandeDerivee([{ dir: 'a', run: 'npx vitest run' }])).toBeNull();
  });
});

describe('selectionner : les tests touchés par le diff du lot, ou la suite complète quand c\'est incertain', () => {
  it('code et page touchés : les fichiers du diff, les tests qui citent la page (pas « mon-guide.md »), les tests déclarés par bounds', () => {
    const { r, depart } = depot();
    ecrire(r, 'src/a.ts', 'y\n'); ecrire(r, 'docs/guide.md', 'y\n'); ecrire(r, 'README.md', 'y\n'); commit(r);
    const s = selectionner(r, depart, CFG, { bounds: [{ paths: ['README.md'], tests: ['test/readme.test.ts'] }] });
    expect(s.motif).toBeUndefined();
    expect(new Set(s.fichiers)).toEqual(new Set(['src/a.ts', 'docs/guide.md', 'README.md', 'test/readme.test.ts', 'test/guide.test.ts']));
    expect(s.commande).toMatch(/^npx vitest related --run /);
    expect(s.commande).not.toContain('autre-guide');
  });

  it('du code seul : pas de lecteur cherché par le nom (le lien d\'import suffit), un nom à espace est protégé pour le shell', () => {
    const { r, depart } = depot();
    ecrire(r, 'src/b.ts', 'y\n'); ecrire(r, 'src/c d.ts', 'z\n'); commit(r);
    expect(selectionner(r, depart, CFG)).toEqual({ fichiers: ['src/b.ts', 'src/c d.ts'], commande: "npx vitest related --run src/b.ts 'src/c d.ts'" });
  });

  it('repli sûr : fichier supprimé, déplacé, fichier de full (cadence.yaml compris), aucun fichier, départ illisible', () => {
    const cas: [(r: string) => void, RegExp][] = [
      [(r) => rmSync(join(r, 'src/b.ts')), /fichier supprimé ou déplacé \(src\/b\.ts\)/],
      [(r) => git(r, 'mv', 'src/b.ts', 'src/c.ts'), /fichier supprimé ou déplacé \(src\/b\.ts\)/],
      [(r) => ecrire(r, 'package.json', '{"a":1}\n'), /package\.json touché \(run\.fastGate\.full\)/],
      [(r) => ecrire(r, 'cadence.yaml', 'a: 1\n'), /cadence\.yaml touché/],
    ];
    for (const [faire, motif] of cas) {
      const { r, depart } = depot();
      faire(r); commit(r);
      expect(selectionner(r, depart, CFG).motif).toMatch(motif);
    }
    const { r, depart } = depot();
    expect(selectionner(r, depart, CFG).motif).toBe('aucun fichier touché par le lot');
    expect(selectionner(r, 'nexistepas', CFG).motif).toMatch(/diff du lot illisible/);
  });

  it('dir : chemins relatifs au dossier, commande jouée dedans ; un fichier hors du dossier joue la suite complète', () => {
    const { r, depart } = depot();
    ecrire(r, 'front/src/x.ts'); ecrire(r, 'front/x.test.ts'); commit(r);
    const front = { ...CFG, dir: 'front' };
    expect(selectionner(r, depart, front)).toEqual({ fichiers: ['src/x.ts', 'x.test.ts'], commande: 'cd front && npx vitest related --run src/x.ts x.test.ts' });
    ecrire(r, 'src/a.ts', 'z\n'); commit(r);
    expect(selectionner(r, depart, front).motif).toBe('src/a.ts hors de run.fastGate.dir (front)');
  });
});

describe('etapeTests et jouer : ce que la porte du run lance', () => {
  it('sans porte rapide : la suite complète, telle quelle ; sélection incertaine : la suite complète et la ligne qui dit pourquoi', () => {
    const { r, depart } = depot();
    expect(etapeTests(r, depart, null, {}, ['npx vitest run'])).toEqual({ commandes: ['npx vitest run'], ciblee: false });
    expect(etapeTests(r, depart, CFG, {}, ['npx vitest run'])).toEqual({ commandes: ['npx vitest run'], ciblee: false,
      ligne: 'porte rapide (run.fastGate) : suite complète jouée — aucun fichier touché par le lot' });
  });

  it('sélection sûre : une commande, ce script en --jouer, la suite complète en --sinon (parties jointes par &&)', () => {
    const { r, depart } = depot();
    ecrire(r, 'src/a.ts', 'y\n'); commit(r);
    const e = etapeTests(r, depart, CFG, {}, ['cd a && x', 'cd b && y']);
    expect(e.ciblee).toBe(true);
    expect(e.commandes).toHaveLength(1);
    expect(e.commandes[0]).toContain(SCRIPT);
    expect(e.commandes[0]).toContain("--jouer 'npx vitest related --run src/a.ts' --sinon 'cd a && x && cd b && y'");
    expect(e.ligne).toBe('porte rapide (run.fastGate) : tests touchés par 1 fichier(s) du lot ; la suite complète se joue à la porte de livraison (cadence verify --gate)');
  });

  it('jouer : le code de la commande liée ; « aucun test trouvé » (vitest, jest, pytest) joue la suite complète', () => {
    const sortie: string[] = [], io = { out: (t: string) => sortie.push(t), err: (t: string) => sortie.push(t) };
    expect(jouer('echo vert', 'exit 9', io)).toBe(0);
    expect(jouer('echo rouge; exit 1', 'exit 0', io)).toBe(1);
    expect(jouer('echo "No test files found, exiting with code 1"; exit 1', 'exit 0', io)).toBe(0);
    expect(jouer('echo "No test files found, exiting with code 0"', 'exit 4', io)).toBe(4);
    expect(sortie.join('')).toContain('aucun test touché trouvé par la commande liée — suite complète jouée');
    for (const t of ['No tests found, exiting with code 1', '=== no tests ran in 0.01s ===']) expect(aucunTest(`x\n${t}`)).toBe(true);
    expect(aucunTest(' Test Files  3 passed (3)\nsee: no tests found later')).toBe(false);
  });

  it('revue L838 (M1) : lirePorteJouee relit la commande d\'etapeTests (guillemets, espaces) ; rejeuDeCommandeJouee rend le rejeu de la suite qu\'elle remplace', () => {
    const { r, depart } = depot();
    ecrire(r, "src/l'a b.ts", 'y\n'); commit(r);
    const cmd = etapeTests(r, depart, CFG, {}, ['npx vitest run']).commandes[0];
    expect(lirePorteJouee(cmd)).toEqual({ liee: "npx vitest related --run 'src/l'\\''a b.ts'", complete: 'npx vitest run' });
    expect(lirePorteJouee('npx vitest run')).toBeNull();
    expect(lirePorteJouee(`node autre.mjs --jouer a --sinon b`)).toBeNull();
    const seul = rejeuxDesTests({ test: 'npx vitest run' }, r);
    expect(rejeuDeCommandeJouee(seul, cmd)).toBe(seul.get('npx vitest run')); // la porte rapide rejoue ses rouges comme la porte complète (vitest : fichier entier)
    expect(rejeuDeCommandeJouee(seul, 'npx vitest run')).toBe(seul.get('npx vitest run'));
    expect(rejeuDeCommandeJouee(seul, 'make')).toBeUndefined();
    // porte en parties : la partie du dossier de la commande liée ; une suite qui n'est pas celle de la porte : la raison le dit
    const parties = rejeuxDesTests({ test: [{ dir: 'a', run: 'npx jest' }, { dir: 'b', run: 'npx vitest run' }] }, r);
    const enB = etapeTests(r, depart, { ...CFG, dir: 'src' }, {}, [...parties.keys()]).commandes[0].replace("cd src && ", 'cd b && ');
    expect(rejeuDeCommandeJouee(parties, enB)).toBe(parties.get('cd b && npx vitest run'));
    expect(rejeuDeCommandeJouee(seul, enB)).toMatchObject({ raison: expect.stringMatching(/^porte rapide \(run\.fastGate\) : sa suite .* ne désigne pas/) });
  });

  it('le script en ligne de commande : usage refusé (code 2), --jouer rend le code de ce qu\'il a joué', () => {
    expect(spawnSync(process.execPath, [SCRIPT, '--jouer', 'true']).status).toBe(2);
    expect(spawnSync(process.execPath, [SCRIPT, '--jouer', 'exit 3', '--sinon', 'true']).status).toBe(3);
  });
});
