// L842 (D-33) : quand la porte d'un cadence run est rouge, chaque test rouge est rejoué SEUL (même commande, filtrée sur ce test) avant de rendre la main
// à la session ; vert seul, il est « sensible à la charge » (journal, état, détail de fin), compté vert, sans passe de correction ; rouge seul, correction
// comme avant. Le filtre se déclare (testReplay, replay d'une partie) ou se déduit (vitest, jest, pytest, dotnet test, script npm) ; sinon, pas de rejeu, dit.
import { execFileSync } from 'node:child_process';
import { readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { verdictPour } from '../../scripts/verdicts-porte.mjs';
import { jouerRejeu, envRejeu, rejeuDeLaCommande, rejeuxDesTests, rejouerRouges, rougesDotnet, testsReussis, type Joue, type Rejeu } from '../../scripts/rejeu-rouges.mjs';
import { fichierDeCode, lireEtats, mesurer, rendre } from '../../scripts/passes-porte-rouge.mjs';
import { executerRun, type Etat } from '../src/run/run.js';
import { commite, fauxClaude, git, io } from './run-outils.js';
import { dossierTemp } from './temp.js';

const cible = (r: Rejeu, nom: string, sortie = '') => r.cible?.(nom, sortie) ?? null;
const joue = (code: number, sortie: string): Joue => ({ code, sortie, ms: 1200 });

describe('rejeu seul : la façon de filtrer un test, déclarée ou déduite (L842)', () => {
  it('vitest : le fichier ENTIER, jamais -t (revue L842, M1 : un rouge qui dépend d\'un test précédent du fichier) ; la preuve exige un test réussi', () => {
    const r = rejeuDeLaCommande('npx vitest run', undefined, '/nulle-part');
    expect(r.forme).toBe('vitest, déduit de « npx vitest run »');
    expect(cible(r, 'test/a.test.ts > suite > cas (x) [y]')).toEqual({ fichier: 'test/a.test.ts', commande: 'npx vitest run test/a.test.ts', filtre: true });
    expect(cible(r, '|v2|  test/b.test.ts > s > c')?.commande).toBe('npx vitest run test/b.test.ts'); // espace de travail
  });
  it('jest : le fichier de la ligne FAIL qui précède le test, -t sur « Suite › cas » ; un FAIL de fichier seul rejoue le fichier', () => {
    const sortie = 'FAIL src/a.spec.ts\n  ● Suite › cas lent\n';
    const r = rejeuDeLaCommande('npx jest --ci', undefined, '/nulle-part');
    expect(cible(r, 'Suite › cas lent', sortie)?.commande).toBe("npx jest --ci src/a.spec.ts -t 'cas lent'");
    expect(cible(r, 'src/a.spec.ts', sortie)).toEqual({ fichier: 'src/a.spec.ts', commande: 'npx jest --ci src/a.spec.ts', filtre: false }); // preuve : le fichier joué
  });
  it('pytest : l\'identifiant du test (chemin::test[param]) ; dotnet test : --filter sur le nom complet', () => {
    expect(cible(rejeuDeLaCommande('python -m pytest -q', undefined, '/x'), 'tests/test_a.py::test_b[1]')?.commande).toBe("python -m pytest -q 'tests/test_a.py::test_b[1]'");
    const d = rejeuDeLaCommande('dotnet test Projet.sln', undefined, '/x');
    expect(cible(d, 'Espace.Classe.Methode')).toEqual({ fichier: null, commande: 'dotnet test Projet.sln --filter FullyQualifiedName=Espace.Classe.Methode', filtre: true });
    expect(cible(d, 'Espace.Classe.Cas(a: 1)')?.commande).toBe("dotnet test Projet.sln --filter 'FullyQualifiedName~Espace.Classe.Cas'");
  });
  it('script npm : le lanceur est lu dans package.json et les arguments passent après --', () => {
    const d = dossierTemp('rejeu-npm-');
    writeFileSync(join(d, 'package.json'), JSON.stringify({ scripts: { test: 'vitest run', e2e: 'node a.js && vitest run' } }));
    expect(cible(rejeuDeLaCommande('npm test', undefined, d), 'a.test.ts > cas')?.commande).toBe('npm test -- a.test.ts');
    expect(rejeuDeLaCommande('npm run e2e', undefined, d).raison).toMatch(/lanceur non reconnu/);
  });
  it('rien à déduire : commande composée ou lanceur inconnu, la raison le dit et nomme la déclaration', () => {
    expect(rejeuDeLaCommande('cd front && npx vitest run', undefined, '/x').raison).toMatch(/enchaîne plusieurs commandes : déclarer orchestrate\.testReplay/);
    expect(rejeuDeLaCommande('make check', undefined, '/x').raison).toMatch(/« make check » : lanceur non reconnu .* déclarer orchestrate\.testReplay/);
    expect(rejeuDeLaCommande('a && b', 'x {files}', '/x').raison).toMatch(/commande composée : testReplay ne vaut que pour un lanceur unique/);
  });
  it('déclaré : testReplay ({files}) pour une porte en chaîne, le replay de chaque partie dans son dossier, la déduction pour une partie sans replay', () => {
    const chaine = rejeuxDesTests({ test: 'npx vitest run', testReplay: 'npx vitest run --maxWorkers=$CADENCE_TEST_WORKERS {files}' }, '/r');
    expect(cible(chaine.get('npx vitest run')!, 'a.test.ts > cas')).toEqual({ fichier: 'a.test.ts', commande: 'npx vitest run --maxWorkers=$CADENCE_TEST_WORKERS a.test.ts', titreNode: false });
    const parties = rejeuxDesTests({ test: [{ dir: 'back', run: 'npm test', replay: 'npx jest {files}' }, { dir: 'front', run: 'npx vitest run' }] }, '/r');
    expect([...parties.keys()]).toEqual(['cd back && npm test', 'cd front && npx vitest run']);
    expect(cible(parties.get('cd back && npm test')!, 'src/a.spec.ts')?.commande).toBe('cd back && npx jest src/a.spec.ts');
    expect(cible(parties.get('cd front && npx vitest run')!, 'b.test.ts > s > c')?.commande).toBe('cd front && npx vitest run b.test.ts');
  });
  it('CADENCE_TEST_WORKERS du rejeu : celui de l\'environnement, sinon cœurs ÷ CADENCE_MAX_SESSIONS (2 par défaut)', () => {
    expect(envRejeu({ CADENCE_TEST_WORKERS: '3' }, 32).CADENCE_TEST_WORKERS).toBe('3');
    expect(envRejeu({}, 32).CADENCE_TEST_WORKERS).toBe('16');
    expect(envRejeu({ CADENCE_TEST_WORKERS: 'x', CADENCE_MAX_SESSIONS: '4' }, 32).CADENCE_TEST_WORKERS).toBe('8');
  });
});

describe('rejeu seul : la preuve du vert et les rouges jamais rejoués (L842)', () => {
  it('testsReussis lit la ligne de fin de vitest, jest, pytest, dotnet et node --test', () => {
    expect(testsReussis(' Test Files  1 passed (1)\n      Tests  1 passed | 4 skipped (5)')).toBe(1);
    expect(testsReussis('      Tests  5 skipped (5)')).toBe(0);
    expect(testsReussis('Tests:       3 skipped, 2 passed, 5 total')).toBe(2);
    expect(testsReussis('==== 1 passed, 3 deselected in 0.12s ====')).toBe(1);
    expect(testsReussis('Passed!  - Failed:     0, Passed:     1, Skipped:     0, Total:     1')).toBe(1);
    expect(testsReussis('# pass 1\n# fail 0')).toBe(1);
    expect(rougesDotnet('  Failed Espace.Classe.Cas [12 ms]\nFailed!  - Failed:     1, Passed: 3')).toEqual(['Espace.Classe.Cas']);
  });
  const r = rejeuDeLaCommande('npx vitest run', undefined, '/x');
  const rouge = ' FAIL  a.test.ts > s > lent\n FAIL  b.test.ts > s > vrai\n';
  it('vert seul → sensible (avec sa durée) ; rouge seul → reste rouge ; un rejeu sorti en 0 sans test réussi ne prouve rien ; un fichier joué une fois', () => {
    const vus: string[] = [];
    const deux = `${rouge} FAIL  b.test.ts > s > autre\n`;
    const j = rejouerRouges(deux, r, (c) => { vus.push(c); return c.includes('a.test.ts') ? joue(0, ' ✓ a.test.ts (2 tests | 1 skipped)\n Tests  1 passed | 1 skipped (2)') : joue(1, ' FAIL  b.test.ts > s > vrai'); });
    expect(vus).toEqual(['npx vitest run a.test.ts', 'npx vitest run b.test.ts']); // un rejeu par fichier, sans les autres fichiers
    expect(j).toEqual({ sensibles: [{ test: 'a.test.ts > s > lent', ms: 1200 }], rouges: ['b.test.ts > s > autre', 'b.test.ts > s > vrai'] });
    const saute = rejouerRouges(rouge, r, () => joue(0, ' ↓ a.test.ts (2 tests | 2 skipped)\n Tests  2 skipped (2)'));
    expect(saute.sensibles).toEqual([]);
  });
  it('un échec sans test nommé, trop de rouges, pas de façon de filtrer : rien n\'est rejoué et la raison est dite ; aucun rouge nommé : rien n\'est dit', () => {
    const jamais = () => { throw new Error('rejoué'); };
    expect(rejouerRouges(`${rouge}Unhandled Errors`, r, jamais).raison).toMatch(/aucun test/);
    expect(rejouerRouges('error TS2304: x', r, jamais)).toEqual({ sensibles: [], rouges: [] }); // rien de nommé : rien à dire, la commande reste rouge
    const onze = Array.from({ length: 11 }, (_, i) => ` FAIL  a.test.ts > s > c${i}`).join('\n');
    expect(rejouerRouges(onze, r, jamais).raison).toBe('11 tests rouges, plus de 10 : ce n\'est pas la charge');
    expect(rejouerRouges(rouge, rejeuDeLaCommande('make', undefined, '/x'), jamais)).toMatchObject({ sensibles: [], rouges: ['a.test.ts > s > lent', 'b.test.ts > s > vrai'], raison: expect.stringMatching(/lanceur non reconnu/) });
  });
});

describe('rejeu seul avec un vrai vitest (L842)', () => {
  it('un test rouge dans la suite et vert seul est sensible ; un vrai rouge le reste ; un rouge dû au test précédent du fichier le reste (revue L842, M1)', () => {
    const d = dossierTemp('rejeu-vitest-');
    symlinkSync(join(import.meta.dirname, '..', '..', 'node_modules'), join(d, 'node_modules'));
    writeFileSync(join(d, 'vitest.config.mjs'), 'export default {};\n');
    const entete = `import { existsSync, writeFileSync } from 'node:fs';\nimport { describe, expect, it } from 'vitest';\n`;
    // « charge » : rouge à la première exécution (la suite), vert ensuite (le rejeu) ; « vrai » : toujours rouge
    writeFileSync(join(d, 'a.test.ts'), `${entete}describe('s', () => {
  it('charge (lente)', () => { const vu = existsSync('vu'); writeFileSync('vu', ''); expect(vu).toBe(true); });
  it('vert', () => expect(1).toBe(1));
});\n`);
    writeFileSync(join(d, 'b.test.ts'), `${entete}describe('s', () => { it('vrai', () => expect(1).toBe(2)); });\n`);
    // « vide au depart » : rouge parce que le test qui le précède remplit le cache du module ; seul (-t), il serait vert
    writeFileSync(join(d, 'c.test.ts'), `${entete}const cache: string[] = [];
it('remplit', () => { cache.push('x'); expect(cache).toHaveLength(1); });
it('vide au depart', () => expect(cache).toHaveLength(0));\n`);
    let suite = '';
    try { execFileSync('npx', ['vitest', 'run'], { cwd: d, encoding: 'utf8', stdio: 'pipe' }); } catch (e) { suite = `${(e as { stdout: string }).stdout}${(e as { stderr: string }).stderr}`; }
    expect(suite).toMatch(/c\.test\.ts > vide au depart/); // le cas existe : rouge dans la suite
    let seul = 0;
    try { execFileSync('npx', ['vitest', 'run', 'c.test.ts', '-t', 'vide au depart'], { cwd: d, stdio: 'pipe' }); } catch { seul = 1; }
    expect(seul).toBe(0); // et vert seul avec -t : ce que l'ancien rejeu aurait excusé
    const j = rejouerRouges(suite, rejeuDeLaCommande('npx vitest run', undefined, d), (c) => jouerRejeu(c, d));
    expect(j.sensibles.map((s) => s.test)).toEqual(['a.test.ts > s > charge (lente)']);
    expect(j.rouges).toEqual(['b.test.ts > s > vrai', 'c.test.ts > vide au depart']);
  }, 60_000);
});

/** Un dépôt dont la porte est un faux lanceur : sans argument il imprime la suite (rouges de `suite`), avec un fichier il rejoue seul (`seul` : code 0 ou 1). */
function depotLanceur(suite: string[], seul: 0 | 1, replay = true): string {
  const r = dossierTemp('run-rejeu-'), repo = join(r, 'projet');
  execFileSync('git', ['init', '-q', '-b', 'main', repo]);
  writeFileSync(join(repo, 'lanceur.sh'), `if [ -f fait.txt ]; then echo ' Tests  3 passed (3)'; exit 0; fi
if [ $# -eq 0 ]; then ${suite.map((s) => `echo ' FAIL  ${s}'`).join('; ')}; exit 1; fi
if [ ${seul} -eq 0 ]; then echo " ✓ $1 (3 tests)"; echo ' Tests  3 passed (3)'; exit 0; fi
echo " FAIL  $1 > s > rouge"; exit 1\n`);
  writeFileSync(join(repo, 'cadence.yaml'), `orchestrate:\n  test: bash lanceur.sh\n${replay ? '  testReplay: bash lanceur.sh {files}\n' : ''}`);
  git(repo, 'add', '.'); git(repo, '-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', 'base');
  return repo;
}
const relire = (e: Etat) => JSON.parse(readFileSync(e.fichier, 'utf8')) as Etat;

describe('cadence run : la porte rejoue seul chaque rouge avant toute correction (L842)', () => {
  it('vert seul : sensible à la charge au journal, à l\'état et au détail de fin ; porte verte, aucune passe de correction', () => {
    const repo = depotLanceur(['a.test.ts > s > charge'], 0), { l, out } = io(), appels: unknown[] = [];
    const e = relire(executerRun({ repo, demande: 'x', exec: fauxClaude([commite('autre.txt')], appels as never), out }));
    expect(e.etat).toBe('integre');
    expect(appels).toHaveLength(1); // la session du travail seule
    expect(e.corrections).toBeUndefined();
    expect(e.sensibles_charge).toEqual([{ test: 'a.test.ts > s > charge', ms: expect.any(Number), commande: 'bash lanceur.sh' }]);
    const ligne = /test sensible à la charge : a\.test\.ts > s > charge — rouge dans la suite, vert rejoué seul \(\d+\.\d s\) : compté vert, aucune correction pour lui \(L842\)/;
    expect(l.join('\n')).toMatch(ligne);
    expect(e.detail).toMatch(ligne);
    // Revue L842 (B1) : un rouge excusé ne vaut pas une suite verte ; aucun verdict noté, le hook pre-push exigera verify --gate à ce sha
    const integre = git(repo, 'rev-parse', 'main');
    expect(verdictPour(repo, integre)).toBeNull();
    expect(l.join('\n')).toContain(`porte du run : aucun verdict noté pour ${integre.slice(0, 7)} — des rouges de la suite ont été excusés, verts rejoués seuls (L842)`);
  });

  it('rouge seul : correction comme avant, la sortie rendue dit quels rouges le restent seuls ; la correction note ses commits et ses fichiers', () => {
    const repo = depotLanceur(['a.test.ts > s > rouge'], 1), { l, out } = io();
    const e = relire(executerRun({ repo, demande: 'x', exec: fauxClaude([commite('autre.txt'), commite('fait.txt')]), out }));
    expect(e.etat).toBe('integre');
    expect(e.sensibles_charge).toBeUndefined();
    expect(e.corrections).toHaveLength(1);
    expect(e.corrections![0]).toMatchObject({ verte: true, commits: 1, fichiers: ['fait.txt'] });
    expect(e.corrections![0].rouge).toContain('rejeu seul des rouges (L842, bash lanceur.sh {files} (déclaré)) : encore rouge(s) seul(s) : a.test.ts > s > rouge');
    expect(l.join('\n')).toContain('porte rouge : reprise de la session pour corriger');
    expect(verdictPour(repo, git(repo, 'rev-parse', 'main'))?.code).toBe(0); // la porte de la correction, verte sans excuse : son verdict est noté
  });

  it('sans façon de filtrer : pas de rejeu, la porte le dit, correction comme avant ; une correction sans commit compte 0', () => {
    const repo = depotLanceur(['a.test.ts > s > charge'], 0, false), { l, out } = io();
    const e = relire(executerRun({ repo, demande: 'x', exec: fauxClaude([commite('autre.txt'), () => {}]), out }));
    expect(e.etat).toBe('porte-rouge');
    expect(l.join('\n')).toContain('porte du run : rouges non rejoués seuls (L842) — « bash lanceur.sh » : lanceur non reconnu');
    expect(e.corrections).toEqual([expect.objectContaining({ verte: false, commits: 0, fichiers: [] })]);
  });
});

describe('mesure de L842 : la part des passes porte rouge sans commit de code (scripts/passes-porte-rouge.mjs)', () => {
  it('compte par projet les passes jugées, mesurées ou non, sans commit de code, et les tests sensibles sans passe', () => {
    const d = dossierTemp('passes-');
    const etat = (id: string, repo: string, debut: string, x: object) => writeFileSync(join(d, `${id}.json`), JSON.stringify({ id, repo, debut, ...x }));
    etat('r1', '/p/cadence', '2026-11-20T10:00:00Z', { corrections: [{ rouge: 'x', verte: true }] }); // d'avant L842 : non mesurée
    etat('r2', '/p/cadence', '2026-11-26T10:00:00Z', { corrections: [{ rouge: 'x', verte: true, commits: 1, fichiers: ['changelog.d/L1.md', 'docs/a.md'] },
      { rouge: 'y', verte: false, commits: 0, fichiers: [] }, { rouge: 'z', verte: true, commits: 2, fichiers: ['src/a.ts'] }, { rouge: 'en cours' }] });
    etat('r3', '/p/maritime', '2026-11-26T11:00:00Z', { sensibles_charge: [{ test: 't', ms: 1, commande: 'c' }, { test: 'u', ms: 1, commande: 'c' }] });
    writeFileSync(join(d, 'verrou.json'), '{}'); // pas un état de run
    const tout = mesurer(lireEtats(d));
    expect(tout.total).toEqual({ runs: 3, passes: 4, mesurees: 3, sansCode: 2, sansCommit: 1, nonMesurees: 1, sensibles: 2, runsSensibles: 1 });
    expect(tout.parProjet.maritime).toMatchObject({ runs: 1, passes: 0, sensibles: 2 });
    expect(mesurer(lireEtats(d, '2026-11-26')).total).toMatchObject({ runs: 2, nonMesurees: 0, mesurees: 3 });
    const texte = rendre(tout, d);
    expect(texte).toContain('| **total** | 3 | 4 | 3 | 2 (67 %) | 1 | 1 | 2 (1 runs) |');
    expect(fichierDeCode('test/a.test.ts')).toBe(true);
    expect(fichierDeCode('.cadence/raf.yaml')).toBe(false);
  });
});
