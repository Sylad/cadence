import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { runLot } from '../src/orchestrate/cycle.js';
import { replayFile, replayRanFile, shellArg } from '../src/orchestrate/workers.js';
import { readOrchestrateConfig } from '../src/config.js';
import { claudeOut, commitFile, harness, reviewReport, workReport, type Handler } from './orchestrate-harness.js';
import { fake, meeting, run, setup, store, writes } from './orchestrate-worktree-harness.js';
import { tempDir } from './helpers.js';

const impl = (over: Record<string, unknown> = {}): Handler => (call) => claudeOut(workReport({ commits: [commitFile(call.opts.cwd, 'a.txt', 'feat(L1): a')], ...over }));
const fix = (file: string): Handler => (call) => claudeOut(workReport({ commits: [commitFile(call.opts.cwd, file, `fix(L1): ${file}`)] }));
const ok: Handler = () => claudeOut(reviewReport());
const kinds = (h: ReturnType<typeof harness>) => h.calls.map((c) => c.kind);

/** Porte `test` et commande de rejeu seul déclarée (L354) : la même commande suivie des fichiers. */
const replaying = (test: string) => ({ test, testReplay: `${test} {files}` });

describe('L354 R4 — avec orchestrate.testReplay, un test rouge de la porte est rejoué seul avant d\'être compté', () => {
  const LOG = () => join(tempDir(), 'rejeux.log');
  /** Rouge dans la suite entière, `f` rejoué avec un fichier : `ALONE` décide (« vert » ou « rouge »). */
  const gate = (log: string, alone: 'vert' | 'rouge') =>
    `f() { [ -f a.txt ] || exit 0; if [ -n "$1" ]; then echo "$@" >> ${log}; echo " ✓ $@"; ${alone === 'vert' ? 'exit 0' : 'echo " FAIL  test/a.test.ts > charge"; exit 1'}; fi; echo " FAIL  test/a.test.ts > charge"; echo " FAIL  test/b.test.ts > autre"; exit 1; }; f`;

  it('R4 — rouge dans la suite, vert rejoué seul : pas de passe de correction, le lot va en revue, noté « instable sous charge »', async () => {
    const log = LOG();
    const h = harness({ script: { implement: [impl()], review: [ok] } });
    const c = h.lot('L1', {}, replaying(gate(log, 'vert')));
    await runLot(c);
    expect(kinds(h)).toEqual(['implement', 'review']);
    expect(c.lot.status).toBe('ready');
    expect(c.lot.instables).toEqual(['test/a.test.ts > charge', 'test/b.test.ts > autre']);
    expect(c.lot.warnings.some((w) => /instable\(s\) sous charge.*test\/a\.test\.ts > charge/.test(w))).toBe(true);
  });
  it('R4 — la session annonce ses tests rouges (vert: false) et tous les rouges de la porte sont instables : l\'annonce ne vaut pas, pas de passe de correction', async () => {
    const log = LOG();
    const h = harness({ script: { implement: [impl({ tests: { commande: 'npx vitest run', resultat: '1 failed', vert: false } })], fix: [fix('b.txt')], review: [ok] } });
    const c = h.lot('L1', {}, replaying(gate(log, 'vert')));
    await runLot(c);
    expect(kinds(h)).toEqual(['implement', 'review']);
    expect(c.lot.pass).toBe(0);
    expect(c.lot.instables).toEqual(['test/a.test.ts > charge', 'test/b.test.ts > autre']);
    expect(h.calls.map((x) => x.brief).join('\n')).not.toContain('tests annoncés rouges par la session');
  });
  it('R4 — rejeu SEUL : la commande de la porte reçoit les fichiers des tests rouges, une seule fois quand le premier rejeu est vert', async () => {
    const log = LOG();
    const h = harness({ script: { implement: [impl()], review: [ok] } });
    await runLot(h.lot('L1', {}, replaying(gate(log, 'vert'))));
    expect(readFileSync(log, 'utf8').trim().split('\n')).toEqual(['test/a.test.ts test/b.test.ts']);
  });
  it('R4 — rouge aussi au premier rejeu, vert au second : toujours instable (deux rejeux au plus)', async () => {
    const log = LOG();
    const h = harness({ script: { implement: [impl()], review: [ok] } });
    const test = `f() { [ -f a.txt ] || exit 0; if [ -n "$1" ]; then echo "$@" >> ${log}; echo " ✓ $@"; [ "$(wc -l < ${log})" -ge 2 ] && exit 0; echo " FAIL  test/a.test.ts > charge"; exit 1; fi; echo " FAIL  test/a.test.ts > charge"; exit 1; }; f`;
    const c = h.lot('L1', {}, replaying(test));
    await runLot(c);
    expect(readFileSync(log, 'utf8').trim().split('\n')).toHaveLength(2);
    expect(kinds(h)).toEqual(['implement', 'review']);
    expect(c.lot.instables).toEqual(['test/a.test.ts > charge']);
  });
  it('R4 — rouge à la suite et aux deux rejeux : compté, la passe de correction a lieu et ne liste que lui', async () => {
    const log = LOG();
    let replaysBeforeFix = -1;
    const fixing: Handler = (call) => {
      replaysBeforeFix = readFileSync(log, 'utf8').trim().split('\n').length;
      return fix('b.txt')(call);
    };
    const h = harness({ script: { implement: [impl()], fix: [fixing], review: [ok] } });
    const c = h.lot('L1', {}, replaying(gate(log, 'rouge')));
    await runLot(c);
    expect(replaysBeforeFix).toBe(2); // deux rejeux, pas trois
    expect(kinds(h).slice(0, 2)).toEqual(['implement', 'fix']);
    expect(h.calls[1].brief).toContain('test/a.test.ts > charge');
    expect(c.lot.instables ?? []).toEqual([]); // b n'est pas nommé par les rejeux en échec : non conclu, il reste rouge avec a
  });
  it('R4 — un test que le rejeu n\'a pas nommé dans une sortie en échec reste rouge, il n\'est pas excusé en instable', async () => {
    const log = LOG();
    const h = harness({ script: { implement: [impl()], fix: [fix('b.txt')], review: [ok] } });
    // `(backend) && (frontend F)` : les fichiers ajoutés n'atteignent que le dernier lanceur, le backend rejoue sa suite entière, rougit encore et `&&` coupe avant le frontend.
    const test = `n=regression; f() { [ -f a.txt ] || exit 0; if [ -n "$1" ]; then echo "$@" >> ${log}; echo " ✓ $@"; echo " FAIL  test/b.test.ts > charge"; exit 1; fi; echo " FAIL  test/f.test.ts > $n"; echo " FAIL  test/b.test.ts > charge"; exit 1; }; f`;
    const c = h.lot('L1', {}, replaying(test));
    await runLot(c);
    expect(kinds(h).slice(0, 2)).toEqual(['implement', 'fix']);
    expect(h.calls[1].brief).toContain('test/f.test.ts > regression');
    expect(c.lot.instables ?? []).toEqual([]);
  });
  it('R4 — un rouge déjà présent à la ligne de base n\'est pas rejoué (déjà exclu du compte)', async () => {
    const log = LOG();
    const h = harness({ script: { implement: [impl()], review: [ok] } });
    // Au sha de départ le test est rouge, seul compris (vraiment déjà rouge) ; dans le lot, un rejeu seul écrirait dans le journal.
    const test = `f() { case "$PWD" in *cadence-baseline*) echo " FAIL  test/a.test.ts > ancien"; exit 1;; esac; if [ -n "$1" ]; then echo "$@" >> ${log}; echo " ✓ $@"; exit 0; fi; echo " FAIL  test/a.test.ts > ancien"; exit 1; }; f "$@"`;
    const c = h.lot('L1', {}, replaying(test));
    await runLot(c);
    expect(existsSync(log)).toBe(false);
    expect(c.lot.status).toBe('ready');
  });
  it('R4 — ligne de base comprise : un rouge de la ligne de base vert rejoué seul au sha de départ n\'excuse pas le lot, le même test rouge seul dans le lot est corrigé', async () => {
    const log = LOG();
    const h = harness({ script: { implement: [impl()], fix: [fix('b.txt')], review: [ok] } });
    // Au sha de départ : a.test.ts rouge dans la suite entière (charge), vert rejoué seul. Dans le lot : rouge partout (vraie régression).
    const test = `f() { case "$PWD" in *cadence-baseline*) if [ -n "$1" ]; then echo "base $PWD $@" >> ${log}; echo " ✓ $@"; exit 0; fi; echo ' FAIL  test/a.test.ts > charge'; exit 1;; esac; [ -f b.txt ] && exit 0; if [ -n "$1" ]; then echo "lot $@" >> ${log}; fi; echo ' FAIL  test/a.test.ts > charge'; exit 1; }; f "$@"`;
    const c = h.lot('L1', {}, replaying(test));
    await runLot(c);
    expect(kinds(h).slice(0, 2)).toEqual(['implement', 'fix']);
    expect(h.calls[1].brief).toContain('test/a.test.ts > charge');
    expect(c.lot.baseline?.failures).toEqual([]);
    expect(c.lot.instables ?? []).toEqual([]);
    const lines = readFileSync(log, 'utf8').trim().split('\n');
    expect(lines[0]).toMatch(/^base \S*cadence-baseline\S* test\/a\.test\.ts$/); // rejoué seul, dans le worktree jetable du sha de départ
    expect(lines.filter((l) => l.startsWith('lot '))).toEqual(['lot test/a.test.ts', 'lot test/a.test.ts']);
  });
  it('R4 — ligne de base comprise : rouge aux deux rejeux seuls au sha de départ, le test reste « déjà rouge » et n\'est pas corrigé', async () => {
    const log = LOG();
    const h = harness({ script: { implement: [impl()], review: [ok] } });
    const test = `f() { case "$PWD" in *cadence-baseline*) [ -n "$1" ] && echo "base $@" >> ${log}; echo ' FAIL  test/a.test.ts > ancien'; exit 1;; esac; echo ' FAIL  test/a.test.ts > ancien'; exit 1; }; f "$@"`;
    const c = h.lot('L1', {}, replaying(test));
    await runLot(c);
    expect(kinds(h)).toEqual(['implement', 'review']);
    expect(c.lot.status).toBe('ready');
    expect(c.lot.baseline?.failures).toEqual(['test/a.test.ts > ancien']);
    expect(readFileSync(log, 'utf8').trim().split('\n')).toEqual(['base test/a.test.ts', 'base test/a.test.ts']);
  });
  it('R4 — un échec sans nom de fichier (rien à rejouer seul) est compté comme avant', async () => {
    const h = harness({ script: { implement: [impl()], fix: [fix('b.txt')], review: [ok] } });
    const c = h.lot('L1', {}, replaying(`[ ! -f a.txt ] || [ -f b.txt ] || { echo ' FAIL  cas sans fichier'; exit 1; }`));
    await runLot(c);
    expect(kinds(h).slice(0, 2)).toEqual(['implement', 'fix']);
  });
  it('R4 — l\'instabilité est une ligne du journal de la vague et le contrôle du relecteur la dit verte', async () => {
    const log = LOG();
    const lines: string[] = [];
    const h = harness({ script: { implement: [impl()], review: [ok] } });
    h.wave.log = (l) => lines.push(l);
    const c = h.lot('L1', {}, replaying(gate(log, 'vert')));
    await runLot(c);
    expect(lines.some((l) => /instable\(s\) sous charge/.test(l))).toBe(true);
    const review = h.calls.find((x) => x.kind === 'review')!;
    expect(review.brief).toMatch(/green.*rouge\(s\) sous charge|green.*red under load/i);
  });
  it('R4 — ligne de base non vide : tous les nouveaux rouges sont instables, la porte passe et les rouges déjà présents restent « déjà rouges » pour le relecteur', async () => {
    const log = LOG();
    const h = harness({ script: { implement: [impl()], review: [ok] } });
    const test = `f() { case "$PWD" in *cadence-baseline*) echo ' FAIL  test/old.test.ts > ancien'; exit 1;; esac; if [ -n "$1" ]; then echo "$@" >> ${log}; echo " ✓ $@"; exit 0; fi; echo ' FAIL  test/old.test.ts > ancien'; echo ' FAIL  test/a.test.ts > charge'; exit 1; }; f "$@"`;
    const c = h.lot('L1', {}, replaying(test));
    await runLot(c);
    expect(kinds(h)).toEqual(['implement', 'review']);
    expect(readFileSync(log, 'utf8').trim().split('\n')).toEqual(['test/a.test.ts']); // seul le nouveau est rejoué
    expect(c.lot.instables).toEqual(['test/a.test.ts > charge']);
    const review = h.calls.find((x) => x.kind === 'review')!;
    expect(review.brief).toMatch(/already red at the start sha/);
    expect(review.brief).not.toMatch(/RED, exit code 1\s*$/m);
  });
  it('R4 — ligne de base non vide : deux nouveaux rouges, le rejeu en échec n\'en nomme qu\'un : les deux restent rouges (non conclu), l\'ancien est compté à part', async () => {
    const log = LOG();
    const h = harness({ script: { implement: [impl()], fix: [fix('b.txt')], review: [ok] } });
    const test = `n=charge; f() { case "$PWD" in *cadence-baseline*) echo ' FAIL  test/old.test.ts > ancien'; exit 1;; esac; if [ -n "$1" ]; then echo "$@" >> ${log}; echo " ✓ $@"; echo ' FAIL  test/b.test.ts > autre'; exit 1; fi; echo ' FAIL  test/old.test.ts > ancien'; echo " FAIL  test/a.test.ts > $n"; echo ' FAIL  test/b.test.ts > autre'; exit 1; }; f "$@"`;
    const c = h.lot('L1', {}, replaying(test));
    await runLot(c);
    const brief = h.calls[1].brief;
    expect(kinds(h).slice(0, 2)).toEqual(['implement', 'fix']);
    expect(brief).toContain('- test/b.test.ts > autre');
    expect(brief).toContain('- test/a.test.ts > charge');
    expect(brief).toContain('1 autre(s) test(s) déjà rouge(s)');
    expect(c.lot.instables ?? []).toEqual([]);
  });
  it('R4 — jest : « FAIL fichier » et « ● Suite › test » sont rejoués seuls (par le fichier), verts rejoués : instables', async () => {
    const log = LOG();
    const h = harness({ script: { implement: [impl()], review: [ok] } });
    const test = `f() { [ -f a.txt ] || exit 0; if [ -n "$1" ]; then echo "$@" >> ${log}; echo " ✓ $@"; exit 0; fi; echo 'FAIL src/a.test.ts'; echo '  ● Suite › charge'; exit 1; }; f "$@"`;
    const c = h.lot('L1', {}, replaying(test));
    await runLot(c);
    expect(kinds(h)).toEqual(['implement', 'review']);
    expect(readFileSync(log, 'utf8').trim().split('\n')).toEqual(['src/a.test.ts']);
    expect(c.lot.instables).toEqual(['Suite › charge', 'src/a.test.ts']);
  });
  it('R4 — jest : rouge aussi rejoué seul, la correction a lieu', async () => {
    const h = harness({ script: { implement: [impl()], fix: [fix('b.txt')], review: [ok] } });
    const test = `[ -f a.txt ] || exit 0; [ -f b.txt ] && exit 0; echo 'FAIL src/a.test.ts'; echo '  ● Suite › charge'; exit 1`;
    await runLot(h.lot('L1', {}, replaying(test)));
    expect(kinds(h).slice(0, 2)).toEqual(['implement', 'fix']);
  });
  it('R4 — les cibles de rejeu : fichier de vitest (« fichier > suite > test ») et de pytest (« fichier::test »), rien pour un nom sans fichier', () => {
    expect(replayFile('test/a.test.ts > suite > cas')).toBe('test/a.test.ts');
    expect(replayFile('tests/test_a.py::test_x[1-2]')).toBe('tests/test_a.py');
    expect(replayFile('cas sans fichier')).toBeNull();
    expect(replayFile('a > b')).toBeNull();
    expect(replayFile('test/a.test.ts > suite > cas::x')).toBe('test/a.test.ts'); // « :: » dans le titre d'un test vitest : le premier séparateur borne le chemin
    expect(replayFile('tests/test_a.py::test_x[a > b]')).toBe('tests/test_a.py'); // « > » dans l'identifiant d'un paramètre pytest
    expect(replayFile('src/a.test.ts')).toBe('src/a.test.ts'); // jest : « FAIL src/a.test.ts », le fichier seul
    expect(replayFile('Suite › charge')).toBeNull(); // jest : « ● Suite › test », sans fichier (rattaché aux FAIL fichier de la sortie par le rejeu)
  });
  it('R4 — espace de travail vitest : le préfixe « |projet| » n\'est pas une partie du chemin à rejouer', () => {
    expect(replayFile('|pa|  src/a.test.js > casse')).toBe('src/a.test.js');
    expect(replayFile('|pa| src/a.test.js > suite > casse')).toBe('src/a.test.js');
  });
  it('R4 — un rejeu vert qui n\'a pas exécuté le fichier d\'un test (rejeu du seul fichier du frontend) ne l\'excuse pas : la vraie régression du backend est corrigée', async () => {
    const h = harness({ script: { implement: [impl()], fix: [fix('b.txt')], review: [ok] } });
    // La suite entière rougit au frontend (charge) et au backend (régression) ; le rejeu ne joue que le frontend, sort en 0 et ne cite que lui.
    const test = `f() { [ -f a.txt ] || exit 0; [ -f b.txt ] && exit 0; if [ -n "$1" ]; then echo " ✓ src/front.test.ts (1 test)"; exit 0; fi; echo " FAIL  src/front.test.ts > charge"; echo " FAIL  src/back.test.ts > regression"; exit 1; }; f "$@"`;
    const c = h.lot('L1', {}, replaying(test));
    await runLot(c);
    expect(kinds(h).slice(0, 2)).toEqual(['implement', 'fix']);
    expect(h.calls[1].brief).toContain('src/back.test.ts > regression');
    expect(c.lot.instables).toEqual(['src/front.test.ts > charge']);
  });
  it('R4 — jest : un « Suite › test » est rejoué avec SON fichier FAIL (même déjà rouge à la ligne de base), pas excusé par le rejeu d\'un autre fichier', async () => {
    const h = harness({ script: { implement: [impl()], fix: [fix('b.txt')], review: [ok] } });
    const out = `echo 'FAIL src/a.test.ts'; echo '  ● Suite › old'; echo '  ● Suite › x'; echo 'FAIL src/b.test.ts'; echo '  ● B › flaky'; exit 1`;
    const test = `f() { case "$PWD" in *cadence-baseline*) echo 'FAIL src/a.test.ts'; echo '  ● Suite › old'; exit 1;; esac; [ -f a.txt ] || exit 0; [ -f b.txt ] && exit 0; if [ -n "$1" ]; then case "$*" in *src/a.test.ts*) echo 'FAIL src/a.test.ts'; echo '  ● Suite › x'; exit 1;; esac; echo "PASS $@"; exit 0; fi; ${out}; }; f "$@"`;
    const c = h.lot('L1', {}, replaying(test));
    await runLot(c);
    expect(kinds(h).slice(0, 2)).toEqual(['implement', 'fix']);
    expect(h.calls[1].brief).toContain('Suite › x');
    expect(c.lot.instables ?? []).toEqual([]); // le rejeu qui contient a.test.ts rougit : il ne conclut rien pour b.test.ts non plus
  });
  it('R4 — jest : la ligne « FAIL fichier (6.21 s) » ou « FAIL projet fichier » désigne bien son fichier (un fichier lent sous charge)', async () => {
    const h = harness({ script: { implement: [impl()], fix: [fix('b.txt')], review: [ok] } });
    const out = `echo 'FAIL src/a.test.ts'; echo '  ● A › flaky'; echo ' FAIL  src/b.test.ts (6.21 s)'; echo '  ● B › regression'; echo ' FAIL  backend  src/c.test.ts'; echo '  ● C › x'; exit 1`;
    const test = `f() { case "$PWD" in *cadence-baseline*) echo ' FAIL  src/b.test.ts (6.21 s)'; exit 1;; esac; [ -f a.txt ] || exit 0; [ -f b.txt ] && exit 0; if [ -n "$1" ]; then case "$*" in *src/b.test.ts*) echo 'FAIL src/b.test.ts'; echo '  ● B › regression'; exit 1;; esac; echo "PASS $@"; exit 0; fi; ${out}; }; f "$@"`; // b.test.ts est déjà rouge (et lent) au sha de départ : seule la régression « B › regression » est nouvelle
    const c = h.lot('L1', {}, replaying(test));
    await runLot(c);
    expect(kinds(h).slice(0, 2)).toEqual(['implement', 'fix']);
    expect(h.calls[1].brief).toContain('B › regression');
    expect(c.lot.instables ?? []).not.toContain('B › regression');
  });
  it('R4 — jest avec displayName : la ligne « FAIL projet fichier » est elle-même un nom rouge, rejoué avec son fichier et excusé avec ses tests quand le rejeu est vert', async () => {
    const h = harness({ script: { implement: [impl()], review: [ok] } });
    const test = `f() { [ -f a.txt ] || exit 0; if [ -n "$1" ]; then echo " ✓ src/c.test.ts (1 test)"; exit 0; fi; echo ' FAIL  backend  src/c.test.ts'; echo '  ● C › x'; exit 1; }; f "$@"`;
    const c = h.lot('L1', {}, replaying(test));
    await runLot(c);
    expect(kinds(h)).toEqual(['implement', 'review']);
    expect(c.lot.instables).toEqual(expect.arrayContaining(['C › x', 'backend  src/c.test.ts']));
  });
  it('R4 — un rejeu seul qui n\'exécute aucun test (« No test files found », code 0) ne vaut pas vert : le rouge reste compté', async () => {
    const h = harness({ script: { implement: [impl()], fix: [fix('b.txt')], review: [ok] } });
    const test = `f() { [ -f a.txt ] || exit 0; [ -f b.txt ] && exit 0; if [ -n "$1" ]; then echo 'No test files found, exiting with code 0'; exit 0; fi; echo ' FAIL  |pa|  src/a.test.js > casse'; exit 1; }; f "$@"`;
    const c = h.lot('L1', {}, replaying(test));
    await runLot(c);
    expect(kinds(h).slice(0, 2)).toEqual(['implement', 'fix']);
    expect(c.lot.instables ?? []).toEqual([]);
  });
  it('R4 — un rejeu seul vert dont la sortie cite « No test files found » hors ligne de fin (titre d\'un test lent) vaut vert : instable', async () => {
    const h = harness({ script: { implement: [impl()], review: [ok] } });
    const test = `f() { [ -f a.txt ] || exit 0; if [ -n "$1" ]; then echo ' ✓ R4 — un rejeu sans test (« No test files found », code 0) 428ms'; echo ' ✓ test/a.test.js (1 test)'; echo ' Tests  1 passed (1)'; exit 0; fi; echo ' FAIL  test/a.test.js > casse'; exit 1; }; f "$@"`;
    const c = h.lot('L1', {}, replaying(test));
    await runLot(c);
    expect(kinds(h)).toEqual(['implement', 'review']);
    expect(c.lot.instables).toEqual(['test/a.test.js > casse']);
  });
  it('R4 — un chemin à espaces ou caractères de shell est quoté pour le rejeu', () => {
    expect(shellArg('test/a.test.ts')).toBe('test/a.test.ts');
    expect(shellArg("test/a b's.test.ts")).toBe("'test/a b'\\''s.test.ts'");
  });
});

describe('L354 R5 — la porte de la vague et de l\'intégration', () => {
  it('R5 — au sommet intégré, un rouge de charge rejoué seul n\'est plus un rouge : pas de relance de toute la suite', async () => {
    const mark = join(tempDir(), 'suite-entiere');
    process.env.CHARGE_MARK = mark;
    const check = `f() { if [ -n "$1" ]; then echo " ✓ $@"; exit 0; fi; if [ -f L1.txt ] && [ -f L2.txt ]; then echo x >> "$CHARGE_MARK"; echo " FAIL  test/a.test.ts > charge"; exit 1; fi; exit 0; }; f "$@"\n`;
    const { parent } = setup([{ title: 'un' }, { title: 'deux' }], 'worktrees: true\ntest: sh check.sh\ntestReplay: sh check.sh {files}', { 'check.sh': check });
    const r = await run(parent, ['a:L1', 'a:L2', '--max-sessions', '2'], fake({ implement: writes(meeting(2)) }));
    delete process.env.CHARGE_MARK;
    expect(r.code).toBe(0);
    expect(r.out).not.toMatch(/relancés une fois/);
    expect(readFileSync(mark, 'utf8').trim().split('\n')).toHaveLength(1); // le rouge de charge a eu lieu une seule fois : la suite entière n'a pas été relancée
    expect(['L1', 'L2'].map((id) => store(parent).readLot('a', id)!.status)).toEqual(['ready', 'ready']);
  });
});

describe('L354 R1 — sans commande de rejeu déclarée, pas de rejeu et rien n\'est tenu pour instable', () => {
  it('R1 — rouge nommé sans orchestrate.testReplay : jamais rejoué, compté tel quel, la passe de correction a lieu', async () => {
    const log = join(tempDir(), 'appels.log');
    const test = `f() { echo "args:$#" >> ${log}; [ -f a.txt ] || exit 0; [ -f b.txt ] && exit 0; echo " FAIL  test/a.test.ts > charge"; exit 1; }; f "$@"`;
    const h = harness({ script: { implement: [impl()], fix: [fix('b.txt')], review: [ok] } });
    const c = h.lot('L1', {}, { test });
    await runLot(c);
    expect(kinds(h).slice(0, 2)).toEqual(['implement', 'fix']);
    expect(new Set(readFileSync(log, 'utf8').trim().split('\n'))).toEqual(new Set(['args:0']));
    expect(c.lot.instables).toBeUndefined();
    expect(c.lot.warnings.some((w) => /instable/.test(w))).toBe(false);
  });
  it('R1 — la ligne de base n\'est pas rejouée seule non plus : un rouge du sha de départ reste « déjà rouge »', async () => {
    const log = join(tempDir(), 'base.log');
    const test = `f() { case "$PWD" in *cadence-baseline*) echo "base:$#" >> ${log};; esac; echo ' FAIL  test/a.test.ts > ancien'; exit 1; }; f "$@"`;
    const h = harness({ script: { implement: [impl()], review: [ok] } });
    const c = h.lot('L1', {}, { test });
    await runLot(c);
    expect(new Set(readFileSync(log, 'utf8').trim().split('\n'))).toEqual(new Set(['base:0']));
    expect(c.lot.baseline?.failures).toEqual(['test/a.test.ts > ancien']);
    expect(c.lot.status).toBe('ready');
  });
});

describe('L354 R2 — la clé orchestrate.testReplay', () => {
  const read = (yaml: string) => {
    const f = join(tempDir(), 'cadence.yaml');
    writeFileSync(f, yaml);
    return readOrchestrateConfig(f);
  };
  it('R2 — lue telle quelle quand elle contient {files}', () => {
    expect(read('orchestrate:\n  testReplay: "npx vitest run --maxWorkers=$CADENCE_TEST_WORKERS --minWorkers=1 {files}"\n').testReplay).toBe('npx vitest run --maxWorkers=$CADENCE_TEST_WORKERS --minWorkers=1 {files}');
  });
  it('R2 — absente par défaut', () => {
    expect(read('orchestrate:\n  test: npm test\n').testReplay).toBeUndefined();
  });
  it('R2 — refusée sans {files} (une commande qui rejouerait la suite entière) ou vide', () => {
    expect(() => read('orchestrate:\n  testReplay: npx vitest run\n')).toThrow(/testReplay.*\{files\}/);
    expect(() => read('orchestrate:\n  testReplay: " "\n')).toThrow(/testReplay/);
  });
  it('R2 — refusée quand orchestrate.test est une porte composée (&&, ||, sous-shell) : le rejeu seul ne vaut que pour un lanceur unique', () => {
    for (const test of ['cd front && npx vitest run && cd ../back && npx vitest run', 'npm run front || npm run back', '(cd front; npx vitest run)', 'npx vitest run $(echo a)']) {
      expect(() => read(`orchestrate:\n  test: ${JSON.stringify(test)}\n  testReplay: "npx vitest run {files}"\n`)).toThrow(/testReplay.*porte composée/);
    }
    expect(read('orchestrate:\n  test: "npx vitest run"\n  testReplay: "npx vitest run {files}"\n').testReplay).toBe('npx vitest run {files}');
    expect(read('orchestrate:\n  test: "cd front && npx vitest run"\n').test).toBe('cd front && npx vitest run'); // sans testReplay, une porte composée reste permise
  });
});

describe('L354 R3 — un rejeu où le test n\'a pas tourné compte rouge', () => {
  it('R3 — la commande de rejeu qui échoue ou ne trouve aucun test garde le rouge compté, jamais « instable »', async () => {
    const h = harness({ script: { implement: [impl()], fix: [fix('b.txt')], review: [ok] } });
    const test = `f() { [ -f a.txt ] || exit 0; [ -f b.txt ] && exit 0; if [ -n "$1" ]; then echo 'No test files found, exiting with code 0'; exit 0; fi; echo ' FAIL  test/a.test.ts > charge'; exit 1; }; f`;
    const c = h.lot('L1', {}, replaying(test));
    await runLot(c);
    expect(kinds(h).slice(0, 2)).toEqual(['implement', 'fix']);
    expect(c.lot.instables).toBeUndefined();
  });
});

describe('L354 R4 — le relecteur reçoit les noms des instables', () => {
  it('R4 — avec un rouge de la ligne de base en plus, le contrôle du relecteur nomme encore les instables', async () => {
    const h = harness({ script: { implement: [impl()], review: [ok] } });
    const test = `f() { [ -f a.txt ] || { case "$PWD" in *cadence-baseline*) echo ' FAIL  test/a.test.ts > ancien'; exit 1;; esac; exit 0; }; if [ -n "$1" ]; then echo " ✓ $@"; exit 0; fi; echo ' FAIL  test/a.test.ts > ancien'; echo ' FAIL  test/b.test.ts > charge'; exit 1; }; f`;
    await runLot(h.lot('L1', {}, replaying(test)));
    const brief = h.calls.find((x) => x.kind === 'review')!.brief;
    expect(brief).toContain('test/b.test.ts > charge');
    expect(brief).toMatch(/already red at the start sha[^\n]*\. Also 1 test\(s\) red under load/);
  });
});

describe('L354 R4 — le fichier rejoué doit figurer dans la sortie du rejeu, pas dans l\'écho de sa commande', () => {
  it('R4 — l\'écho des arguments par npm (« npm notice run … fichiers », « > vitest run … », « $ … ») ne vaut pas exécution : la régression du backend reste rouge', async () => {
    const h = harness({ script: { implement: [impl()], fix: [fix('b.txt')], review: [ok] } });
    // Le rejeu ne joue que le frontend et sort en 0 ; npm 12 écrit sur stderr la commande avec TOUS les fichiers, le backend compris.
    const test = `f() { [ -f a.txt ] || exit 0; [ -f b.txt ] && exit 0; if [ -n "$1" ]; then echo "npm notice run node t.js $@" >&2; echo "> vitest run $@"; echo " ✓ src/front.test.ts (1 test)"; exit 0; fi; echo " FAIL  src/front.test.ts > charge"; echo " FAIL  src/back.test.ts > regression"; exit 1; }; f "$@"`;
    const c = h.lot('L1', {}, replaying(test));
    await runLot(c);
    expect(kinds(h).slice(0, 2)).toEqual(['implement', 'fix']);
    expect(h.calls[1].brief).toContain('src/back.test.ts > regression');
    expect(c.lot.instables).toEqual(['src/front.test.ts > charge']);
  });
  it('R4 — le fichier est un chemin entier d\'une ligne du lanceur : pas une fin d\'un autre chemin, pas une ligne d\'écho de npm, pnpm ou yarn', () => {
    expect(replayRanFile(' ✓ src/a.test.ts (3 tests) 12ms\n', 'src/a.test.ts')).toBe(true);
    expect(replayRanFile('PASS src/a.test.ts (6.21 s)\n', 'src/a.test.ts')).toBe(true);
    expect(replayRanFile(' ✓ |pa|  src/a.test.ts (1 test)\n', 'src/a.test.ts')).toBe(true);
    expect(replayRanFile('tests/test_a.py::test_x PASSED\n', 'tests/test_a.py')).toBe(true);
    expect(replayRanFile(' ✓ src/a.test.ts (3 tests)\n', 'a.test.ts')).toBe(false); // une fin de chemin n'est pas le fichier
    expect(replayRanFile(' ✓ src/a.test.ts.bak (3 tests)\n', 'src/a.test.ts')).toBe(false);
    expect(replayRanFile('npm notice run node t.js src/a.test.ts src/b.test.ts\n', 'src/b.test.ts')).toBe(false);
    expect(replayRanFile('> demo@1.0.0 test\n> vitest run src/a.test.ts\n', 'src/a.test.ts')).toBe(false);
    expect(replayRanFile('$ vitest run src/a.test.ts\n', 'src/a.test.ts')).toBe(false);
    expect(replayRanFile('npm warn config src/a.test.ts\nnpm ERR! src/a.test.ts\n', 'src/a.test.ts')).toBe(false);
    expect(replayRanFile('\u001b[32m ✓ \u001b[0msrc/a.test.ts\n', 'src/a.test.ts')).toBe(true);
  });
});
